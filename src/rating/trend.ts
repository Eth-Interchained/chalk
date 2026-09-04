/**
 * Rating trend for ANY subject — as known then: the week-N point uses only
 * plays through week N for the team and for the league it is ranked against.
 * The third-down trend in engine/trend.ts predates this and stays (it carries
 * per-week conversion metrics the Home tile shows); this generalizes the
 * score/rank series to the other five subjects.
 */
import type { Game, Play } from "../model/football.ts";
import type { NedbRow } from "../store/nedb.ts";
import { deterministicId } from "../store/hash.ts";
import type { RatingDefinition } from "./definitions.ts";
import { computeRating } from "./rating.ts";
import { leagueProfiles, profileMembers, type TeamProfile } from "./subjects.ts";

export interface SubjectTrendPoint {
  week: number;
  games: number;
  sample: number;
  score: number | null;
  rank: number | null;
  population: number;
  provisional: boolean;
}

export interface SubjectTrend {
  id: string;
  kind: "subject_trend";
  team: string;
  season: number;
  subject: string;
  definition_id: string;
  points: SubjectTrendPoint[];
  score_change: number | null;
  headline: string;
  computed_at_seq: number;
  computed_at_head: string;
}

function sampleFor(def: RatingDefinition, p: TeamProfile): number {
  return def.subject === "red_zone" ? p.red_zone_attempts : def.subject === "third_down" ? p.third_down_attempts : p.attempts;
}

export function subjectTrend(
  rows: readonly NedbRow<Play>[],
  games: readonly Game[],
  team: string,
  season: number,
  def: RatingDefinition,
  at: { seq: number; head: string },
): SubjectTrend {
  const side = def.subject === "defense" ? "defense" : "offense";
  const teamField = side === "offense" ? "posteam" : "defteam";
  const teamWeeks = rows.filter((r) => r.data[teamField] === team && r.data.season === season).map((r) => r.data.week).filter((w): w is number => w !== null);
  const last = teamWeeks.length ? Math.max(...teamWeeks) : 0;
  const weeks = [...new Set(rows.map((r) => r.data.week).filter((w): w is number => w !== null && w <= last))].sort((a, b) => a - b);
  const points: SubjectTrendPoint[] = [];
  const window = { season, description: "as known then" };
  for (const w of weeks) {
    const upto = rows.filter((r) => r.data.week !== null && r.data.week <= w);
    const profiles = leagueProfiles(upto, season, side, games.filter((g) => g.week !== null && g.week <= w));
    const members = profileMembers(profiles, (p) => sampleFor(def, p));
    const subject = members.find((m) => m.key === team);
    if (!subject) continue;
    const snap = computeRating(def, subject, members, window);
    const scores = members.map((m) => ({ key: m.key, s: computeRating(def, m, members, window).score ?? -1 })).sort((x, y) => y.s - x.s);
    points.push({ week: w, games: profiles.get(team)!.games, sample: subject.attempts, score: snap.score, rank: scores.findIndex((s) => s.key === team) + 1 || null, population: members.length, provisional: snap.provisional });
  }
  const solid = points.filter((p) => !p.provisional && p.score !== null);
  const first = solid[0], lastP = solid[solid.length - 1];
  const score_change = first && lastP && first !== lastP ? lastP.score! - first.score! : null;
  const headline = !lastP
    ? `Not enough sample yet for a ${def.name} trend.`
    : score_change === null
      ? `${team} ${def.name}: ${lastP.score}/100 through week ${lastP.week}.`
      : `${team} ${def.name} moved ${score_change >= 0 ? "+" : ""}${score_change} from week ${first.week} (${first.score}) to week ${lastP.week} (${lastP.score}), rank ${lastP.rank} of ${lastP.population}.`;
  return { id: deterministicId("strend", { team, season, def: def.id, head: at.head, n: rows.length }), kind: "subject_trend", team, season, subject: def.subject, definition_id: def.id, points, score_change, headline, computed_at_seq: at.seq, computed_at_head: at.head };
}
