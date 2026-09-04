/*
 * SPDX-License-Identifier: BUSL-1.1
 * Copyright (c) 2026 Interchained LLC. All rights reserved.
 * CHALK / Sports-Rater — https://sports-rater.com — Licensor: Interchained LLC
 */
/**
 * Situation engine — the structured filter every football question compiles to.
 *
 * Three jobs:
 *   1. validateFilter(unknown)  — turn a model-proposed (or user-supplied)
 *      object into a SituationFilter or a precise list of errors. The model
 *      proposes; this decides what is valid (spec §9, §29).
 *   2. compileNql(filter)       — the COARSE fetch: an NQL statement that pulls
 *      the candidate population from NEDB (team/season/game/down).
 *   3. applyFilter(plays, f)    — the FINE filter, in code, deterministic,
 *      covering every dimension NQL can't or shouldn't express.
 *
 * Every accepted filter is echoed back normalized so the evidence trail shows
 * exactly which definition produced a number.
 */
import type { DistanceBucket, FieldZone, Play, ScoreState } from "../model/football.ts";
import { COLL } from "../store/collections.ts";
import { nqlStr } from "../store/nedb.ts";

export type Side = "offense" | "defense";

export interface SituationFilter {
  team: string;
  side: Side;
  season?: number;
  week_min?: number;
  week_max?: number;
  game_id?: string;
  game_ids?: string[];
  opponent?: string;
  down?: number[];
  distance_min?: number;
  distance_max?: number;
  distance_bucket?: DistanceBucket[];
  quarter?: number[];
  half?: Array<1 | 2 | 3>;
  score_state?: ScoreState[];
  /** |score_diff| <= 8 */
  neutral_only?: boolean;
  score_diff_min?: number;
  score_diff_max?: number;
  field_zone?: FieldZone[];
  goal_to_go?: boolean;
  home?: boolean;
  divisional?: boolean;
  play_types?: string[];
  /** Restrict to offensive snaps (pass|run). Default true. */
  snaps_only: boolean;
  exclude_kneels: boolean;
  exclude_spikes: boolean;
  exclude_no_play: boolean;
  exclude_penalties: boolean;
  exclude_garbage_time: boolean;
}

export const FILTER_DEFAULTS = {
  side: "offense" as Side,
  snaps_only: true,
  exclude_kneels: true,
  exclude_spikes: true,
  exclude_no_play: true,
  exclude_penalties: false,
  exclude_garbage_time: false,
};

export interface ValidationResult {
  ok: boolean;
  filter?: SituationFilter;
  errors: string[];
  /** Keys present in the input that the engine does not understand. */
  unknown_keys: string[];
}

const KNOWN_KEYS = new Set([
  "team", "side", "season", "week_min", "week_max", "game_id", "game_ids", "opponent", "down",
  "distance_min", "distance_max", "distance_bucket", "quarter", "half", "score_state", "neutral_only",
  "score_diff_min", "score_diff_max", "field_zone", "goal_to_go", "home", "divisional", "play_types",
  "snaps_only", "exclude_kneels", "exclude_spikes", "exclude_no_play", "exclude_penalties", "exclude_garbage_time",
]);

const TEAM_RE = /^[A-Z]{2,3}$/;
const GAME_ID_RE = /^\d{4}_\d{2}_[A-Z]{2,3}_[A-Z]{2,3}$/;

export function validateFilter(input: unknown): ValidationResult {
  const errors: string[] = [];
  const unknown_keys: string[] = [];
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, errors: ["filter must be an object"], unknown_keys };
  }
  const o = input as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!KNOWN_KEYS.has(k)) unknown_keys.push(k);

  const team = typeof o.team === "string" ? o.team.toUpperCase().trim() : undefined;
  if (!team || !TEAM_RE.test(team)) errors.push("team: required, 2-3 letter abbreviation (e.g. TB)");

  const side = o.side === undefined ? FILTER_DEFAULTS.side : o.side;
  if (side !== "offense" && side !== "defense") errors.push("side: must be offense|defense");

  const intOpt = (k: string, min: number, max: number): number | undefined => {
    const v = o[k];
    if (v === undefined || v === null) return undefined;
    if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
      errors.push(`${k}: integer in [${min}, ${max}]`);
      return undefined;
    }
    return v;
  };
  const boolOpt = (k: string, dflt?: boolean): boolean | undefined => {
    const v = o[k];
    if (v === undefined || v === null) return dflt;
    if (typeof v !== "boolean") {
      errors.push(`${k}: boolean`);
      return dflt;
    }
    return v;
  };
  const intList = (k: string, min: number, max: number): number[] | undefined => {
    const v = o[k];
    if (v === undefined || v === null) return undefined;
    const arr = Array.isArray(v) ? v : [v];
    const out: number[] = [];
    for (const x of arr) {
      if (typeof x !== "number" || !Number.isInteger(x) || x < min || x > max) {
        errors.push(`${k}: integers in [${min}, ${max}]`);
        return undefined;
      }
      out.push(x);
    }
    return [...new Set(out)].sort((a, b) => a - b);
  };
  const enumList = <T extends string>(k: string, allowed: readonly T[]): T[] | undefined => {
    const v = o[k];
    if (v === undefined || v === null) return undefined;
    const arr = Array.isArray(v) ? v : [v];
    const out: T[] = [];
    for (const x of arr) {
      if (typeof x !== "string" || !allowed.includes(x as T)) {
        errors.push(`${k}: one of ${allowed.join("|")}`);
        return undefined;
      }
      out.push(x as T);
    }
    return [...new Set(out)];
  };

  const season = intOpt("season", 1999, 2100);
  const week_min = intOpt("week_min", 1, 22);
  const week_max = intOpt("week_max", 1, 22);
  if (week_min !== undefined && week_max !== undefined && week_min > week_max) errors.push("week_min > week_max");

  let game_id: string | undefined;
  if (o.game_id !== undefined && o.game_id !== null) {
    if (typeof o.game_id !== "string" || !GAME_ID_RE.test(o.game_id)) errors.push("game_id: format YYYY_WW_AWAY_HOME");
    else game_id = o.game_id;
  }
  let game_ids: string[] | undefined;
  if (o.game_ids !== undefined && o.game_ids !== null) {
    if (!Array.isArray(o.game_ids) || o.game_ids.some((g) => typeof g !== "string" || !GAME_ID_RE.test(g))) {
      errors.push("game_ids: array of YYYY_WW_AWAY_HOME");
    } else game_ids = [...new Set(o.game_ids as string[])].sort();
  }
  let opponent: string | undefined;
  if (o.opponent !== undefined && o.opponent !== null) {
    if (typeof o.opponent !== "string" || !TEAM_RE.test(o.opponent.toUpperCase())) errors.push("opponent: 2-3 letter abbreviation");
    else opponent = o.opponent.toUpperCase();
  }
  if (season === undefined && !game_id && !game_ids) errors.push("one of season, game_id, game_ids is required");

  const down = intList("down", 1, 4);
  const distance_min = intOpt("distance_min", 1, 99);
  const distance_max = intOpt("distance_max", 1, 99);
  if (distance_min !== undefined && distance_max !== undefined && distance_min > distance_max) errors.push("distance_min > distance_max");
  const distance_bucket = enumList<DistanceBucket>("distance_bucket", ["short", "medium", "long", "very_long"]);
  const quarter = intList("quarter", 1, 6);
  const half = intList("half", 1, 3) as Array<1 | 2 | 3> | undefined;
  const score_state = enumList<ScoreState>("score_state", ["leading", "trailing", "tied"]);
  const neutral_only = boolOpt("neutral_only");
  const score_diff_min = intOpt("score_diff_min", -99, 99);
  const score_diff_max = intOpt("score_diff_max", -99, 99);
  const field_zone = enumList<FieldZone>("field_zone", ["own", "opp", "red_zone"]);
  const goal_to_go = boolOpt("goal_to_go");
  const home = boolOpt("home");
  const divisional = boolOpt("divisional");
  let play_types: string[] | undefined;
  if (o.play_types !== undefined && o.play_types !== null) {
    if (!Array.isArray(o.play_types) || o.play_types.some((p) => typeof p !== "string")) errors.push("play_types: array of strings");
    else play_types = [...new Set(o.play_types as string[])];
  }

  const snaps_only = boolOpt("snaps_only", FILTER_DEFAULTS.snaps_only)!;
  const exclude_kneels = boolOpt("exclude_kneels", FILTER_DEFAULTS.exclude_kneels)!;
  const exclude_spikes = boolOpt("exclude_spikes", FILTER_DEFAULTS.exclude_spikes)!;
  const exclude_no_play = boolOpt("exclude_no_play", FILTER_DEFAULTS.exclude_no_play)!;
  const exclude_penalties = boolOpt("exclude_penalties", FILTER_DEFAULTS.exclude_penalties)!;
  const exclude_garbage_time = boolOpt("exclude_garbage_time", FILTER_DEFAULTS.exclude_garbage_time)!;

  if (errors.length) return { ok: false, errors, unknown_keys };

  const filter: SituationFilter = {
    team: team!,
    side: side as Side,
    snaps_only,
    exclude_kneels,
    exclude_spikes,
    exclude_no_play,
    exclude_penalties,
    exclude_garbage_time,
  };
  if (season !== undefined) filter.season = season;
  if (week_min !== undefined) filter.week_min = week_min;
  if (week_max !== undefined) filter.week_max = week_max;
  if (game_id) filter.game_id = game_id;
  if (game_ids) filter.game_ids = game_ids;
  if (opponent) filter.opponent = opponent;
  if (down) filter.down = down;
  if (distance_min !== undefined) filter.distance_min = distance_min;
  if (distance_max !== undefined) filter.distance_max = distance_max;
  if (distance_bucket) filter.distance_bucket = distance_bucket;
  if (quarter) filter.quarter = quarter;
  if (half) filter.half = half;
  if (score_state) filter.score_state = score_state;
  if (neutral_only !== undefined) filter.neutral_only = neutral_only;
  if (score_diff_min !== undefined) filter.score_diff_min = score_diff_min;
  if (score_diff_max !== undefined) filter.score_diff_max = score_diff_max;
  if (field_zone) filter.field_zone = field_zone;
  if (goal_to_go !== undefined) filter.goal_to_go = goal_to_go;
  if (home !== undefined) filter.home = home;
  if (divisional !== undefined) filter.divisional = divisional;
  if (play_types) filter.play_types = play_types;
  return { ok: true, filter, errors: [], unknown_keys };
}

/**
 * Coarse NQL: pull the smallest candidate set NEDB can hand us cheaply.
 * team side + scope (game or season) + down when single-valued. Everything
 * else is applied in code so the definition is one place (applyFilter).
 */
export function compileNql(f: SituationFilter): string {
  const teamField = f.side === "offense" ? "posteam" : "defteam";
  const where: string[] = [`${teamField} = ${nqlStr(f.team)}`];
  if (f.game_id) where.push(`game_id = ${nqlStr(f.game_id)}`);
  else if (f.season !== undefined) where.push(`season = ${f.season}`);
  if (f.down && f.down.length === 1) where.push(`down = ${f.down[0]}`);
  return `FROM ${COLL.plays} WHERE ${where.join(" AND ")}`;
}

/** Coarse NQL for a whole league population (rating populations). */
export function compileLeagueNql(season: number, down?: number): string {
  const where = [`season = ${season}`];
  if (down !== undefined) where.push(`down = ${down}`);
  return `FROM ${COLL.plays} WHERE ${where.join(" AND ")}`;
}

/** Fine filter — pure, deterministic, order-preserving. */
export function applyFilter(plays: readonly Play[], f: SituationFilter): Play[] {
  const teamField = f.side === "offense" ? "posteam" : "defteam";
  const oppField = f.side === "offense" ? "defteam" : "posteam";
  const gameSet = f.game_ids ? new Set(f.game_ids) : null;
  const downSet = f.down ? new Set(f.down) : null;
  const bucketSet = f.distance_bucket ? new Set(f.distance_bucket) : null;
  const qSet = f.quarter ? new Set(f.quarter) : null;
  const halfSet = f.half ? new Set<number>(f.half) : null;
  const stateSet = f.score_state ? new Set(f.score_state) : null;
  const zoneSet = f.field_zone ? new Set(f.field_zone) : null;
  const typeSet = f.play_types ? new Set(f.play_types) : null;

  return plays.filter((p) => {
    if (p[teamField] !== f.team) return false;
    if (f.opponent && p[oppField] !== f.opponent) return false;
    if (f.game_id && p.game_id !== f.game_id) return false;
    if (gameSet && !gameSet.has(p.game_id)) return false;
    if (f.season !== undefined && p.season !== f.season) return false;
    if (f.week_min !== undefined && (p.week === null || p.week < f.week_min)) return false;
    if (f.week_max !== undefined && (p.week === null || p.week > f.week_max)) return false;

    if (f.exclude_no_play && p.is_no_play) return false;
    if (f.exclude_kneels && p.is_kneel) return false;
    if (f.exclude_spikes && p.is_spike) return false;
    if (f.exclude_penalties && p.penalty === true) return false;
    if (f.exclude_garbage_time && p.garbage_time === true) return false;
    if (f.snaps_only && !p.is_snap) return false;
    if (typeSet && (p.play_type === null || !typeSet.has(p.play_type))) return false;

    if (downSet && (p.down === null || !downSet.has(p.down))) return false;
    if (f.distance_min !== undefined && (p.ydstogo === null || p.ydstogo < f.distance_min)) return false;
    if (f.distance_max !== undefined && (p.ydstogo === null || p.ydstogo > f.distance_max)) return false;
    if (bucketSet && (p.distance_bucket === null || !bucketSet.has(p.distance_bucket))) return false;
    if (qSet && (p.quarter === null || !qSet.has(p.quarter))) return false;
    if (halfSet && (p.half === null || !halfSet.has(p.half))) return false;

    // Score context is always from the OFFENSE's point of view in the data;
    // for a defense filter we flip it so "leading" means the defense is leading.
    const diff = p.score_diff === null ? null : f.side === "offense" ? p.score_diff : -p.score_diff;
    const state = diff === null ? null : diff > 0 ? "leading" : diff < 0 ? "trailing" : "tied";
    if (stateSet && (state === null || !stateSet.has(state))) return false;
    if (f.neutral_only && (diff === null || Math.abs(diff) > 8)) return false;
    if (f.score_diff_min !== undefined && (diff === null || diff < f.score_diff_min)) return false;
    if (f.score_diff_max !== undefined && (diff === null || diff > f.score_diff_max)) return false;

    if (zoneSet && (p.field_zone === null || !zoneSet.has(p.field_zone))) return false;
    if (f.goal_to_go !== undefined && p.goal_to_go !== f.goal_to_go) return false;
    if (f.home !== undefined) {
      if (p.posteam_is_home === null) return false;
      const teamIsHome = f.side === "offense" ? p.posteam_is_home : !p.posteam_is_home;
      if (teamIsHome !== f.home) return false;
    }
    if (f.divisional !== undefined && p.div_game !== f.divisional) return false;
    return true;
  });
}

/** Human-readable definition line for evidence panels. */
export function describeFilter(f: SituationFilter): string {
  const parts: string[] = [`${f.team} ${f.side}`];
  if (f.game_id) parts.push(`game ${f.game_id}`);
  else if (f.season !== undefined) parts.push(`${f.season} season`);
  if (f.game_ids) parts.push(`${f.game_ids.length} selected games`);
  if (f.week_min !== undefined || f.week_max !== undefined) parts.push(`weeks ${f.week_min ?? 1}-${f.week_max ?? "end"}`);
  if (f.opponent) parts.push(`vs ${f.opponent}`);
  if (f.down) parts.push(`down ${f.down.join("/")}`);
  if (f.distance_min !== undefined || f.distance_max !== undefined) parts.push(`distance ${f.distance_min ?? 1}-${f.distance_max ?? "99"}`);
  if (f.distance_bucket) parts.push(`distance ${f.distance_bucket.join("/")}`);
  if (f.quarter) parts.push(`Q${f.quarter.join("/Q")}`);
  if (f.half) parts.push(`half ${f.half.join("/")}`);
  if (f.score_state) parts.push(f.score_state.join("/"));
  if (f.neutral_only) parts.push("one-score games only");
  if (f.field_zone) parts.push(f.field_zone.join("/"));
  if (f.goal_to_go) parts.push("goal-to-go");
  if (f.home !== undefined) parts.push(f.home ? "home" : "away");
  if (f.divisional !== undefined) parts.push(f.divisional ? "divisional" : "non-divisional");
  const ex: string[] = [];
  if (f.exclude_kneels) ex.push("kneels");
  if (f.exclude_spikes) ex.push("spikes");
  if (f.exclude_no_play) ex.push("no-plays");
  if (f.exclude_penalties) ex.push("penalty plays");
  if (f.exclude_garbage_time) ex.push("garbage time");
  if (ex.length) parts.push(`excluding ${ex.join(", ")}`);
  if (f.snaps_only) parts.push("pass/run snaps only");
  return parts.join(" · ");
}
