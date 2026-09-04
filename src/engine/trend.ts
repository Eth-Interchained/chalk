/*
 * SPDX-License-Identifier: BUSL-1.1
 * Copyright (c) 2026 Interchained LLC. All rights reserved.
 * CHALK / Sports-Rater — https://sports-rater.com — Licensor: Interchained LLC
 */
/**
 * Trend engine (V3 §7, §25) — rating and metric movement through the season,
 * computed AS KNOWN THEN: the week-N point uses only plays from weeks <= N,
 * for the subject AND the league population it is ranked against.
 *
 * Because ratings are percentile-based, an early-season point over 30 third
 * downs is honest but noisy; each point carries its sample size and the
 * definition's `provisional` flag so the UI can draw it faded.
 *
 * "Recent form" = last K games vs the season: same metrics, deltas in pp/EPA.
 */
import type { Play } from "../model/football.ts";
import type { NedbRow } from "../store/nedb.ts";
import type { RatingDefinition } from "../rating/definitions.ts";
import { computeRating, type PopulationMember } from "../rating/rating.ts";
import { analyzeThirdDown, thirdDownFilter } from "./thirddown.ts";
import { computeMetrics, ppDelta, round, type MetricBundle } from "./metrics.ts";
import { applyFilter, type SituationFilter } from "./situation.ts";
import { deterministicId } from "../store/hash.ts";

export const TREND_ALGORITHM = "trend";
export const TREND_VERSION = "0.1.0";

export interface TrendPoint {
  week: number;
  /** Games the team had played through this week (in the ingested data). */
  games: number;
  attempts: number;
  conversion_rate: number | null;
  epa_per_play: number | null;
  success_rate: number | null;
  score: number | null;
  rank: number | null;
  population: number;
  provisional: boolean;
}

export interface Trend {
  id: string;
  algorithm: string;
  algorithm_version: string;
  kind: "trend";
  team: string;
  season: number;
  side: "offense" | "defense";
  definition_id: string;
  points: TrendPoint[];
  /** score(last) - score(first point with >= min_sample) */
  score_change: number | null;
  /** Largest single-week score move. */
  biggest_move: { week: number; delta: number } | null;
  headline: string;
  computed_at_seq: number;
  computed_at_head: string;
  created_at: string;
}

/**
 * @param leagueThirdDowns every third-down play of the season, all teams (rows)
 */
export function thirdDownTrend(
  leagueThirdDowns: readonly NedbRow<Play>[],
  team: string,
  season: number,
  def: RatingDefinition,
  at: { seq: number; head: string },
  side: "offense" | "defense" = "offense",
  now = new Date().toISOString(),
): Trend {
  const teamField = side === "offense" ? "posteam" : "defteam";
  // Weeks the TEAM actually played; a point per league week after their last
  // game would just repeat the same number (e.g. playoff weeks they missed).
  const teamWeeks = new Set(leagueThirdDowns.filter((r) => r.data[teamField] === team).map((r) => r.data.week).filter((w): w is number => w !== null));
  const lastTeamWeek = Math.max(0, ...teamWeeks);
  const weeks = [...new Set(leagueThirdDowns.map((r) => r.data.week).filter((w): w is number => w !== null))].filter((w) => w <= lastTeamWeek).sort((a, b) => a - b);
  const points: TrendPoint[] = [];
  for (const w of weeks) {
    const upto = leagueThirdDowns.filter((r) => r.data.week !== null && r.data.week <= w);
    const teams = new Set<string>();
    for (const r of upto) { const t = r.data[teamField]; if (t) teams.add(t); }
    const members: PopulationMember[] = [];
    for (const t of teams) {
      const a = analyzeThirdDown(upto, thirdDownFilter({ team: t, season, side }), at);
      if (a.metrics.attempts > 0) members.push({ key: t, metrics: a.metrics, analysis_id: a.id, attempts: a.metrics.attempts });
    }
    const subject = members.find((m) => m.key === team);
    if (!subject) continue;
    const games = new Set(upto.filter((r) => r.data[teamField] === team).map((r) => r.data.game_id)).size;
    const window = { season, description: `through week ${w}` };
    const snap = computeRating(def, subject, members, window, now);
    const scores = members.map((m) => ({ key: m.key, s: computeRating(def, m, members, window, now).score ?? -1 })).sort((x, y) => y.s - x.s);
    points.push({
      week: w,
      games,
      attempts: subject.attempts,
      conversion_rate: subject.metrics.conversion_rate,
      epa_per_play: subject.metrics.epa_per_play,
      success_rate: subject.metrics.success_rate,
      score: snap.score,
      rank: scores.findIndex((s) => s.key === team) + 1 || null,
      population: members.length,
      provisional: snap.provisional,
    });
  }
  const solid = points.filter((p) => !p.provisional && p.score !== null);
  const first = solid[0];
  const last = solid[solid.length - 1];
  const score_change = first && last && first !== last ? last.score! - first.score! : null;
  let biggest: Trend["biggest_move"] = null;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1].score, b = points[i].score;
    if (a === null || b === null) continue;
    if (!biggest || Math.abs(b - a) > Math.abs(biggest.delta)) biggest = { week: points[i].week, delta: b - a };
  }
  const headline =
    !last
      ? `Not enough third downs yet for a rating trend (${points[points.length - 1]?.attempts ?? 0} so far).`
      : score_change === null
        ? `${team}'s Third Down Rating is ${last.score}/100 through week ${last.week} (${last.attempts} third downs).`
        : `${team}'s Third Down Rating moved ${score_change >= 0 ? "+" : ""}${score_change} points from week ${first.week} (${first.score}) to week ${last.week} (${last.score}), rank ${last.rank} of ${last.population}.`;
  return {
    id: deterministicId("trend", { algorithm: TREND_ALGORITHM, version: TREND_VERSION, team, season, side, def: def.id, head: at.head, n: leagueThirdDowns.length }),
    algorithm: TREND_ALGORITHM,
    algorithm_version: TREND_VERSION,
    kind: "trend",
    team,
    season,
    side,
    definition_id: def.id,
    points,
    score_change,
    biggest_move: biggest,
    headline,
    computed_at_seq: at.seq,
    computed_at_head: at.head,
    created_at: now,
  };
}

export interface RecentForm {
  team: string;
  season: number;
  last_games: string[];
  recent: MetricBundle;
  season_metrics: MetricBundle;
  deltas: Array<{ metric: string; recent: number | null; season: number | null; delta: number | null; unit: "pp" | "epa" | "yds" }>;
  headline: string;
}

/** Last K games (by week) vs the whole season, over the team's snaps. */
export function recentForm(plays: readonly Play[], filter: SituationFilter, k = 4): RecentForm {
  const all = applyFilter(plays, filter);
  const byGame = new Map<string, number>();
  for (const p of all) if (!byGame.has(p.game_id)) byGame.set(p.game_id, p.week ?? 0);
  const games = [...byGame.entries()].sort((a, b) => b[1] - a[1]).slice(0, k).map(([g]) => g);
  const set = new Set(games);
  const recent = computeMetrics(all.filter((p) => set.has(p.game_id)));
  const season_metrics = computeMetrics(all);
  const d = (a: number | null, b: number | null) => (a === null || b === null ? null : a - b);
  const deltas: RecentForm["deltas"] = [
    { metric: "epa_per_play", recent: recent.epa_per_play, season: season_metrics.epa_per_play, delta: d(recent.epa_per_play, season_metrics.epa_per_play), unit: "epa" },
    { metric: "success_rate", recent: recent.success_rate, season: season_metrics.success_rate, delta: ppDelta(recent.success_rate, season_metrics.success_rate), unit: "pp" },
    { metric: "explosive_rate", recent: recent.explosive_rate, season: season_metrics.explosive_rate, delta: ppDelta(recent.explosive_rate, season_metrics.explosive_rate), unit: "pp" },
    { metric: "turnover_rate", recent: recent.turnover_rate, season: season_metrics.turnover_rate, delta: ppDelta(recent.turnover_rate, season_metrics.turnover_rate), unit: "pp" },
    { metric: "yards_per_play", recent: recent.yards_per_play, season: season_metrics.yards_per_play, delta: d(recent.yards_per_play, season_metrics.yards_per_play), unit: "yds" },
  ];
  const e = deltas[0];
  const headline = e.delta === null
    ? `Not enough recent snaps for a form read.`
    : `Last ${games.length} games: ${round(recent.epa_per_play, 3)} EPA/play vs ${round(season_metrics.epa_per_play, 3)} on the season (${e.delta >= 0 ? "+" : ""}${round(e.delta, 3)}), ${recent.attempts} snaps.`;
  return { team: filter.team, season: filter.season ?? 0, last_games: games, recent, season_metrics, deltas, headline };
}
