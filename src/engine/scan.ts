/*
 * SPDX-License-Identifier: BUSL-1.1
 * Copyright (c) 2026 Interchained LLC. All rights reserved.
 * CHALK / Sports-Rater — https://sports-rater.com — Licensor: Interchained LLC
 */
/**
 * Situation scan (spec §35) — "what situations are hurting this team the most?"
 *
 * The LLM does NOT invent situations. We enumerate a fixed, documented set of
 * situational buckets, compute each against the team's plays, require a
 * minimum sample, and rank by EPA/play shortfall versus the team's own
 * baseline (and, when a league population is supplied, versus league).
 *
 * Buckets (each a partial SituationFilter overlay):
 *   by down            1st / 2nd / 3rd / 4th
 *   by distance        short / medium / long / very_long (downs 2-4)
 *   third-and-long     down 3, 7+
 *   by quarter         Q1..Q4
 *   by half            1 / 2
 *   by score state     leading / trailing / tied
 *   one-score          neutral_only
 *   red zone           field_zone red_zone
 *   goal-to-go
 *   own territory      field_zone own
 *   home / away
 *   divisional / non-divisional
 *   pass snaps / run snaps
 */
import type { Play } from "../model/football.ts";
import { deterministicId } from "../store/hash.ts";
import type { NedbRow } from "../store/nedb.ts";
import { computeMetrics, confidenceFor, type Confidence, type MetricBundle } from "./metrics.ts";
import { applyFilter, describeFilter, type SituationFilter } from "./situation.ts";

export const SCAN_ALGORITHM = "situation-scan";
export const SCAN_VERSION = "0.1.0";
export const SCAN_MIN_SAMPLE = 20;

export interface BucketSpec {
  key: string;
  label: string;
  overlay: Partial<SituationFilter>;
}

export const SCAN_BUCKETS: BucketSpec[] = [
  { key: "down_1", label: "1st down", overlay: { down: [1] } },
  { key: "down_2", label: "2nd down", overlay: { down: [2] } },
  { key: "down_3", label: "3rd down", overlay: { down: [3] } },
  { key: "down_4", label: "4th down", overlay: { down: [4] } },
  { key: "short", label: "Short yardage (1-3, downs 2-4)", overlay: { down: [2, 3, 4], distance_bucket: ["short"] } },
  { key: "medium", label: "Medium (4-6, downs 2-4)", overlay: { down: [2, 3, 4], distance_bucket: ["medium"] } },
  { key: "long", label: "Long (7-10, downs 2-4)", overlay: { down: [2, 3, 4], distance_bucket: ["long"] } },
  { key: "very_long", label: "Very long (11+, downs 2-4)", overlay: { down: [2, 3, 4], distance_bucket: ["very_long"] } },
  { key: "third_and_long", label: "3rd & 7+", overlay: { down: [3], distance_min: 7 } },
  { key: "third_and_short", label: "3rd & 1-3", overlay: { down: [3], distance_max: 3 } },
  { key: "q1", label: "1st quarter", overlay: { quarter: [1] } },
  { key: "q2", label: "2nd quarter", overlay: { quarter: [2] } },
  { key: "q3", label: "3rd quarter", overlay: { quarter: [3] } },
  { key: "q4", label: "4th quarter", overlay: { quarter: [4] } },
  { key: "half_1", label: "1st half", overlay: { half: [1] } },
  { key: "half_2", label: "2nd half", overlay: { half: [2] } },
  { key: "leading", label: "When leading", overlay: { score_state: ["leading"] } },
  { key: "trailing", label: "When trailing", overlay: { score_state: ["trailing"] } },
  { key: "tied", label: "When tied", overlay: { score_state: ["tied"] } },
  { key: "one_score", label: "One-score game", overlay: { neutral_only: true } },
  { key: "red_zone", label: "Red zone", overlay: { field_zone: ["red_zone"] } },
  { key: "goal_to_go", label: "Goal-to-go", overlay: { goal_to_go: true } },
  { key: "own_territory", label: "Own territory (backed up)", overlay: { field_zone: ["own"] } },
  { key: "opp_territory", label: "Opponent territory (21-50)", overlay: { field_zone: ["opp"] } },
  { key: "home", label: "Home", overlay: { home: true } },
  { key: "away", label: "Away", overlay: { home: false } },
  { key: "divisional", label: "Divisional games", overlay: { divisional: true } },
  { key: "non_divisional", label: "Non-divisional games", overlay: { divisional: false } },
  { key: "pass_snaps", label: "Pass snaps", overlay: { play_types: ["pass"] } },
  { key: "run_snaps", label: "Run snaps", overlay: { play_types: ["run"] } },
];

export interface ScanBucket {
  key: string;
  label: string;
  filter: SituationFilter;
  definition: string;
  metrics: MetricBundle;
  confidence: Confidence;
  qualifies: boolean;
  /** epa_per_play - team baseline epa_per_play */
  epa_delta_vs_team: number | null;
  /** success_rate - team baseline, in pp */
  success_pp_vs_team: number | null;
  /** epa_per_play - league bucket epa_per_play, when a league population was supplied */
  epa_delta_vs_league: number | null;
  league_n: number | null;
  evidence: string[];
}

export interface SituationScan {
  id: string;
  algorithm: string;
  algorithm_version: string;
  kind: "situation_scan";
  base_filter: SituationFilter;
  baseline: MetricBundle;
  buckets: ScanBucket[];
  /** Qualifying buckets sorted worst-first by epa_delta_vs_team. */
  weakest: ScanBucket[];
  strongest: ScanBucket[];
  min_sample: number;
  computed_at_seq: number;
  computed_at_head: string;
  created_at: string;
}

export function scanSituations(
  candidates: readonly NedbRow<Play>[],
  base: SituationFilter,
  at: { seq: number; head: string },
  league?: readonly NedbRow<Play>[],
  now = new Date().toISOString(),
): SituationScan {
  const plays = candidates.map((r) => r.data);
  const basePlays = applyFilter(plays, base);
  const baseline = computeMetrics(basePlays);
  const leaguePlays = league?.map((r) => r.data);
  const buckets: ScanBucket[] = SCAN_BUCKETS.map((spec) => {
    const filter: SituationFilter = { ...base, ...spec.overlay };
    const ps = applyFilter(basePlays, filter);
    const m = computeMetrics(ps);
    let epa_delta_vs_league: number | null = null;
    let league_n: number | null = null;
    if (leaguePlays) {
      // League bucket = same overlay, any team, same side. Team field is
      // irrelevant to the overlay dimensions, so strip team by applying the
      // overlay-only predicate per team is unnecessary: we evaluate the
      // overlay against every league play by setting team to each play's own.
      const lm = computeMetrics(
        leaguePlays.filter((p) => {
          const teamOf = base.side === "offense" ? p.posteam : p.defteam;
          if (!teamOf) return false;
          return applyFilter([p], { ...filter, team: teamOf, game_id: undefined, game_ids: undefined, opponent: undefined }).length === 1;
        }),
      );
      league_n = lm.attempts;
      epa_delta_vs_league = m.epa_per_play === null || lm.epa_per_play === null ? null : m.epa_per_play - lm.epa_per_play;
    }
    return {
      key: spec.key,
      label: spec.label,
      filter,
      definition: describeFilter(filter),
      metrics: m,
      confidence: confidenceFor(ps.length),
      qualifies: ps.length >= SCAN_MIN_SAMPLE,
      epa_delta_vs_team: m.epa_per_play === null || baseline.epa_per_play === null ? null : m.epa_per_play - baseline.epa_per_play,
      success_pp_vs_team: m.success_rate === null || baseline.success_rate === null ? null : (m.success_rate - baseline.success_rate) * 100,
      epa_delta_vs_league,
      league_n,
      evidence: ps.map((p) => p.id),
    };
  });
  const qualifying = buckets.filter((b) => b.qualifies && b.epa_delta_vs_team !== null);
  const weakest = [...qualifying].sort((x, y) => x.epa_delta_vs_team! - y.epa_delta_vs_team!);
  const strongest = [...weakest].reverse();
  return {
    id: deterministicId("scan", { algorithm: SCAN_ALGORITHM, version: SCAN_VERSION, base, n: basePlays.length, head: at.head }),
    algorithm: SCAN_ALGORITHM,
    algorithm_version: SCAN_VERSION,
    kind: "situation_scan",
    base_filter: base,
    baseline,
    buckets,
    weakest,
    strongest,
    min_sample: SCAN_MIN_SAMPLE,
    computed_at_seq: at.seq,
    computed_at_head: at.head,
    created_at: now,
  };
}
