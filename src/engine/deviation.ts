/*
 * SPDX-License-Identifier: BUSL-1.1
 * Copyright (c) 2026 Interchained LLC. All rights reserved.
 * CHALK / Sports-Rater — https://sports-rater.com — Licensor: Interchained LLC
 */
/**
 * Deviation engine (V3 §19H, §20) — season baseline vs the current game.
 *
 * Given a team's season plays and one game's plays, compute the same metric
 * bundle for both and score how far the game sits from the baseline. The
 * score is deterministic and explained by its parts:
 *
 *   For each rate metric r with baseline p over n_base plays and game value g
 *   over n_game plays, the standardized gap is
 *       z_r = (g - p) / sqrt(p (1 - p) / n_game)         (binomial SE at baseline)
 *   For epa_per_play the SE is the baseline sample standard deviation / sqrt(n_game).
 *   deviation_score = max |z| over metrics with n_game >= MIN_GAME_SAMPLE.
 *   level: LOW < 1.0, MODERATE < 2.0, HIGH >= 2.0  — "HIGH" means roughly a
 *   1-in-20 event if the game were drawn from the season distribution.
 *
 * This is a signal for "what changed?", not a p-value the model may inflate;
 * the prompt receives the level, the driving metric, both values, and n.
 */
import type { Play } from "../model/football.ts";
import { deterministicId } from "../store/hash.ts";
import type { NedbRow } from "../store/nedb.ts";
import { computeMetrics, type MetricBundle } from "./metrics.ts";
import { applyFilter, describeFilter, type SituationFilter } from "./situation.ts";

export const DEVIATION_ALGORITHM = "deviation";
export const DEVIATION_VERSION = "0.1.0";
export const MIN_GAME_SAMPLE = 6;

export type DeviationLevel = "insufficient" | "LOW" | "MODERATE" | "HIGH";

export interface DeviationLine {
  metric: string;
  baseline: number | null;
  game: number | null;
  delta: number | null;
  z: number | null;
  n_game: number;
  n_baseline: number;
}

export interface Deviation {
  id: string;
  algorithm: string;
  algorithm_version: string;
  kind: "deviation";
  filter: SituationFilter;
  definition: string;
  game_id: string;
  baseline: MetricBundle;
  game: MetricBundle;
  lines: DeviationLine[];
  driver: string | null;
  score: number | null;
  level: DeviationLevel;
  headline: string;
  evidence: string[];
  evidence_hashes: string[];
  computed_at_seq: number;
  computed_at_head: string;
  created_at: string;
}

function sd(values: number[]): number | null {
  if (values.length < 2) return null;
  const m = values.reduce((a, b) => a + b, 0) / values.length;
  const v = values.reduce((a, b) => a + (b - m) ** 2, 0) / (values.length - 1);
  return Math.sqrt(v);
}

export function analyzeDeviation(
  candidates: readonly NedbRow<Play>[],
  filter: SituationFilter,
  gameId: string,
  at: { seq: number; head: string },
  now = new Date().toISOString(),
): Deviation {
  const plays = candidates.map((r) => r.data);
  const hashById = new Map(candidates.map((r) => [r.data.id, r._hash] as const));
  const seasonFilter: SituationFilter = { ...filter, game_id: undefined, game_ids: undefined };
  const all = applyFilter(plays, seasonFilter);
  const base = all.filter((p) => p.game_id !== gameId);
  const game = all.filter((p) => p.game_id === gameId);
  const mb = computeMetrics(base);
  const mg = computeMetrics(game);
  const lines: DeviationLine[] = [];
  const rate = (metric: keyof MetricBundle, nGame: number, nBase: number) => {
    const p = mb[metric] as number | null;
    const g = mg[metric] as number | null;
    let z: number | null = null;
    if (p !== null && g !== null && nGame >= MIN_GAME_SAMPLE && p > 0 && p < 1) z = (g - p) / Math.sqrt((p * (1 - p)) / nGame);
    lines.push({ metric, baseline: p, game: g, delta: p === null || g === null ? null : g - p, z, n_game: nGame, n_baseline: nBase });
  };
  rate("pass_rate", mg.snaps, mb.snaps);
  rate("success_rate", mg.success_n, mb.success_n);
  rate("conversion_rate", mg.attempts, mb.attempts);
  rate("explosive_rate", mg.explosive_n, mb.explosive_n);
  rate("turnover_rate", mg.attempts, mb.attempts);
  {
    const s = sd(base.map((p) => p.epa).filter((v): v is number => v !== null));
    const p = mb.epa_per_play;
    const g = mg.epa_per_play;
    const z = p !== null && g !== null && s !== null && s > 0 && mg.epa_n >= MIN_GAME_SAMPLE ? (g - p) / (s / Math.sqrt(mg.epa_n)) : null;
    lines.push({ metric: "epa_per_play", baseline: p, game: g, delta: p === null || g === null ? null : g - p, z, n_game: mg.epa_n, n_baseline: mb.epa_n });
  }
  const scored = lines.filter((l) => l.z !== null);
  const driverLine = scored.length ? scored.reduce((m, l) => (Math.abs(l.z!) > Math.abs(m.z!) ? l : m)) : null;
  const score = driverLine ? Math.abs(driverLine.z!) : null;
  const level: DeviationLevel = score === null ? "insufficient" : score < 1 ? "LOW" : score < 2 ? "MODERATE" : "HIGH";
  const fmt = (m: string, v: number | null) => (v === null ? "n/a" : m === "epa_per_play" ? v.toFixed(2) : `${(v * 100).toFixed(1)}%`);
  const headline =
    level === "insufficient"
      ? `Only ${mg.attempts} qualifying snaps in ${gameId} so far — not enough to call a deviation.`
      : `CURRENT GAME DEVIATION: ${level}. ${filter.team}'s ${driverLine!.metric.replace(/_/g, " ")} is ${fmt(driverLine!.metric, driverLine!.game)} in this game vs ${fmt(driverLine!.metric, driverLine!.baseline)} across the rest of the season (${driverLine!.n_game} snaps, z=${driverLine!.z!.toFixed(2)}).`;
  const evidence = game.map((p) => p.id);
  const evidence_hashes = evidence.map((id) => hashById.get(id)!).filter(Boolean);
  return {
    id: deterministicId("dev", { algorithm: DEVIATION_ALGORITHM, version: DEVIATION_VERSION, filter, gameId, evidence_hashes, nb: base.length }),
    algorithm: DEVIATION_ALGORITHM,
    algorithm_version: DEVIATION_VERSION,
    kind: "deviation",
    filter,
    definition: describeFilter(seasonFilter),
    game_id: gameId,
    baseline: mb,
    game: mg,
    lines,
    driver: driverLine?.metric ?? null,
    score,
    level,
    headline,
    evidence,
    evidence_hashes,
    computed_at_seq: at.seq,
    computed_at_head: at.head,
    created_at: now,
  };
}
