/*
 * SPDX-License-Identifier: BUSL-1.1
 * Copyright (c) 2026 Interchained LLC. All rights reserved.
 * CHALK / Sports-Rater — https://sports-rater.com — Licensor: Interchained LLC
 */
/**
 * Comparison engine (spec §12) — two filters, one deterministic A/B.
 *
 * The caller supplies two SituationFilters (they may differ in team, season,
 * half, home/away, score state, weeks — anything). Both are applied to the
 * union of their candidate populations and the metric bundles are diffed.
 * The model receives the structured A/B; it never computes the delta.
 */
import type { Play } from "../model/football.ts";
import { deterministicId } from "../store/hash.ts";
import type { NedbRow } from "../store/nedb.ts";
import { computeMetrics, confidenceFor, ppDelta, type Confidence, type MetricBundle } from "./metrics.ts";
import { applyFilter, describeFilter, type SituationFilter } from "./situation.ts";

export const COMPARISON_ALGORITHM = "comparison";
export const COMPARISON_VERSION = "0.1.0";

export interface ComparisonLine {
  metric: string;
  a: number | null;
  b: number | null;
  delta: number | null;
  unit: "pp" | "epa" | "yds" | "n";
  /** Positive delta favors b for higher-is-better metrics; the sign is left raw, direction noted. */
  higher_is_better: boolean;
}

export interface Comparison {
  id: string;
  algorithm: string;
  algorithm_version: string;
  kind: "comparison";
  a: { filter: SituationFilter; definition: string; metrics: MetricBundle; evidence: string[]; confidence: Confidence };
  b: { filter: SituationFilter; definition: string; metrics: MetricBundle; evidence: string[]; confidence: Confidence };
  lines: ComparisonLine[];
  /** Metric with the largest |delta| in pp terms among rates, or null. */
  biggest_gap: string | null;
  computed_at_seq: number;
  computed_at_head: string;
  created_at: string;
}

export function compare(
  candidates: readonly NedbRow<Play>[],
  fa: SituationFilter,
  fb: SituationFilter,
  at: { seq: number; head: string },
  now = new Date().toISOString(),
): Comparison {
  const plays = candidates.map((r) => r.data);
  const pa = applyFilter(plays, fa);
  const pb = applyFilter(plays, fb);
  const ma = computeMetrics(pa);
  const mb = computeMetrics(pb);
  const diff = (x: number | null, y: number | null) => (x === null || y === null ? null : y - x);
  const lines: ComparisonLine[] = [
    { metric: "attempts", a: ma.attempts, b: mb.attempts, delta: mb.attempts - ma.attempts, unit: "n", higher_is_better: true },
    { metric: "conversion_rate", a: ma.conversion_rate, b: mb.conversion_rate, delta: ppDelta(mb.conversion_rate, ma.conversion_rate), unit: "pp", higher_is_better: true },
    { metric: "success_rate", a: ma.success_rate, b: mb.success_rate, delta: ppDelta(mb.success_rate, ma.success_rate), unit: "pp", higher_is_better: true },
    { metric: "pass_rate", a: ma.pass_rate, b: mb.pass_rate, delta: ppDelta(mb.pass_rate, ma.pass_rate), unit: "pp", higher_is_better: true },
    { metric: "explosive_rate", a: ma.explosive_rate, b: mb.explosive_rate, delta: ppDelta(mb.explosive_rate, ma.explosive_rate), unit: "pp", higher_is_better: true },
    { metric: "turnover_rate", a: ma.turnover_rate, b: mb.turnover_rate, delta: ppDelta(mb.turnover_rate, ma.turnover_rate), unit: "pp", higher_is_better: false },
    { metric: "epa_per_play", a: ma.epa_per_play, b: mb.epa_per_play, delta: diff(ma.epa_per_play, mb.epa_per_play), unit: "epa", higher_is_better: true },
    { metric: "yards_per_play", a: ma.yards_per_play, b: mb.yards_per_play, delta: diff(ma.yards_per_play, mb.yards_per_play), unit: "yds", higher_is_better: true },
  ];
  const rateLines = lines.filter((l) => l.unit === "pp" && l.delta !== null);
  const biggest = rateLines.length ? rateLines.reduce((m, l) => (Math.abs(l.delta!) > Math.abs(m.delta!) ? l : m)).metric : null;
  const ea = pa.map((p) => p.id);
  const eb = pb.map((p) => p.id);
  return {
    id: deterministicId("cmp", { algorithm: COMPARISON_ALGORITHM, version: COMPARISON_VERSION, fa, fb, ea, eb }),
    algorithm: COMPARISON_ALGORITHM,
    algorithm_version: COMPARISON_VERSION,
    kind: "comparison",
    a: { filter: fa, definition: describeFilter(fa), metrics: ma, evidence: ea, confidence: confidenceFor(pa.length) },
    b: { filter: fb, definition: describeFilter(fb), metrics: mb, evidence: eb, confidence: confidenceFor(pb.length) },
    lines,
    biggest_gap: biggest,
    computed_at_seq: at.seq,
    computed_at_head: at.head,
    created_at: now,
  };
}
