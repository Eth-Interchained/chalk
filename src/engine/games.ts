/*
 * SPDX-License-Identifier: BUSL-1.1
 * Copyright (c) 2026 Interchained LLC. All rights reserved.
 * CHALK / Sports-Rater — https://sports-rater.com — Licensor: Interchained LLC
 */
/**
 * Game ranking — a team's season, game by game, ranked deterministically.
 *
 * Fills the gap Mark hit on 2026-09-04: "which game was their best game" was
 * routed to a situation scan because no intent knew games. GLM correctly said
 * the evidence held no games. This is the tool it was missing.
 *
 * One GameLine per game the team played (with a result): offense metrics over
 * the team's snaps, defense EPA allowed over the opponent's snaps, score and
 * margin from the game record. Ranking metric is explicit and versioned:
 *   epa       offense EPA/play (default — "how well did they play")
 *   margin    points margin ("biggest win / worst loss")
 *   success   offense success rate
 *   defense   EPA allowed per play, lower is better ("best defensive game")
 * Ties break on margin, then week. Evidence for the best game = its offensive
 * snap ids, so TRACE from the answer lands on the plays.
 */
import { computeMetrics, round } from "./metrics.ts";
import type { Game, Play } from "../model/football.ts";
import { deterministicId } from "../store/hash.ts";

export const GAME_RANK_VERSION = "1.0.0";
export const GAME_RANK_METRICS = ["epa", "margin", "success", "defense"] as const;
export type GameRankMetric = (typeof GAME_RANK_METRICS)[number];

export interface GameLine {
  game_id: string;
  week: number | null;
  gameday: string | null;
  opponent: string;
  home: boolean;
  result: "W" | "L" | "T" | "?";
  team_score: number | null;
  opp_score: number | null;
  /** team_score - opp_score */
  margin: number | null;
  snaps: number;
  epa_per_play: number | null;
  success_rate: number | null;
  explosive_rate: number | null;
  turnovers: number;
  def_snaps: number;
  /** Opponent EPA per play against this team — lower is better. */
  def_epa_allowed: number | null;
  /** 1 = best under the chosen metric. */
  rank: number;
  /** Offensive snap ids in this game (evidence). */
  evidence: string[];
}

export interface GameRank {
  id: string;
  algorithm_version: string;
  team: string;
  season: number;
  metric: GameRankMetric;
  games: GameLine[];
  best: GameLine | null;
  worst: GameLine | null;
  /** Offensive snaps of the best game. */
  evidence: string[];
  computed_at: { seq: number; head: string };
}

export function describeMetric(m: GameRankMetric): string {
  return m === "epa" ? "offensive EPA/play" : m === "margin" ? "points margin" : m === "success" ? "offensive success rate" : "EPA allowed per play (defense)";
}

function scoreFor(l: GameLine, m: GameRankMetric): number | null {
  if (m === "epa") return l.epa_per_play;
  if (m === "margin") return l.margin;
  if (m === "success") return l.success_rate;
  return l.def_epa_allowed === null ? null : -l.def_epa_allowed; // lower allowed = better
}

export function rankGames(plays: readonly Play[], games: readonly Game[], team: string, season: number, metric: GameRankMetric, at: { seq: number; head: string }): GameRank {
  const mine = games.filter((g) => g.season === season && (g.home_team === team || g.away_team === team) && typeof g.home_score === "number" && typeof g.away_score === "number");
  const byGame = new Map<string, Play[]>();
  for (const p of plays) {
    if (!p.is_snap || p.is_no_play) continue;
    if (p.posteam !== team && p.defteam !== team) continue;
    const arr = byGame.get(p.game_id);
    if (arr) arr.push(p); else byGame.set(p.game_id, [p]);
  }
  const lines: GameLine[] = mine.map((g) => {
    const home = g.home_team === team;
    const opponent = (home ? g.away_team : g.home_team) ?? "?";
    const team_score = home ? g.home_score : g.away_score;
    const opp_score = home ? g.away_score : g.home_score;
    const margin = team_score === null || opp_score === null ? null : team_score - opp_score;
    const gp = byGame.get(g.id) ?? [];
    const off = gp.filter((p) => p.posteam === team);
    const def = gp.filter((p) => p.defteam === team);
    const om = computeMetrics(off);
    const dm = computeMetrics(def);
    return {
      game_id: g.id, week: g.week, gameday: g.gameday, opponent, home,
      result: margin === null ? "?" : margin > 0 ? "W" : margin < 0 ? "L" : "T",
      team_score, opp_score, margin,
      snaps: om.attempts, epa_per_play: om.epa_per_play, success_rate: om.success_rate, explosive_rate: om.explosive_rate, turnovers: om.turnovers,
      def_snaps: dm.attempts, def_epa_allowed: dm.epa_per_play,
      rank: 0,
      evidence: off.map((p) => p.id),
    };
  });
  // Games without plays cannot be ranked on play metrics; they sort last but stay listed.
  lines.sort((a, b) => {
    const sa = scoreFor(a, metric), sb = scoreFor(b, metric);
    if (sa === null && sb === null) return (a.week ?? 0) - (b.week ?? 0);
    if (sa === null) return 1;
    if (sb === null) return -1;
    if (sb !== sa) return sb - sa;
    if ((b.margin ?? 0) !== (a.margin ?? 0)) return (b.margin ?? 0) - (a.margin ?? 0);
    return (a.week ?? 0) - (b.week ?? 0);
  });
  lines.forEach((l, i) => { l.rank = i + 1; });
  const ranked = lines.filter((l) => scoreFor(l, metric) !== null);
  const best = ranked[0] ?? null;
  const worst = ranked.length > 1 ? ranked[ranked.length - 1] : null;
  return {
    id: deterministicId("gamerank", { team, season, metric, v: GAME_RANK_VERSION, head: at.head }),
    algorithm_version: GAME_RANK_VERSION,
    team, season, metric,
    games: lines,
    best, worst,
    evidence: best?.evidence ?? [],
    computed_at: at,
  };
}

export function gameLineText(l: GameLine): string {
  const score = l.team_score === null ? "" : ` ${l.result} ${l.team_score}-${l.opp_score}`;
  return `Week ${l.week ?? "?"} ${l.home ? "vs" : "@"} ${l.opponent},${score}`;
}

export function gameRankStatements(r: GameRank): string[] {
  const out: string[] = [];
  const m = describeMetric(r.metric);
  if (!r.best) { out.push(`${r.team} has no completed ${r.season} games with play data to rank.`); return out; }
  const b = r.best;
  const detail = (l: GameLine) => r.metric === "defense"
    ? `${round(l.def_epa_allowed, 2)} EPA allowed per play over ${l.def_snaps} opponent snaps`
    : `${round(l.epa_per_play, 2)} EPA/play, ${l.success_rate === null ? "—" : Math.round(l.success_rate * 100)}% success over ${l.snaps} snaps${l.turnovers ? `, ${l.turnovers} turnover${l.turnovers === 1 ? "" : "s"}` : ""}`;
  out.push(`Best ${r.season} game by ${m}: ${gameLineText(b)} — ${detail(b)}.`);
  if (r.worst) out.push(`Worst by ${m}: ${gameLineText(r.worst)} — ${detail(r.worst)}.`);
  if (r.metric !== "margin") {
    const byMargin = [...r.games].filter((l) => l.margin !== null).sort((a, c) => (c.margin ?? 0) - (a.margin ?? 0));
    if (byMargin[0] && byMargin[0].game_id !== b.game_id) out.push(`Biggest win by margin: ${gameLineText(byMargin[0])} (${byMargin[0].margin! >= 0 ? "+" : ""}${byMargin[0].margin}).`);
  }
  const wins = r.games.filter((l) => l.result === "W").length, losses = r.games.filter((l) => l.result === "L").length, ties = r.games.filter((l) => l.result === "T").length;
  out.push(`${r.games.length} games ranked (${wins}-${losses}${ties ? `-${ties}` : ""}); ties broken by margin, then week.`);
  return out;
}
