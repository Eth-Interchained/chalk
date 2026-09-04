/*
 * SPDX-License-Identifier: BUSL-1.1
 * Copyright (c) 2026 Interchained LLC. All rights reserved.
 * CHALK / Sports-Rater — https://sports-rater.com — Licensor: Interchained LLC
 */
/**
 * Deterministic football metrics. Pure functions over Play[].
 *
 * Definitions (every one is stated here so an analyst can dispute it):
 *   attempts        plays in the sample (already filtered to the situation)
 *   conversions     plays with converted === true (first_down || touchdown)
 *   conversion_rate conversions / attempts
 *   pass_rate       dropbacks / snaps  (play_type === "pass"; includes sacks
 *                   and scrambles the provider classifies as pass)
 *   run_rate        runs / snaps
 *   success_rate    plays with epa > 0 / plays with epa present
 *   epa_per_play    mean epa over plays with epa present
 *   yards_per_play  mean yards_gained over plays with yards present
 *   explosive_rate  explosive / snaps with yards present (pass>=20, run>=12)
 *   turnover_rate   turnover === true / attempts
 *   touchdown_rate  touchdown === true / attempts
 *
 * Rates are returned as fractions in [0,1] with `null` when the denominator is
 * zero — never 0, never NaN. Rounding is the presenter's job, not ours, except
 * in `round()` helpers used by the API.
 *
 * Sample-size confidence (spec §11) is a deterministic ladder on n.
 */
import type { DistanceBucket, Play } from "../model/football.ts";

export type Confidence = "insufficient" | "low" | "moderate" | "strong";

export const SAMPLE_LADDER = {
  insufficient_below: 10,
  low_below: 25,
  moderate_below: 60,
} as const;

export function confidenceFor(n: number): Confidence {
  if (n < SAMPLE_LADDER.insufficient_below) return "insufficient";
  if (n < SAMPLE_LADDER.low_below) return "low";
  if (n < SAMPLE_LADDER.moderate_below) return "moderate";
  return "strong";
}

export interface MetricBundle {
  attempts: number;
  conversions: number;
  conversion_rate: number | null;
  snaps: number;
  dropbacks: number;
  runs: number;
  pass_rate: number | null;
  run_rate: number | null;
  epa_n: number;
  epa_total: number | null;
  epa_per_play: number | null;
  success_n: number;
  successes: number;
  success_rate: number | null;
  yards_n: number;
  yards_total: number | null;
  yards_per_play: number | null;
  explosive_n: number;
  explosives: number;
  explosive_rate: number | null;
  turnovers: number;
  turnover_rate: number | null;
  touchdowns: number;
  touchdown_rate: number | null;
  confidence: Confidence;
}

const ratio = (num: number, den: number): number | null => (den > 0 ? num / den : null);

export function computeMetrics(plays: readonly Play[]): MetricBundle {
  let conversions = 0;
  let dropbacks = 0;
  let runs = 0;
  let snaps = 0;
  let epa_n = 0;
  let epa_total = 0;
  let success_n = 0;
  let successes = 0;
  let yards_n = 0;
  let yards_total = 0;
  let explosive_n = 0;
  let explosives = 0;
  let turnovers = 0;
  let touchdowns = 0;

  for (const p of plays) {
    if (p.converted === true) conversions++;
    if (p.is_snap) {
      snaps++;
      if (p.is_dropback) dropbacks++;
      else runs++;
    }
    if (p.epa !== null) {
      epa_n++;
      epa_total += p.epa;
      success_n++;
      if (p.epa > 0) successes++;
    }
    if (p.yards_gained !== null) {
      yards_n++;
      yards_total += p.yards_gained;
    }
    if (p.explosive !== null) {
      explosive_n++;
      if (p.explosive) explosives++;
    }
    if (p.turnover === true) turnovers++;
    if (p.touchdown === true) touchdowns++;
  }
  const attempts = plays.length;
  return {
    attempts,
    conversions,
    conversion_rate: ratio(conversions, attempts),
    snaps,
    dropbacks,
    runs,
    pass_rate: ratio(dropbacks, snaps),
    run_rate: ratio(runs, snaps),
    epa_n,
    epa_total: epa_n ? epa_total : null,
    epa_per_play: ratio(epa_total, epa_n),
    success_n,
    successes,
    success_rate: ratio(successes, success_n),
    yards_n,
    yards_total: yards_n ? yards_total : null,
    yards_per_play: ratio(yards_total, yards_n),
    explosive_n,
    explosives,
    explosive_rate: ratio(explosives, explosive_n),
    turnovers,
    turnover_rate: ratio(turnovers, attempts),
    touchdowns,
    touchdown_rate: ratio(touchdowns, attempts),
    confidence: confidenceFor(attempts),
  };
}

export const DISTANCE_BUCKETS: readonly DistanceBucket[] = ["short", "medium", "long", "very_long"];
export const DISTANCE_BUCKET_RANGES: Record<DistanceBucket, { min: number; max: number | null; label: string }> = {
  short: { min: 1, max: 3, label: "1-3" },
  medium: { min: 4, max: 6, label: "4-6" },
  long: { min: 7, max: 10, label: "7-10" },
  very_long: { min: 11, max: null, label: "11+" },
};

export function groupByDistanceBucket(plays: readonly Play[]): Record<DistanceBucket, Play[]> {
  const out: Record<DistanceBucket, Play[]> = { short: [], medium: [], long: [], very_long: [] };
  for (const p of plays) if (p.distance_bucket) out[p.distance_bucket].push(p);
  return out;
}

export function groupBy<K extends string | number>(plays: readonly Play[], key: (p: Play) => K | null): Map<K, Play[]> {
  const m = new Map<K, Play[]>();
  for (const p of plays) {
    const k = key(p);
    if (k === null) continue;
    const arr = m.get(k);
    if (arr) arr.push(p);
    else m.set(k, [p]);
  }
  return m;
}

/** Mean of a metric across plays, null when nothing present. */
export function mean(values: readonly (number | null)[]): number | null {
  let n = 0;
  let t = 0;
  for (const v of values) if (v !== null) { n++; t += v; }
  return n ? t / n : null;
}

/** Round for presentation; null-safe. */
export function round(v: number | null, digits = 3): number | null {
  if (v === null) return null;
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

/** Percentage points from two fractions, null-safe. */
export function ppDelta(a: number | null, b: number | null): number | null {
  return a === null || b === null ? null : (a - b) * 100;
}
