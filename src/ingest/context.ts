/**
 * Play context — the participation + charting join (V3 §11, the Sarah screen).
 *
 * NFLData's `/v1/plays` carries no formation/personnel/motion; those live in
 * `/v1/participation` (nflverse participation: offense_formation,
 * offense_personnel, defenders_in_box, number_of_pass_rushers, was_pressure)
 * and `/v1/charting` (FTN: qb_location, is_motion, is_play_action,
 * is_screen_pass, is_rpo, is_no_huddle, n_blitzers, n_pass_rushers…).
 *
 * `football_play_context` holds ONE derived row per play id, `derived_from`
 * the raw participation and/or charting rows that produced it. Fields are
 * null when neither source has them — never inferred.
 *
 * Personnel group: count RB/FB → backs, TE → tight ends; group = `${backs}${tes}`
 * ("11" = 1 RB 1 TE, "12", "21", "13", "10", "22"…). Only computed when the
 * offense_personnel string names an offensive skill grouping (it also appears
 * for special-teams snaps with CB/FS/LB lists — those stay null).
 */
import type { Lineage } from "../model/football.ts";

export const CONTEXT_NORMALIZER = "chalk-normalize-context";
export const CONTEXT_NORMALIZER_VERSION = "0.1.0";
export const PLAY_CONTEXT = "football_play_context";

export interface PlayContext extends Lineage {
  id: string;
  game_id: string;
  play_id: number;
  /** nflverse participation formation verbatim: SHOTGUN, UNDER CENTER, SINGLEBACK, I_FORM, PISTOL, EMPTY, JUMBO, WILDCAT… */
  formation: string | null;
  /** FTN qb_location verbatim: S (shotgun), U (under center), P (pistol)… */
  qb_location: string | null;
  /** Derived: formation says SHOTGUN or qb_location S. Null when neither source present. */
  shotgun: boolean | null;
  under_center: boolean | null;
  offense_personnel: string | null;
  /** Derived group like "11", "12", "21"; null when not an offensive grouping. */
  personnel_group: string | null;
  backs: number | null;
  tight_ends: number | null;
  receivers: number | null;
  defense_personnel: string | null;
  defenders_in_box: number | null;
  pass_rushers: number | null;
  blitzers: number | null;
  was_pressure: boolean | null;
  motion: boolean | null;
  play_action: boolean | null;
  screen: boolean | null;
  rpo: boolean | null;
  no_huddle: boolean | null;
  qb_sneak: boolean | null;
  trick_play: boolean | null;
  qb_out_of_pocket: boolean | null;
  throw_away: boolean | null;
  drop: boolean | null;
  interception_worthy: boolean | null;
  time_to_throw: number | null;
  air_yards: number | null;
  /** Which sources contributed. */
  sources: Array<"participation" | "charting">;
}

type Json = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === "string" && v.length ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);

export function parsePersonnel(s: string | null): { backs: number; tight_ends: number; receivers: number; group: string } | null {
  if (!s) return null;
  let backs = 0, tes = 0, wrs = 0, offensive = false;
  for (const part of s.split(",")) {
    const m = part.trim().match(/^(\d+)\s+([A-Z]+)$/);
    if (!m) continue;
    const n = Number(m[1]);
    const pos = m[2];
    if (pos === "RB" || pos === "FB" || pos === "HB") { backs += n; offensive = true; }
    else if (pos === "TE") { tes += n; offensive = true; }
    else if (pos === "WR") { wrs += n; offensive = true; }
    else if (pos === "QB" || pos === "OL" || pos === "T" || pos === "G" || pos === "C") offensive = true;
  }
  if (!offensive) return null;
  return { backs, tight_ends: tes, receivers: wrs, group: `${backs}${tes}` };
}

export function normalizeContext(
  gameId: string,
  playId: number,
  participation: Json | null,
  charting: Json | null,
  derivedFrom: string[],
  now = new Date().toISOString(),
): PlayContext {
  const formation = participation ? str(participation.offense_formation) : null;
  const qb_location = charting ? str(charting.qb_location) : null;
  const shotgun = formation !== null || qb_location !== null ? formation === "SHOTGUN" || qb_location === "S" : null;
  const under_center = formation !== null || qb_location !== null ? formation === "UNDER CENTER" || qb_location === "U" : null;
  const personnelStr = participation ? str(participation.offense_personnel) : null;
  const pers = parsePersonnel(personnelStr);
  const sources: PlayContext["sources"] = [];
  if (participation) sources.push("participation");
  if (charting) sources.push("charting");
  return {
    id: `${gameId}:${playId}`,
    game_id: gameId,
    play_id: playId,
    formation,
    qb_location,
    shotgun,
    under_center,
    offense_personnel: personnelStr,
    personnel_group: pers?.group ?? null,
    backs: pers?.backs ?? null,
    tight_ends: pers?.tight_ends ?? null,
    receivers: pers?.receivers ?? null,
    defense_personnel: participation ? str(participation.defense_personnel) : null,
    defenders_in_box: participation ? num(participation.defenders_in_box) : charting ? num(charting.n_defense_box) : null,
    pass_rushers: participation ? num(participation.number_of_pass_rushers) : charting ? num(charting.n_pass_rushers) : null,
    blitzers: charting ? num(charting.n_blitzers) : null,
    was_pressure: participation ? bool(participation.was_pressure) : null,
    motion: charting ? bool(charting.is_motion) : null,
    play_action: charting ? bool(charting.is_play_action) : null,
    screen: charting ? bool(charting.is_screen_pass) : null,
    rpo: charting ? bool(charting.is_rpo) : null,
    no_huddle: charting ? bool(charting.is_no_huddle) : null,
    qb_sneak: charting ? bool(charting.is_qb_sneak) : null,
    trick_play: charting ? bool(charting.is_trick_play) : null,
    qb_out_of_pocket: charting ? bool(charting.is_qb_out_of_pocket) : null,
    throw_away: charting ? bool(charting.is_throw_away) : null,
    drop: charting ? bool(charting.is_drop) : null,
    interception_worthy: charting ? bool(charting.is_interception_worthy) : null,
    time_to_throw: participation ? num(participation.time_to_throw) : null,
    air_yards: participation ? num(participation.ngs_air_yards) : null,
    sources,
    derived_from: derivedFrom,
    normalizer: CONTEXT_NORMALIZER,
    normalizer_version: CONTEXT_NORMALIZER_VERSION,
    created_at: now,
  };
}
