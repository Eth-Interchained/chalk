/*
 * SPDX-License-Identifier: BUSL-1.1
 * Copyright (c) 2026 Interchained LLC. All rights reserved.
 * CHALK / Sports-Rater — https://sports-rater.com — Licensor: Interchained LLC
 */
/**
 * Ingest audit — does the store hold what a season should hold?
 *
 * Reconciles what we have (games with results, plays per game, context rows
 * per game) and names every game that looks incomplete, so a source that
 * answered 200 with a short or empty body is VISIBLE instead of silently
 * costing a game. Read-only; runs against the live server (GET
 * /api/v1/ingest/audit) or the CLI (`chalk audit --season N`).
 *
 * Floors are deliberately conservative: the shortest 2025 regular-season game
 * had 135 plays; a completed game with fewer than MIN_PLAYS_COMPLETED_GAME is
 * flagged, never dropped.
 */
import { COLL } from "../store/collections.ts";
import type { Store } from "../store/nedb.ts";
import type { Game, Play } from "../model/football.ts";
import { PLAY_CONTEXT, type PlayContext } from "./context.ts";

/** A completed NFL game below this many play-by-play rows is treated as an incomplete source response. */
export const MIN_PLAYS_COMPLETED_GAME = 100;

export interface GameAudit {
  game_id: string;
  week: number | null;
  home_team: string | null;
  away_team: string | null;
  plays: number;
  context: number;
  /** ok | short_plays | no_plays | no_context */
  status: "ok" | "short_plays" | "no_plays" | "no_context";
}

export interface SeasonAudit {
  season: number;
  games_listed: number;
  games_with_results: number;
  plays: number;
  context_rows: number;
  /** Games with a result whose play count is below the floor (includes zero). */
  short_games: GameAudit[];
  /** Games with a result and plays but no context rows (run ingest --context-only). */
  games_without_context: GameAudit[];
  min_plays: { game_id: string; plays: number } | null;
  max_plays: { game_id: string; plays: number } | null;
  ok: boolean;
  /** One line a human can act on. */
  summary: string;
  per_game: GameAudit[];
}

export async function auditSeason(store: Store, season: number): Promise<SeasonAudit> {
  const [games, plays, ctx] = await Promise.all([
    store.query<Game>(`FROM ${COLL.games} WHERE season = ${season}`),
    store.query<Play>(`FROM ${COLL.plays} WHERE season = ${season}`),
    store.query<PlayContext>(`FROM ${PLAY_CONTEXT}`),
  ]);
  const playCount = new Map<string, number>();
  for (const p of plays) playCount.set(p.data.game_id, (playCount.get(p.data.game_id) ?? 0) + 1);
  const ctxCount = new Map<string, number>();
  for (const c of ctx) ctxCount.set(c.data.game_id, (ctxCount.get(c.data.game_id) ?? 0) + 1);

  const withResults = games.filter((g) => typeof g.data.home_score === "number" && typeof g.data.away_score === "number");
  const per_game: GameAudit[] = withResults
    .map((g) => {
      const n = playCount.get(g.data.id) ?? 0;
      const c = ctxCount.get(g.data.id) ?? 0;
      const status: GameAudit["status"] = n === 0 ? "no_plays" : n < MIN_PLAYS_COMPLETED_GAME ? "short_plays" : c === 0 ? "no_context" : "ok";
      return { game_id: g.data.id, week: g.data.week, home_team: g.data.home_team, away_team: g.data.away_team, plays: n, context: c, status };
    })
    .sort((a, b) => (a.week ?? 0) - (b.week ?? 0) || a.game_id.localeCompare(b.game_id));

  const short_games = per_game.filter((g) => g.status === "no_plays" || g.status === "short_plays");
  const games_without_context = per_game.filter((g) => g.status === "no_context");
  const withPlays = per_game.filter((g) => g.plays > 0);
  const min = withPlays.length ? withPlays.reduce((a, b) => (b.plays < a.plays ? b : a)) : null;
  const max = withPlays.length ? withPlays.reduce((a, b) => (b.plays > a.plays ? b : a)) : null;
  const ctxRowsForSeason = per_game.reduce((s, g) => s + g.context, 0);
  const ok = short_games.length === 0;
  const parts = [`${season}: ${withResults.length}/${games.length} games with results, ${plays.length} plays, ${ctxRowsForSeason} context rows.`];
  if (short_games.length) parts.push(`${short_games.length} game(s) short of the ${MIN_PLAYS_COMPLETED_GAME}-play floor: ${short_games.map((g) => `${g.game_id} (${g.plays})`).join(", ")} — re-run ${short_games.map((g) => `\`chalk ingest --season ${season} --game ${g.game_id} --deep\``).join(" and ")}.`);
  if (games_without_context.length) parts.push(`${games_without_context.length} game(s) without context — run \`chalk ingest --season ${season} --context-only\`.`);
  if (ok && !games_without_context.length) parts.push("Nothing missing.");
  return {
    season,
    games_listed: games.length,
    games_with_results: withResults.length,
    plays: plays.length,
    context_rows: ctxRowsForSeason,
    short_games,
    games_without_context,
    min_plays: min ? { game_id: min.game_id, plays: min.plays } : null,
    max_plays: max ? { game_id: max.game_id, plays: max.plays } : null,
    ok,
    summary: parts.join(" "),
    per_game,
  };
}
