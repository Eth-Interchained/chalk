/**
 * Generic rating + power rankings over any subject (V2 §20, V3 §8).
 *
 * rateSubject(store, team, season, def): dispatches on def.subject —
 *   third_down → the existing third-down population (per-team analyses)
 *   everything else → TeamProfile population from the season's plays
 * rankings(store, season, def): every team scored under the definition,
 * sorted, with movement vs the previous week's as-known-then snapshot when
 * `withMovement` is set (one extra pass over plays with week < last).
 */
import { compileLeagueNql } from "../engine/situation.ts";
import type { Game, Play } from "../model/football.ts";
import { COLL } from "../store/collections.ts";
import type { ChalkStore, NedbRow } from "../store/nedb.ts";
import type { RatingDefinition } from "./definitions.ts";
import { leagueThirdDown, rateThirdDown, type RateResult } from "./league.ts";
import { computeRating, persistDefinition, persistRating, type PopulationMember, type RatingSnapshot } from "./rating.ts";
import { leagueProfiles, profileMembers, type TeamProfile } from "./subjects.ts";

const profileCache = new Map<string, { at: number; members: PopulationMember[]; profiles: Map<string, TeamProfile>; seq: number; head: string; rows: NedbRow<Play>[] }>();
const PROFILE_CACHE_MS = 60_000;

export function invalidateProfileCache(): void {
  profileCache.clear();
}

export async function leagueProfilesFor(store: ChalkStore, season: number, side: "offense" | "defense", log: (l: string) => void = () => {}) {
  const key = `${season}:${side}`;
  const hit = profileCache.get(key);
  if (hit && Date.now() - hit.at < PROFILE_CACHE_MS) return hit;
  const t0 = Date.now();
  const { rows, seq, head } = await store.queryAt<Play>(compileLeagueNql(season));
  const games = (await store.query<Game>(`FROM ${COLL.games} WHERE season = ${season}`)).map((g) => g.data);
  const profiles = leagueProfiles(rows, season, side, games);
  const members = profileMembers(profiles, (p) => p.attempts);
  log(`league profiles ${season} ${side}: ${profiles.size} teams over ${rows.length} plays in ${Date.now() - t0}ms`);
  const value = { at: Date.now(), members, profiles, seq, head, rows };
  profileCache.set(key, value);
  return value;
}

function sampleFor(def: RatingDefinition, p: TeamProfile): number {
  switch (def.subject) {
    case "red_zone": return p.red_zone_attempts;
    case "third_down": return p.third_down_attempts;
    default: return p.attempts;
  }
}

export interface SubjectRateResult {
  snapshot: RatingSnapshot;
  definition: RatingDefinition;
  rank: number;
  population: number;
  league: Array<{ team: string; score: number | null; sample: number; provisional: boolean }>;
  profile: TeamProfile | null;
  stored_hash: string;
  cached: boolean;
}

export async function rateSubject(store: ChalkStore, team: string, season: number, def: RatingDefinition, log: (l: string) => void = () => {}): Promise<SubjectRateResult | null> {
  if (def.subject === "third_down") {
    const r: RateResult | null = await rateThirdDown(store, team, season, def, "offense", log);
    if (!r) return null;
    return { snapshot: r.snapshot, definition: def, rank: r.rank, population: r.population.length, league: r.league.map((l) => ({ team: l.team, score: l.score, sample: l.attempts, provisional: l.attempts < def.min_sample })), profile: null, stored_hash: r.stored_hash, cached: r.cached };
  }
  const side = def.subject === "defense" ? "defense" : "offense";
  const lp = await leagueProfilesFor(store, season, side, log);
  const profile = lp.profiles.get(team.toUpperCase());
  if (!profile) return null;
  const members = lp.members.map((m) => ({ ...m, attempts: sampleFor(def, lp.profiles.get(m.key)!) }));
  const subject = members.find((m) => m.key === team.toUpperCase())!;
  const window = { season, description: `${season} as ingested (${side})` };
  const snap = computeRating(def, subject, members, window);
  const dRow = await persistDefinition(store, def);
  const { row, cached } = await persistRating(store, snap, [dRow._hash]);
  const league = members.map((m) => { const s = computeRating(def, m, members, window); return { team: m.key, score: s.score, sample: m.attempts, provisional: s.provisional }; }).sort((x, y) => (y.score ?? -1) - (x.score ?? -1) || x.team.localeCompare(y.team));
  return { snapshot: snap, definition: def, rank: league.findIndex((l) => l.team === team.toUpperCase()) + 1, population: members.length, league, profile, stored_hash: row._hash, cached };
}

export interface RankingRow {
  rank: number;
  team: string;
  score: number | null;
  sample: number;
  provisional: boolean;
  /** rank change vs the as-known-then snapshot one week earlier (positive = moved up). */
  movement: number | null;
  previous_rank: number | null;
}

export interface Rankings {
  season: number;
  definition: { id: string; name: string; version: string; subject: string };
  population: number;
  through_week: number | null;
  rows: RankingRow[];
  risers: RankingRow[];
  fallers: RankingRow[];
  computed_at: { seq: number; head: string };
}

export async function rankings(store: ChalkStore, season: number, def: RatingDefinition, log: (l: string) => void = () => {}): Promise<Rankings> {
  const side = def.subject === "defense" ? "defense" : "offense";
  const window = { season, description: `${season} as ingested (${side})` };
  let rows: NedbRow<Play>[];
  let seq: number, head: string;
  let current: Array<{ team: string; score: number | null; sample: number; provisional: boolean }>;
  if (def.subject === "third_down") {
    const l = await leagueThirdDown(store, season, side, log);
    rows = l.plays; seq = l.seq; head = l.head;
    current = l.members.map((m) => { const s = computeRating(def, m, l.members, window); return { team: m.key, score: s.score, sample: m.attempts, provisional: s.provisional }; });
  } else {
    const lp = await leagueProfilesFor(store, season, side, log);
    rows = lp.rows; seq = lp.seq; head = lp.head;
    const members = lp.members.map((m) => ({ ...m, attempts: sampleFor(def, lp.profiles.get(m.key)!) }));
    current = members.map((m) => { const s = computeRating(def, m, members, window); return { team: m.key, score: s.score, sample: m.attempts, provisional: s.provisional }; });
  }
  const sort = (xs: typeof current) => [...xs].sort((x, y) => (y.score ?? -1) - (x.score ?? -1) || x.team.localeCompare(y.team));
  const cur = sort(current);
  // Movement: recompute as-known-then through the previous week.
  const weeks = rows.map((r) => r.data.week).filter((w): w is number => w !== null);
  const lastWeek = weeks.length ? Math.max(...weeks) : null;
  let prevRank = new Map<string, number>();
  if (lastWeek !== null && lastWeek > 1) {
    const prevRows = rows.filter((r) => r.data.week !== null && r.data.week < lastWeek);
    const games = (await store.query<Game>(`FROM ${COLL.games} WHERE season = ${season}`)).map((g) => g.data);
    let prev: typeof current;
    if (def.subject === "third_down") {
      const { analyzeThirdDown, thirdDownFilter } = await import("../engine/thirddown.ts");
      const teams = new Set(prevRows.map((r) => (side === "offense" ? r.data.posteam : r.data.defteam)).filter((t): t is string => Boolean(t)));
      const members: PopulationMember[] = [...teams].map((t) => { const a = analyzeThirdDown(prevRows, thirdDownFilter({ team: t, season, side }), { seq, head }); return { key: t, metrics: a.metrics, analysis_id: a.id, attempts: a.metrics.attempts }; }).filter((m) => m.attempts > 0);
      prev = members.map((m) => ({ team: m.key, score: computeRating(def, m, members, window).score, sample: m.attempts, provisional: false }));
    } else {
      const profiles = leagueProfiles(prevRows, season, side, games);
      const members = profileMembers(profiles, (p) => sampleFor(def, p));
      prev = members.map((m) => ({ team: m.key, score: computeRating(def, m, members, window).score, sample: m.attempts, provisional: false }));
    }
    prevRank = new Map(sort(prev).map((r, i) => [r.team, i + 1]));
  }
  const out: RankingRow[] = cur.map((r, i) => {
    const pr = prevRank.get(r.team) ?? null;
    return { rank: i + 1, team: r.team, score: r.score, sample: r.sample, provisional: r.provisional, movement: pr === null ? null : pr - (i + 1), previous_rank: pr };
  });
  const moved = out.filter((r) => r.movement !== null && r.movement !== 0);
  return {
    season,
    definition: { id: def.id, name: def.name, version: def.version, subject: def.subject },
    population: out.length,
    through_week: lastWeek,
    rows: out,
    risers: [...moved].sort((a, b) => b.movement! - a.movement!).slice(0, 3),
    fallers: [...moved].sort((a, b) => a.movement! - b.movement!).slice(0, 3),
    computed_at: { seq, head },
  };
}
