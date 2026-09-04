/**
 * Contextual patterns — the join between plays and football_play_context.
 *
 * Given a set of plays and the context rows for their game(s), compute the
 * "how" behind the "what": shotgun rate, personnel usage, motion, play-action,
 * pressure. Every rate carries its own denominator (plays WITH the field), so
 * a season where charting covers 92% of snaps reports exactly that coverage
 * rather than pretending.
 */
import type { PlayContext } from "../ingest/context.ts";
import type { Play } from "../model/football.ts";
import { round } from "./metrics.ts";

export interface Share {
  key: string;
  n: number;
  share: number;
}

export interface ContextPatterns {
  /** Plays in the sample that had ANY context row. */
  covered: number;
  total: number;
  coverage: number | null;
  shotgun_n: number;
  shotgun_rate: number | null;
  under_center_rate: number | null;
  /** Pass rate given shotgun / under center — the Sarah number. */
  pass_rate_from_shotgun: number | null;
  pass_rate_under_center: number | null;
  personnel_n: number;
  personnel: Share[];
  motion_n: number;
  motion_rate: number | null;
  play_action_n: number;
  /** Of dropbacks with charting. */
  play_action_rate: number | null;
  screen_rate: number | null;
  rpo_rate: number | null;
  no_huddle_rate: number | null;
  pressure_n: number;
  /** Of dropbacks with participation. */
  pressure_rate: number | null;
  /** Success rate when pressured vs clean, when both have n >= 5. */
  success_under_pressure: number | null;
  success_clean: number | null;
  box_n: number;
  avg_defenders_in_box: number | null;
  light_box_rate: number | null; // <= 6 in box
  heavy_box_rate: number | null; // >= 8 in box
}

const ratio = (n: number, d: number) => (d > 0 ? n / d : null);

export function contextPatterns(plays: readonly Play[], ctx: ReadonlyMap<string, PlayContext>): ContextPatterns {
  let covered = 0;
  let formN = 0, shotgun = 0, under = 0;
  let sgPass = 0, sgN = 0, ucPass = 0, ucN = 0;
  const pers = new Map<string, number>();
  let persN = 0;
  let motionN = 0, motion = 0;
  let dbChart = 0, pa = 0, screen = 0, rpo = 0;
  let huddleN = 0, noHuddle = 0;
  let dbPart = 0, pressure = 0;
  let sucP = 0, nP = 0, sucC = 0, nC = 0;
  let boxN = 0, boxSum = 0, light = 0, heavy = 0;
  for (const p of plays) {
    const c = ctx.get(p.id);
    if (!c) continue;
    covered++;
    if (c.shotgun !== null) {
      formN++;
      if (c.shotgun) { shotgun++; sgN++; if (p.is_dropback) sgPass++; }
      if (c.under_center) { under++; ucN++; if (p.is_dropback) ucPass++; }
    }
    if (c.personnel_group) { persN++; pers.set(c.personnel_group, (pers.get(c.personnel_group) ?? 0) + 1); }
    if (c.motion !== null) { motionN++; if (c.motion) motion++; }
    if (c.no_huddle !== null) { huddleN++; if (c.no_huddle) noHuddle++; }
    if (p.is_dropback) {
      if (c.play_action !== null) { dbChart++; if (c.play_action) pa++; if (c.screen) screen++; if (c.rpo) rpo++; }
      if (c.was_pressure !== null) {
        dbPart++;
        if (c.was_pressure) { pressure++; if (p.success !== null) { nP++; if (p.success) sucP++; } }
        else if (p.success !== null) { nC++; if (p.success) sucC++; }
      }
    }
    if (c.defenders_in_box !== null && c.defenders_in_box > 0) { boxN++; boxSum += c.defenders_in_box; if (c.defenders_in_box <= 6) light++; if (c.defenders_in_box >= 8) heavy++; }
  }
  const personnel: Share[] = [...pers.entries()].map(([key, n]) => ({ key, n, share: n / persN })).sort((a, b) => b.n - a.n);
  return {
    covered,
    total: plays.length,
    coverage: ratio(covered, plays.length),
    shotgun_n: formN,
    shotgun_rate: ratio(shotgun, formN),
    under_center_rate: ratio(under, formN),
    pass_rate_from_shotgun: ratio(sgPass, sgN),
    pass_rate_under_center: ratio(ucPass, ucN),
    personnel_n: persN,
    personnel,
    motion_n: motionN,
    motion_rate: ratio(motion, motionN),
    play_action_n: dbChart,
    play_action_rate: ratio(pa, dbChart),
    screen_rate: ratio(screen, dbChart),
    rpo_rate: ratio(rpo, dbChart),
    no_huddle_rate: ratio(noHuddle, huddleN),
    pressure_n: dbPart,
    pressure_rate: ratio(pressure, dbPart),
    success_under_pressure: nP >= 5 ? sucP / nP : null,
    success_clean: nC >= 5 ? sucC / nC : null,
    box_n: boxN,
    avg_defenders_in_box: boxN ? boxSum / boxN : null,
    light_box_rate: ratio(light, boxN),
    heavy_box_rate: ratio(heavy, boxN),
  };
}

/** Presentation view (percentages, rounded) for evidence packages. */
export function summarizePatterns(c: ContextPatterns) {
  const pct = (v: number | null) => (v === null ? null : round(v * 100, 1));
  return {
    coverage_pct: pct(c.coverage),
    covered: c.covered,
    shotgun_pct: pct(c.shotgun_rate),
    under_center_pct: pct(c.under_center_rate),
    pass_pct_from_shotgun: pct(c.pass_rate_from_shotgun),
    pass_pct_under_center: pct(c.pass_rate_under_center),
    personnel: c.personnel.slice(0, 4).map((s) => ({ group: s.key, pct: pct(s.share), n: s.n })),
    motion_pct: pct(c.motion_rate),
    play_action_pct_of_dropbacks: pct(c.play_action_rate),
    screen_pct_of_dropbacks: pct(c.screen_rate),
    rpo_pct_of_dropbacks: pct(c.rpo_rate),
    no_huddle_pct: pct(c.no_huddle_rate),
    pressure_pct_of_dropbacks: pct(c.pressure_rate),
    success_pct_under_pressure: pct(c.success_under_pressure),
    success_pct_clean: pct(c.success_clean),
    avg_defenders_in_box: round(c.avg_defenders_in_box, 2),
    light_box_pct: pct(c.light_box_rate),
    heavy_box_pct: pct(c.heavy_box_rate),
  };
}

/**
 * Deterministic sentences for the model + fan view. Only emitted with enough
 * coverage. `team` is the SUBJECT label — pass "TB" for a team's own offense,
 * or "Offenses facing TB" when the plays are what a defense saw.
 */
export function patternStatements(team: string, situation: string, c: ContextPatterns, baseline?: ContextPatterns): string[] {
  const out: string[] = [];
  const pct = (v: number | null) => (v === null ? "n/a" : `${round(v * 100, 1)}%`);
  if (c.covered < 10) {
    out.push(`Formation/personnel context covers only ${c.covered} of ${c.total} plays here — not enough to describe how they line up.`);
    return out;
  }
  if (c.shotgun_rate !== null) {
    const b = baseline?.shotgun_rate ?? null;
    out.push(`${team} in shotgun on ${pct(c.shotgun_rate)} of ${c.shotgun_n} snaps${b !== null ? ` (${round((c.shotgun_rate - b) * 100, 1)! >= 0 ? "+" : ""}${round((c.shotgun_rate - b) * 100, 1)} pts vs their ${pct(b)} baseline)` : ""}${c.pass_rate_from_shotgun !== null ? `; pass rate from shotgun ${pct(c.pass_rate_from_shotgun)}` : ""}.`);
  }
  if (c.personnel.length) {
    const top = c.personnel[0];
    out.push(`Top personnel: ${top.key} on ${pct(top.share)} of ${c.personnel_n} snaps${c.personnel[1] ? `, then ${c.personnel[1].key} (${pct(c.personnel[1].share)})` : ""}.`);
  }
  if (c.play_action_rate !== null && c.play_action_n >= 10) out.push(`Play-action on ${pct(c.play_action_rate)} of ${c.play_action_n} dropbacks; motion on ${pct(c.motion_rate)} of snaps.`);
  if (c.pressure_rate !== null && c.pressure_n >= 10) out.push(`Pressured on ${pct(c.pressure_rate)} of ${c.pressure_n} dropbacks${c.success_under_pressure !== null && c.success_clean !== null ? ` — success ${pct(c.success_under_pressure)} under pressure vs ${pct(c.success_clean)} clean` : ""}.`);
  if (c.coverage !== null && c.coverage < 0.8) out.push(`Context coverage: ${pct(c.coverage)} of plays in this sample have participation/charting data.`);
  return out;
}
