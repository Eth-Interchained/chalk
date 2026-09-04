/*
 * SPDX-License-Identifier: BUSL-1.1
 * Copyright (c) 2026 Interchained LLC. All rights reserved.
 * CHALK / Sports-Rater — https://sports-rater.com — Licensor: Interchained LLC
 */
/**
 * Opponent report (V2 §19 / V3 §36) — "what should I know about this week's
 * opponent?" Composes engines that already exist: tendencies in the core
 * situations, the situation scan (their weak/strong spots), third-down
 * analysis + context patterns, all facts first. The model narrates after.
 */
import type { PlayContext } from "../ingest/context.ts";
import type { Play } from "../model/football.ts";
import type { NedbRow } from "../store/nedb.ts";
import { deterministicId } from "../store/hash.ts";
import { contextPatterns, patternStatements, summarizePatterns, type ContextPatterns } from "./context.ts";
import { computeMetrics, round, type MetricBundle } from "./metrics.ts";
import { scanSituations, type ScanBucket } from "./scan.ts";
import { applyFilter, describeFilter, type SituationFilter } from "./situation.ts";
import { analyzeTendency, type Tendency } from "./tendency.ts";

export const OPPONENT_ALGORITHM = "opponent-report";
export const OPPONENT_VERSION = "0.1.0";

export interface OpponentSection {
  key: string;
  label: string;
  filter: SituationFilter;
  metrics: MetricBundle;
  tendency: Tendency;
  patterns: ContextPatterns | null;
  statements: string[];
}

export interface OpponentReport {
  id: string;
  algorithm: string;
  algorithm_version: string;
  kind: "opponent_report";
  team: string;
  opponent: string;
  season: number;
  side: "offense" | "defense";
  baseline: MetricBundle;
  baseline_patterns: ContextPatterns | null;
  sections: OpponentSection[];
  weakest: ScanBucket[];
  strongest: ScanBucket[];
  statements: string[];
  evidence: string[];
  computed_at_seq: number;
  computed_at_head: string;
  created_at: string;
}

const SECTIONS: Array<{ key: string; label: string; overlay: Partial<SituationFilter> }> = [
  { key: "early_downs", label: "Early downs (1st & 2nd)", overlay: { down: [1, 2] } },
  { key: "third_medium", label: "3rd & 4-6", overlay: { down: [3], distance_min: 4, distance_max: 6 } },
  { key: "third_long", label: "3rd & 7+", overlay: { down: [3], distance_min: 7 } },
  { key: "short_yardage", label: "Short yardage (2-4 & 1-3)", overlay: { down: [2, 3, 4], distance_max: 3 } },
  { key: "red_zone", label: "Red zone", overlay: { field_zone: ["red_zone"] } },
  { key: "trailing", label: "When trailing", overlay: { score_state: ["trailing"] } },
];

/**
 * @param opponentPlays all plays where the opponent is on the `side` in question, for the season
 * @param ctx play context rows for those plays (may be empty)
 */
export function opponentReport(
  team: string,
  opponentPlays: readonly NedbRow<Play>[],
  base: SituationFilter,
  ctx: ReadonlyMap<string, PlayContext>,
  at: { seq: number; head: string },
  now = new Date().toISOString(),
): OpponentReport {
  const plays = opponentPlays.map((r) => r.data);
  const basePlays = applyFilter(plays, base);
  const baseline = computeMetrics(basePlays);
  const baseline_patterns = ctx.size ? contextPatterns(basePlays, ctx) : null;
  // Framing: for side=offense the subject is the opponent's offense. For
  // side=defense the plays are OFFENSES FACING the opponent — pass rate and
  // formation describe what those offenses did, EPA is what the defense
  // ALLOWED. The sentences must say so or the model will misattribute them.
  const def = base.side === "defense";
  const subject = def ? `Offenses facing ${base.team}` : `${base.team} offense`;
  const epaWord = def ? "EPA/play allowed" : "EPA/play";
  const sections: OpponentSection[] = SECTIONS.map((s) => {
    const filter: SituationFilter = { ...base, ...s.overlay };
    const t = analyzeTendency(opponentPlays, filter, at, now);
    const ps = applyFilter(plays, filter);
    const patterns = ctx.size ? contextPatterns(ps, ctx) : null;
    const statements: string[] = [];
    const m = t.metrics;
    const pct = (v: number | null) => (v === null ? "n/a" : `${round(v * 100, 1)}%`);
    if (m.attempts >= 20) {
      statements.push(
        def
          ? `${s.label} vs ${base.team}: offenses pass ${pct(m.pass_rate)} over ${m.attempts} snaps (${pct(t.baseline.pass_rate)} overall), ${base.team} allows ${round(m.epa_per_play, 3)} EPA/play and ${pct(m.success_rate)} success${s.overlay.down?.includes(3) ? `, ${pct(m.conversion_rate)} conversions` : ""}.`
          : `${s.label}: ${pct(m.pass_rate)} pass over ${m.attempts} snaps (baseline ${pct(t.baseline.pass_rate)}), ${round(m.epa_per_play, 3)} EPA/play, ${pct(m.success_rate)} success${s.overlay.down?.includes(3) ? `, ${pct(m.conversion_rate)} conversions` : ""}.`,
      );
      if (patterns) statements.push(...patternStatements(subject, s.label, patterns, baseline_patterns ?? undefined).slice(0, 2));
    } else {
      statements.push(`${s.label}: only ${m.attempts} snaps — too few for a tendency.`);
    }
    return { key: s.key, label: s.label, filter, metrics: m, tendency: t, patterns, statements };
  });
  const scan = scanSituations(opponentPlays, base, at, undefined, now);
  const weakWord = def ? "Where their defense gives up the most" : "Their weakest qualifying situation";
  const strongWord = def ? "Where their defense is toughest" : "Their strongest";
  // For a defense, "weakest" for THEM is the highest EPA allowed — flip the scan order.
  const weakList = def ? scan.strongest : scan.weakest;
  const strongList = def ? scan.weakest : scan.strongest;
  const statements: string[] = [
    def
      ? `${base.team} defense, ${base.season} season: ${baseline.attempts} snaps faced, allowing ${round(baseline.epa_per_play, 3)} EPA/play and ${round((baseline.success_rate ?? 0) * 100, 1)}% success; offenses pass ${round((baseline.pass_rate ?? 0) * 100, 1)}% against them.`
      : `${base.team} offense, ${base.season} season: ${baseline.attempts} snaps, ${round(baseline.epa_per_play, 3)} EPA/play, ${round((baseline.pass_rate ?? 0) * 100, 1)}% pass.`,
    ...(baseline_patterns ? patternStatements(subject, "overall", baseline_patterns).slice(0, 3) : ["Formation/personnel context not ingested for this opponent (run chalk ingest --context-only)."]),
    ...sections.flatMap((s) => s.statements.slice(0, 1)),
    ...(weakList[0] ? [`${weakWord}: ${weakList[0].label} (${round(weakList[0].metrics.epa_per_play, 3)} ${epaWord}, ${weakList[0].metrics.attempts} snaps).`] : []),
    ...(strongList[0] ? [`${strongWord}: ${strongList[0].label} (${round(strongList[0].metrics.epa_per_play, 3)} ${epaWord}, ${strongList[0].metrics.attempts} snaps).`] : []),
  ];
  const evidence = basePlays.map((p) => p.id);
  return {
    id: deterministicId("opp", { algorithm: OPPONENT_ALGORITHM, version: OPPONENT_VERSION, team, base, head: at.head, n: basePlays.length, ctx: ctx.size }),
    algorithm: OPPONENT_ALGORITHM,
    algorithm_version: OPPONENT_VERSION,
    kind: "opponent_report",
    team,
    opponent: base.team,
    season: base.season ?? 0,
    side: base.side,
    baseline,
    baseline_patterns,
    sections,
    // Always "weakest/strongest FOR THE OPPONENT": for a defense that means
    // most/least EPA allowed, so the scan order is flipped.
    weakest: weakList.slice(0, 5),
    strongest: strongList.slice(0, 3),
    statements,
    evidence,
    computed_at_seq: at.seq,
    computed_at_head: at.head,
    created_at: now,
  };
}

export function summarizeOpponentReport(r: OpponentReport) {
  const pct = (v: number | null) => (v === null ? null : round(v * 100, 1));
  return {
    team: r.team,
    opponent: r.opponent,
    season: r.season,
    opponent_side: r.side,
    definition: describeFilter({ team: r.opponent, side: r.side, season: r.season, snaps_only: true, exclude_kneels: true, exclude_spikes: true, exclude_no_play: true, exclude_penalties: false, exclude_garbage_time: false }),
    baseline: { snaps: r.baseline.attempts, pass_pct: pct(r.baseline.pass_rate), epa_per_play: round(r.baseline.epa_per_play, 3), success_pct: pct(r.baseline.success_rate), explosive_pct: pct(r.baseline.explosive_rate) },
    baseline_patterns: r.baseline_patterns ? summarizePatterns(r.baseline_patterns) : null,
    sections: r.sections.map((s) => ({
      situation: s.label,
      snaps: s.metrics.attempts,
      pass_pct: pct(s.metrics.pass_rate),
      pass_pct_vs_baseline_pp: round(s.tendency.deltas[0].delta, 1),
      epa_per_play: round(s.metrics.epa_per_play, 3),
      success_pct: pct(s.metrics.success_rate),
      conversion_pct: s.filter.down?.includes(3) ? pct(s.metrics.conversion_rate) : undefined,
      confidence: s.tendency.confidence,
      patterns: s.patterns ? summarizePatterns(s.patterns) : null,
    })),
    weakest: r.weakest.map((b) => ({ situation: b.label, snaps: b.metrics.attempts, epa_per_play: round(b.metrics.epa_per_play, 3), epa_vs_team: round(b.epa_delta_vs_team, 3) })),
    strongest: r.strongest.map((b) => ({ situation: b.label, snaps: b.metrics.attempts, epa_per_play: round(b.metrics.epa_per_play, 3), epa_vs_team: round(b.epa_delta_vs_team, 3) })),
  };
}
