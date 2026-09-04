/**
 * League population + team rating orchestration.
 *
 * rateThirdDown(store, team, season, definition):
 *   1. one NQL fetch: every third-down play in the season (all teams)
 *   2. analyzeThirdDown per team (offense or defense side) — pure
 *   3. population = every team with >= 1 attempt; subject = the team
 *   4. computeRating; persist snapshot caused_by [subject analysis hash,
 *      definition hash] so TRACE from a rating reaches the plays.
 *
 * The per-team analyses are persisted too (idempotent by content id) so a
 * rating's population is a set of addressable, inspectable records.
 */
import { analyzeThirdDown, thirdDownFilter, THIRD_DOWN_ALGORITHM, THIRD_DOWN_VERSION, type ThirdDownAnalysis } from "../engine/thirddown.ts";
import { compileLeagueNql } from "../engine/situation.ts";
import type { Play } from "../model/football.ts";
import { COLL } from "../store/collections.ts";
import { type NedbRow } from "../store/nedb.ts";
import type { Store } from "../store/nedb.ts";
import { BUILTIN_DEFINITIONS, type RatingDefinition } from "./definitions.ts";
import { computeRating, explainDisagreement, persistDefinition, persistRating, type Disagreement, type PopulationMember, type RatingSnapshot } from "./rating.ts";

export interface LeagueThirdDown {
  season: number;
  side: "offense" | "defense";
  analyses: Map<string, ThirdDownAnalysis>;
  members: PopulationMember[];
  seq: number;
  head: string;
  plays: NedbRow<Play>[];
}

const leagueCache = new Map<string, { at: number; value: LeagueThirdDown }>();
const LEAGUE_CACHE_MS = 60_000;

export async function leagueThirdDown(store: Store, season: number, side: "offense" | "defense", log: (l: string) => void = () => {}): Promise<LeagueThirdDown> {
  const key = `${season}:${side}`;
  const hit = leagueCache.get(key);
  if (hit && Date.now() - hit.at < LEAGUE_CACHE_MS) return hit.value;
  const t0 = Date.now();
  const { rows, seq, head } = await store.queryAt<Play>(compileLeagueNql(season, 3));
  log(`league third-down population ${season}: ${rows.length} plays in ${Date.now() - t0}ms`);
  const teams = new Set<string>();
  for (const r of rows) {
    const t = side === "offense" ? r.data.posteam : r.data.defteam;
    if (t) teams.add(t);
  }
  const analyses = new Map<string, ThirdDownAnalysis>();
  const members: PopulationMember[] = [];
  for (const team of [...teams].sort()) {
    const a = analyzeThirdDown(rows, thirdDownFilter({ team, season, side }), { seq, head });
    if (a.metrics.attempts === 0) continue;
    analyses.set(team, a);
    members.push({ key: team, metrics: a.metrics, analysis_id: a.id, attempts: a.metrics.attempts });
  }
  // A single cache-miss also refreshes stored analyses; the seq/head check
  // makes this a no-op when nothing changed.
  const value: LeagueThirdDown = { season, side, analyses, members, seq, head, plays: rows };
  leagueCache.set(key, { at: Date.now(), value });
  return value;
}

export function invalidateLeagueCache(): void {
  leagueCache.clear();
}

export async function persistAnalysis(store: Store, a: ThirdDownAnalysis): Promise<NedbRow> {
  const existing = await store.get(COLL.analyses, a.id);
  if (existing) return existing;
  return store.put(COLL.analyses, a.id, a as unknown as Record<string, unknown>, {
    causedBy: a.evidence_hashes.slice(0, 2000),
    evidence: `${THIRD_DOWN_ALGORITHM}@${THIRD_DOWN_VERSION}`,
  });
}

export async function loadDefinition(store: Store, id: string): Promise<RatingDefinition | null> {
  const builtin = BUILTIN_DEFINITIONS.find((d) => d.id === id);
  if (builtin) return builtin;
  const row = await store.get<RatingDefinition>(COLL.rating_definitions, id);
  return row ? row.data : null;
}

export async function listDefinitions(store: Store): Promise<RatingDefinition[]> {
  const rows = await store.query<RatingDefinition>(`FROM ${COLL.rating_definitions}`);
  const custom = rows.map((r) => r.data).filter((d) => !BUILTIN_DEFINITIONS.some((b) => b.id === d.id));
  return [...BUILTIN_DEFINITIONS, ...custom];
}

export interface RateResult {
  snapshot: RatingSnapshot;
  analysis: ThirdDownAnalysis;
  definition: RatingDefinition;
  population: PopulationMember[];
  /** Rank 1..N by score within the population under this definition. */
  rank: number;
  league: Array<{ team: string; score: number | null; attempts: number }>;
  cached: boolean;
  stored_hash: string;
}

export async function rateThirdDown(
  store: Store,
  team: string,
  season: number,
  def: RatingDefinition,
  side: "offense" | "defense" = "offense",
  log: (l: string) => void = () => {},
): Promise<RateResult | null> {
  const league = await leagueThirdDown(store, season, side, log);
  const subjectAnalysis = league.analyses.get(team.toUpperCase());
  if (!subjectAnalysis) return null;
  const window = { season, description: `${season} regular + post season as ingested` };
  const subject = league.members.find((m) => m.key === team.toUpperCase())!;
  const snap = computeRating(def, subject, league.members, window);

  // Persist the subject analysis + definition so the rating has hashes to cite.
  const [aRow, dRow] = await Promise.all([persistAnalysis(store, subjectAnalysis), persistDefinition(store, def)]);
  const { row, cached } = await persistRating(store, snap, [aRow._hash, dRow._hash]);

  const leagueScores = league.members.map((m) => ({
    team: m.key,
    score: computeRating(def, m, league.members, window).score,
    attempts: m.attempts,
  }));
  leagueScores.sort((x, y) => (y.score ?? -1) - (x.score ?? -1) || x.team.localeCompare(y.team));
  const rank = leagueScores.findIndex((l) => l.team === team.toUpperCase()) + 1;
  return { snapshot: snap, analysis: subjectAnalysis, definition: def, population: league.members, rank, league: leagueScores, cached, stored_hash: row._hash };
}

export async function compareDefinitions(
  store: Store,
  team: string,
  season: number,
  a: RatingDefinition,
  b: RatingDefinition,
  side: "offense" | "defense" = "offense",
): Promise<{ a: RateResult; b: RateResult; disagreement: Disagreement } | null> {
  const ra = await rateThirdDown(store, team, season, a, side);
  const rb = await rateThirdDown(store, team, season, b, side);
  if (!ra || !rb) return null;
  return { a: ra, b: rb, disagreement: explainDisagreement(ra.snapshot, rb.snapshot) };
}
