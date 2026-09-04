/*
 * SPDX-License-Identifier: BUSL-1.1
 * Copyright (c) 2026 Interchained LLC. All rights reserved.
 * CHALK / Sports-Rater — https://sports-rater.com — Licensor: Interchained LLC
 */
/**
 * Normalizers: provider payload -> CHALK model, with lineage.
 *
 * This is the read-side twin of src/source/nfldata.ts — the only OTHER place
 * provider field names are allowed. Each normalizer is versioned; bumping the
 * version is how "recalculated now" reprocessing is expressed (spec §7).
 */
import {
  distanceBucket,
  fieldZone,
  isGarbageTime,
  scoreState,
  EXPLOSIVE_PASS_YDS,
  EXPLOSIVE_RUN_YDS,
  type Game,
  type Play,
} from "../model/football.ts";

export const PLAY_NORMALIZER = "chalk-normalize-play";
export const PLAY_NORMALIZER_VERSION = "0.1.0";
export const GAME_NORMALIZER = "chalk-normalize-game";
export const GAME_NORMALIZER_VERSION = "0.1.0";

type Json = Record<string, unknown>;

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.length ? v : null);
const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);

/** NFLData /v1/games row -> Game. */
export function normalizeNflDataGame(payload: Json, rawHash: string, now = new Date().toISOString()): Game {
  const home_score = num(payload.home_score);
  const away_score = num(payload.away_score);
  const home_team = str(payload.home_team);
  const away_team = str(payload.away_team);
  const margin = home_score !== null && away_score !== null ? home_score - away_score : null;
  const winner = margin === null ? null : margin > 0 ? home_team : margin < 0 ? away_team : null;
  return {
    id: String(payload.game_id),
    season: num(payload.season),
    week: num(payload.week),
    game_type: str(payload.game_type),
    gameday: str(payload.gameday),
    home_team,
    away_team,
    home_score,
    away_score,
    overtime: bool(payload.overtime),
    stadium: str(payload.stadium),
    roof: str(payload.roof),
    surface: str(payload.surface),
    div_game: bool(payload.div_game),
    winner,
    margin,
    derived_from: [rawHash],
    normalizer: GAME_NORMALIZER,
    normalizer_version: GAME_NORMALIZER_VERSION,
    created_at: now,
  };
}

/**
 * NFLData /v1/plays row -> Play.
 * `game` is optional context (home/away, div_game); when absent those fields are null.
 */
export function normalizeNflDataPlay(
  payload: Json,
  rawHash: string,
  game: Pick<Game, "home_team" | "away_team" | "div_game"> | null,
  now = new Date().toISOString(),
): Play {
  const game_id = String(payload.game_id);
  const play_id = Number(payload.play_id);
  const play_type = str(payload.play_type);
  const quarter = num(payload.quarter);
  const down = num(payload.down);
  const ydstogo = num(payload.ydstogo);
  const yardline_100 = num(payload.yardline_100);
  const posteam = str(payload.posteam);
  const posteam_score = num(payload.posteam_score);
  const defteam_score = num(payload.defteam_score);
  const yards_gained = num(payload.yards_gained);
  const epa = num(payload.epa);
  const touchdown = bool(payload.touchdown);
  const first_down = bool(payload.first_down);

  const score_diff = posteam_score !== null && defteam_score !== null ? posteam_score - defteam_score : null;
  const is_pass = play_type === "pass";
  const is_run = play_type === "run";

  return {
    id: `${game_id}:${play_id}`,
    game_id,
    play_id,
    season: num(payload.season),
    week: num(payload.week),
    game_date: str(payload.game_date),
    quarter,
    down,
    ydstogo,
    yardline_100,
    posteam,
    defteam: str(payload.defteam),
    posteam_score,
    defteam_score,
    play_type,
    yards_gained,
    touchdown,
    turnover: bool(payload.turnover),
    penalty: bool(payload.penalty),
    first_down,
    epa,
    wpa: num(payload.wpa),

    score_diff,
    score_state: scoreState(score_diff),
    neutral: score_diff === null ? null : Math.abs(score_diff) <= 8,
    garbage_time: isGarbageTime(quarter, score_diff),
    half: quarter === null ? null : quarter <= 2 ? 1 : quarter <= 4 ? 2 : 3,
    is_snap: is_pass || is_run,
    is_dropback: is_pass,
    is_kneel: play_type === "qb_kneel",
    is_spike: play_type === "qb_spike",
    is_no_play: play_type === "no_play",
    converted: down === null ? null : Boolean(first_down) || Boolean(touchdown),
    success: epa === null ? null : epa > 0,
    explosive:
      yards_gained === null || !(is_pass || is_run)
        ? null
        : is_pass
          ? yards_gained >= EXPLOSIVE_PASS_YDS
          : yards_gained >= EXPLOSIVE_RUN_YDS,
    distance_bucket: distanceBucket(ydstogo),
    field_zone: fieldZone(yardline_100),
    goal_to_go: ydstogo !== null && yardline_100 !== null ? ydstogo >= yardline_100 : null,
    posteam_is_home: game && posteam ? posteam === game.home_team : null,
    div_game: game ? game.div_game : null,

    derived_from: [rawHash],
    normalizer: PLAY_NORMALIZER,
    normalizer_version: PLAY_NORMALIZER_VERSION,
    created_at: now,
  };
}
