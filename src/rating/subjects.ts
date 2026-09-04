/*
 * SPDX-License-Identifier: BUSL-1.1
 * Copyright (c) 2026 Interchained LLC. All rights reserved.
 * CHALK / Sports-Rater — https://sports-rater.com — Licensor: Interchained LLC
 */
/**
 * Rating subjects beyond third down (V3 §8, §14).
 *
 * A TeamProfile is one team-season's deterministic metric surface, computed
 * from the play table alone:
 *   all-snaps bundle (epa, success, explosive, turnover, yards…)
 *   third_down_*   from the third-down analysis
 *   red_zone_*     from snaps with yardline_100 <= 20
 * Every rating definition names metrics on this surface. The league population
 * is every team with plays that season; percentile normalization is shared
 * with the third-down rating, so an "Offense 84" and a "Third Down 66" are the
 * same kind of number.
 *
 * Defense side: the same surface over plays where the team is defteam; metric
 * directions are flipped by the definition (EPA allowed: lower is better).
 */
import { computeMetrics, type MetricBundle } from "../engine/metrics.ts";
import { analyzeThirdDown, thirdDownFilter } from "../engine/thirddown.ts";
import type { Play } from "../model/football.ts";
import type { NedbRow } from "../store/nedb.ts";
import type { PopulationMember } from "./rating.ts";

export type Side = "offense" | "defense";

export interface TeamProfile extends MetricBundle {
  team: string;
  season: number;
  side: Side;
  games: number;
  third_down_attempts: number;
  third_down_conversion_rate: number | null;
  third_down_epa_per_play: number | null;
  third_down_success_rate: number | null;
  red_zone_attempts: number;
  red_zone_touchdown_rate: number | null;
  red_zone_epa_per_play: number | null;
  red_zone_success_rate: number | null;
  red_zone_turnover_rate: number | null;
  /** Points per game scored (offense) or allowed (defense), from game records when supplied. */
  points_per_game: number | null;
}

export interface GameScoreLite {
  id: string;
  home_team: string | null;
  away_team: string | null;
  home_score: number | null;
  away_score: number | null;
}

/** Build the league's profiles from a season's plays (all teams). */
export function leagueProfiles(rows: readonly NedbRow<Play>[], season: number, side: Side, games: readonly GameScoreLite[] = []): Map<string, TeamProfile> {
  const teamField = side === "offense" ? "posteam" : "defteam";
  const byTeam = new Map<string, Play[]>();
  for (const r of rows) {
    const p = r.data;
    if (p.season !== season) continue;
    const t = p[teamField];
    if (!t) continue;
    (byTeam.get(t) ?? byTeam.set(t, []).get(t)!).push(p);
  }
  const out = new Map<string, TeamProfile>();
  for (const [team, plays] of byTeam) {
    const snaps = plays.filter((p) => p.is_snap && !p.is_no_play && !p.is_kneel && !p.is_spike);
    const base = computeMetrics(snaps);
    const third = analyzeThirdDown(rows, thirdDownFilter({ team, season, side }), { seq: 0, head: "" });
    const rz = computeMetrics(snaps.filter((p) => p.field_zone === "red_zone"));
    const gameIds = new Set(snaps.map((p) => p.game_id));
    let pts: number | null = null;
    if (games.length) {
      let total = 0, n = 0;
      for (const g of games) {
        if (!gameIds.has(g.id)) continue;
        const scored = side === "offense" ? (g.home_team === team ? g.home_score : g.away_score) : (g.home_team === team ? g.away_score : g.home_score);
        if (scored !== null) { total += scored; n++; }
      }
      pts = n ? total / n : null;
    }
    out.set(team, {
      ...base,
      team,
      season,
      side,
      games: gameIds.size,
      third_down_attempts: third.metrics.attempts,
      third_down_conversion_rate: third.metrics.conversion_rate,
      third_down_epa_per_play: third.metrics.epa_per_play,
      third_down_success_rate: third.metrics.success_rate,
      red_zone_attempts: rz.attempts,
      red_zone_touchdown_rate: rz.touchdown_rate,
      red_zone_epa_per_play: rz.epa_per_play,
      red_zone_success_rate: rz.success_rate,
      red_zone_turnover_rate: rz.turnover_rate,
      points_per_game: pts,
    });
  }
  return out;
}

/** Population members for the rating engine, keyed by team. `sampleMetric` picks which attempts count as the sample. */
export function profileMembers(profiles: ReadonlyMap<string, TeamProfile>, sampleOf: (p: TeamProfile) => number): PopulationMember[] {
  return [...profiles.values()].sort((a, b) => a.team.localeCompare(b.team)).map((p) => ({
    key: p.team,
    metrics: p as unknown as MetricBundle,
    analysis_id: `profile_${p.season}_${p.side}_${p.team}`,
    attempts: sampleOf(p),
  }));
}
