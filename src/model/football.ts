/**
 * CHALK's normalized football model.
 *
 * These are OUR shapes. A provider's record is mapped into them by a
 * normalizer (src/ingest/normalize.ts) that records `derived_from` (the raw
 * record's NEDB hash), `normalizer` and `normalizer_version` on every output.
 *
 * Fields are nullable where a provider may legitimately lack them. We never
 * invent a value to fill a hole — a missing football concept is better than a
 * fabricated one (spec §8).
 */

export type PlayType =
  | "pass"
  | "run"
  | "punt"
  | "kickoff"
  | "field_goal"
  | "extra_point"
  | "qb_kneel"
  | "qb_spike"
  | "no_play"
  | string; // providers may add types; we keep them verbatim

export type DistanceBucket = "short" | "medium" | "long" | "very_long";
export type FieldZone = "own" | "opp" | "red_zone";
export type ScoreState = "leading" | "trailing" | "tied";

export interface Lineage {
  /** NEDB hash(es) of the record(s) this was derived from. */
  derived_from: string[];
  normalizer: string;
  normalizer_version: string;
  created_at: string;
}

export interface Game extends Lineage {
  id: string;
  season: number | null;
  week: number | null;
  game_type: string | null;
  gameday: string | null;
  home_team: string | null;
  away_team: string | null;
  home_score: number | null;
  away_score: number | null;
  overtime: boolean | null;
  stadium: string | null;
  roof: string | null;
  surface: string | null;
  div_game: boolean | null;
  /** Derived: winner abbr, null on tie or unknown. */
  winner: string | null;
  /** Derived: home_score - away_score, null if unknown. */
  margin: number | null;
}

export interface Play extends Lineage {
  /** `${game_id}:${play_id}` */
  id: string;
  game_id: string;
  play_id: number;
  season: number | null;
  week: number | null;
  game_date: string | null;
  quarter: number | null;
  down: number | null;
  ydstogo: number | null;
  yardline_100: number | null;
  posteam: string | null;
  defteam: string | null;
  posteam_score: number | null;
  defteam_score: number | null;
  /** Provider classification, kept verbatim. Human annotations may layer over it. */
  play_type: PlayType | null;
  yards_gained: number | null;
  touchdown: boolean | null;
  turnover: boolean | null;
  penalty: boolean | null;
  first_down: boolean | null;
  epa: number | null;
  wpa: number | null;

  // ---- CHALK-derived, deterministic, documented in normalize.ts ----
  /** posteam_score - defteam_score before the snap (as the provider reports it). */
  score_diff: number | null;
  score_state: ScoreState | null;
  /** |score_diff| <= 8 — one possession. */
  neutral: boolean | null;
  /** Q4 with a 17+ point gap, or Q3+ with a 25+ point gap. Advisory, optional filter. */
  garbage_time: boolean | null;
  half: 1 | 2 | 3 | null; // 3 = overtime
  /** pass or run — the offensive snap population for tendency analysis. */
  is_snap: boolean;
  is_dropback: boolean;
  is_kneel: boolean;
  is_spike: boolean;
  is_no_play: boolean;
  /** first_down || touchdown — conversion of the down in play. */
  converted: boolean | null;
  /** epa > 0 (nflverse convention). Null when epa missing. */
  success: boolean | null;
  /** pass >= 20 yds or run >= 12 yds. Null when yards missing. */
  explosive: boolean | null;
  distance_bucket: DistanceBucket | null;
  field_zone: FieldZone | null;
  goal_to_go: boolean | null;
  /** Requires the game record; null if game unknown at normalize time. */
  posteam_is_home: boolean | null;
  div_game: boolean | null;
}

export function distanceBucket(ydstogo: number | null): DistanceBucket | null {
  if (ydstogo === null || ydstogo === undefined) return null;
  if (ydstogo <= 3) return "short";
  if (ydstogo <= 6) return "medium";
  if (ydstogo <= 10) return "long";
  return "very_long";
}

export function fieldZone(yardline_100: number | null): FieldZone | null {
  if (yardline_100 === null || yardline_100 === undefined) return null;
  if (yardline_100 <= 20) return "red_zone";
  if (yardline_100 <= 50) return "opp";
  return "own";
}

export function scoreState(diff: number | null): ScoreState | null {
  if (diff === null || diff === undefined) return null;
  if (diff > 0) return "leading";
  if (diff < 0) return "trailing";
  return "tied";
}

export function isGarbageTime(quarter: number | null, diff: number | null): boolean | null {
  if (quarter === null || diff === null) return null;
  const gap = Math.abs(diff);
  if (quarter >= 4 && gap >= 17) return true;
  if (quarter >= 3 && gap >= 25) return true;
  return false;
}

export const EXPLOSIVE_PASS_YDS = 20;
export const EXPLOSIVE_RUN_YDS = 12;
