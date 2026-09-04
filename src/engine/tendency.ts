/**
 * Tendency engine (spec §10) — given a team + situation, what do they do, and
 * how does that differ from their own baseline?
 *
 * Baseline = the same team, same scope, same side, with the situational
 * dimensions (down/distance/quarter/score/field) removed. So "TB on 3rd & 4-6"
 * is compared against "TB, all snaps" — the deviation is what a coach means by
 * a tendency. A league baseline can be supplied too.
 *
 * Contextual patterns (shotgun, personnel, motion) require participation +
 * charting data — those collections exist and ingest --deep pulls them, but
 * they are NOT joined here yet. We report only what the play table supports.
 * Fabricating a "shotgun %" from nothing would violate §8.
 */
import type { Play } from "../model/football.ts";
import { deterministicId } from "../store/hash.ts";
import type { NedbRow } from "../store/nedb.ts";
import { computeMetrics, confidenceFor, ppDelta, round, type Confidence, type MetricBundle } from "./metrics.ts";
import { applyFilter, describeFilter, type SituationFilter } from "./situation.ts";

export const TENDENCY_ALGORITHM = "tendency";
export const TENDENCY_VERSION = "0.1.0";

export interface TendencyDelta {
  metric: string;
  situation: number | null;
  baseline: number | null;
  /** For rates: percentage points; for epa/yards: raw difference. */
  delta: number | null;
  unit: "pp" | "epa" | "yds";
}

export interface Tendency {
  id: string;
  algorithm: string;
  algorithm_version: string;
  kind: "tendency";
  filter: SituationFilter;
  definition: string;
  baseline_definition: string;
  metrics: MetricBundle;
  baseline: MetricBundle;
  deltas: TendencyDelta[];
  /** Largest absolute pass-rate deviation phrased deterministically. */
  headline: string | null;
  confidence: Confidence;
  evidence: string[];
  evidence_hashes: string[];
  baseline_evidence_count: number;
  computed_at_seq: number;
  computed_at_head: string;
  created_at: string;
  unsupported: string[];
}

/** Strip situational dimensions to get the baseline filter. */
export function baselineFilter(f: SituationFilter): SituationFilter {
  const {
    down: _d,
    distance_min: _dmin,
    distance_max: _dmax,
    distance_bucket: _db,
    quarter: _q,
    half: _h,
    score_state: _ss,
    neutral_only: _n,
    score_diff_min: _smin,
    score_diff_max: _smax,
    field_zone: _fz,
    goal_to_go: _g,
    ...rest
  } = f;
  return rest as SituationFilter;
}

export function analyzeTendency(
  candidates: readonly NedbRow<Play>[],
  filter: SituationFilter,
  at: { seq: number; head: string },
  now = new Date().toISOString(),
): Tendency {
  const plays = candidates.map((r) => r.data);
  const hashById = new Map(candidates.map((r) => [r.data.id, r._hash] as const));
  const situ = applyFilter(plays, filter);
  const base = applyFilter(plays, baselineFilter(filter));
  const m = computeMetrics(situ);
  const b = computeMetrics(base);
  const deltas: TendencyDelta[] = [
    { metric: "pass_rate", situation: m.pass_rate, baseline: b.pass_rate, delta: ppDelta(m.pass_rate, b.pass_rate), unit: "pp" },
    { metric: "run_rate", situation: m.run_rate, baseline: b.run_rate, delta: ppDelta(m.run_rate, b.run_rate), unit: "pp" },
    { metric: "success_rate", situation: m.success_rate, baseline: b.success_rate, delta: ppDelta(m.success_rate, b.success_rate), unit: "pp" },
    { metric: "conversion_rate", situation: m.conversion_rate, baseline: b.conversion_rate, delta: ppDelta(m.conversion_rate, b.conversion_rate), unit: "pp" },
    { metric: "explosive_rate", situation: m.explosive_rate, baseline: b.explosive_rate, delta: ppDelta(m.explosive_rate, b.explosive_rate), unit: "pp" },
    {
      metric: "epa_per_play",
      situation: m.epa_per_play,
      baseline: b.epa_per_play,
      delta: m.epa_per_play === null || b.epa_per_play === null ? null : m.epa_per_play - b.epa_per_play,
      unit: "epa",
    },
    {
      metric: "yards_per_play",
      situation: m.yards_per_play,
      baseline: b.yards_per_play,
      delta: m.yards_per_play === null || b.yards_per_play === null ? null : m.yards_per_play - b.yards_per_play,
      unit: "yds",
    },
  ];
  const confidence = confidenceFor(situ.length);
  let headline: string | null = null;
  const pr = deltas[0];
  if (pr.delta !== null && confidence !== "insufficient") {
    const dir = pr.delta > 0 ? "more" : "less";
    headline = `${filter.team} throws ${Math.abs(round(pr.delta, 1)!)} pts ${dir} often here (${round((pr.situation ?? 0) * 100, 1)}%) than their overall ${round((pr.baseline ?? 0) * 100, 1)}% — over ${situ.length} snaps (${confidence} sample).`;
  } else if (confidence === "insufficient") {
    headline = `Only ${situ.length} qualifying snaps were found. That is not enough evidence for a tendency claim.`;
  }
  const evidence = situ.map((p) => p.id);
  const evidence_hashes = evidence.map((id) => hashById.get(id)!).filter(Boolean);
  return {
    id: deterministicId("tend", { algorithm: TENDENCY_ALGORITHM, version: TENDENCY_VERSION, filter, evidence_hashes }),
    algorithm: TENDENCY_ALGORITHM,
    algorithm_version: TENDENCY_VERSION,
    kind: "tendency",
    filter,
    definition: describeFilter(filter),
    baseline_definition: describeFilter(baselineFilter(filter)),
    metrics: m,
    baseline: b,
    deltas,
    headline,
    confidence,
    evidence,
    evidence_hashes,
    baseline_evidence_count: base.length,
    computed_at_seq: at.seq,
    computed_at_head: at.head,
    created_at: now,
    unsupported: [
      "formation (shotgun/under center) — requires participation join (not yet wired)",
      "personnel grouping — requires participation join (not yet wired)",
      "motion / play-action — requires charting join (not yet wired)",
      "coverage shell — not reliably available in public play-by-play",
    ],
  };
}
