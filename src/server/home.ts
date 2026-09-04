/**
 * Home composite — everything the Fan-mode home screen needs in one call, all
 * deterministic, all traceable: rating, trend, badges, recent form, last game
 * with deviation, next game with opponent snapshot, weakest situations.
 */
import { analyzeDeviation, type Deviation } from "../engine/deviation.ts";
import { compileNql, type SituationFilter } from "../engine/situation.ts";
import { scanSituations } from "../engine/scan.ts";
import { runThirdDown, summarizeThirdDown } from "../engine/thirddown.ts";
import { recentForm, thirdDownTrend, type Trend, type RecentForm } from "../engine/trend.ts";
import { computeMetrics, round } from "../engine/metrics.ts";
import type { PlayContext } from "../ingest/context.ts";
import { PLAY_CONTEXT } from "../ingest/context.ts";
import { GAME_STATE, type GameStateDoc } from "../ingest/pulse.ts";
import type { Game, Play } from "../model/football.ts";
import { evaluateBadges, type BadgePopulationMember, type EarnedBadge } from "../rating/badges.ts";
import { THIRD_DOWN_DEFAULT_V1, type RatingDefinition } from "../rating/definitions.ts";
import { leagueThirdDown, rateThirdDown, type RateResult } from "../rating/league.ts";
import { COLL } from "../store/collections.ts";
import { ChalkStore, nqlStr, type NedbRow } from "../store/nedb.ts";
import { summarizeRating } from "./intents.ts";

export function baseFilter(team: string, season: number, side: "offense" | "defense" = "offense"): SituationFilter {
  return { team, side, season, snaps_only: true, exclude_kneels: true, exclude_spikes: true, exclude_no_play: true, exclude_penalties: false, exclude_garbage_time: false };
}

/** All context rows (cached by the store's NQL cache); filtered in memory. */
export async function loadContext(store: ChalkStore, gameIds?: Set<string>): Promise<Map<string, PlayContext>> {
  const rows = await store.query<PlayContext>(`FROM ${PLAY_CONTEXT}`);
  const m = new Map<string, PlayContext>();
  for (const r of rows) if (!gameIds || gameIds.has(r.data.game_id)) m.set(r.data.id, r.data);
  return m;
}

export async function leagueBadgePopulation(store: ChalkStore, season: number, side: "offense" | "defense", log: (l: string) => void): Promise<BadgePopulationMember[]> {
  const league = await leagueThirdDown(store, season, side, log);
  const all = await store.queryAt<Play>(`FROM ${COLL.plays} WHERE season = ${season}`);
  const teamField = side === "offense" ? "posteam" : "defteam";
  const byTeam = new Map<string, Play[]>();
  for (const r of all.rows) {
    const p = r.data;
    if (!p.is_snap || p.is_no_play) continue;
    const t = p[teamField];
    if (!t) continue;
    (byTeam.get(t) ?? byTeam.set(t, []).get(t)!).push(p);
  }
  return [...byTeam.keys()].sort().map((key) => ({
    key,
    third_down: league.analyses.get(key)?.metrics ?? null,
    all_snaps: computeMetrics(byTeam.get(key)!),
  }));
}

export interface HomePayload {
  team: string;
  season: number;
  rating: ReturnType<typeof summarizeRating> | null;
  rating_snapshot_id: string | null;
  trend: Trend | null;
  badges: EarnedBadge[];
  form: RecentForm | null;
  last_game: { game: Game; third_down: ReturnType<typeof summarizeThirdDown>; deviation: Deviation | null; team_line: string } | null;
  next_game: { game: Game | null; pulse: GameStateDoc | null; opponent: string | null; opponent_rating: ReturnType<typeof summarizeRating> | null } | null;
  weakest: Array<{ situation: string; snaps: number; epa_per_play: number | null; epa_vs_team: number | null }>;
  strongest: Array<{ situation: string; snaps: number; epa_per_play: number | null; epa_vs_team: number | null }>;
  context_coverage: { plays: number; with_context: number } | null;
  computed_at: { seq: number; head: string };
}

export async function buildHome(store: ChalkStore, team: string, season: number, def: RatingDefinition = THIRD_DOWN_DEFAULT_V1, log: (l: string) => void = () => {}): Promise<HomePayload> {
  const t0 = Date.now();
  const league = await leagueThirdDown(store, season, "offense", log);
  const rating: RateResult | null = await rateThirdDown(store, team, season, def, "offense", log);
  const trend = league.plays.length ? thirdDownTrend(league.plays, team, season, def, { seq: league.seq, head: league.head }) : null;
  const badgePop = await leagueBadgePopulation(store, season, "offense", log);
  const badges = evaluateBadges(team, badgePop);

  const f = baseFilter(team, season);
  const { rows: teamRows, seq, head } = await store.queryAt<Play>(compileNql(f));
  const teamPlays = teamRows.map((r) => r.data);
  const form = teamPlays.length ? recentForm(teamPlays, f, 4) : null;
  const scan = teamPlays.length ? scanSituations(teamRows, f, { seq, head }) : null;

  // Games for the team this season (played + scheduled).
  const games = (await store.query<Game>(`FROM ${COLL.games} WHERE season = ${season}`)).map((g) => g.data).filter((g) => g.home_team === team || g.away_team === team);
  const played = games.filter((g) => g.home_score !== null).sort((a, b) => (b.week ?? 0) - (a.week ?? 0));
  const lastGame = played[0] ?? null;
  let last_game: HomePayload["last_game"] = null;
  if (lastGame) {
    const third = await runThirdDown(store, { team, game_id: lastGame.id }, { log });
    const dev = analyzeDeviation(teamRows, f, lastGame.id, { seq, head });
    const us = lastGame.home_team === team ? lastGame.home_score : lastGame.away_score;
    const them = lastGame.home_team === team ? lastGame.away_score : lastGame.home_score;
    const opp = lastGame.home_team === team ? lastGame.away_team : lastGame.home_team;
    const wl = lastGame.winner === team ? "W" : lastGame.winner === null ? "T" : "L";
    last_game = { game: lastGame, third_down: summarizeThirdDown(third.analysis), deviation: dev, team_line: `${wl} ${us}–${them} ${lastGame.home_team === team ? "vs" : "@"} ${opp}` };
  }

  // Next game: from the knowledge layer (any season with a later gameday and no score) or from pulse.
  const upcoming = (await store.query<Game>(`FROM ${COLL.games}`)).map((g) => g.data).filter((g) => (g.home_team === team || g.away_team === team) && g.home_score === null && g.gameday && Date.parse(g.gameday) >= Date.now() - 86400e3).sort((a, b) => (a.gameday ?? "").localeCompare(b.gameday ?? ""));
  const pulseRows = (await store.query<GameStateDoc>(`FROM ${GAME_STATE}`)).map((r) => r.data).filter((s) => (s.home_team === team || s.away_team === team) && s.phase !== "final").sort((a, b) => (a.kickoff ?? "").localeCompare(b.kickoff ?? ""));
  const nextGame = upcoming[0] ?? null;
  const pulse = pulseRows[0] ?? null;
  const opponent = nextGame ? (nextGame.home_team === team ? nextGame.away_team : nextGame.home_team) : pulse ? (pulse.home_team === team ? pulse.away_team : pulse.home_team) : null;
  let opponent_rating: ReturnType<typeof summarizeRating> | null = null;
  if (opponent) {
    const or = await rateThirdDown(store, opponent, season, def, "offense", log);
    opponent_rating = or ? summarizeRating(or) : null;
  }

  let context_coverage: HomePayload["context_coverage"] = null;
  try {
    const ctx = await loadContext(store, new Set(teamPlays.map((p) => p.game_id)));
    context_coverage = { plays: teamPlays.length, with_context: teamPlays.filter((p) => ctx.has(p.id)).length };
  } catch (e) {
    log(`home: context coverage unavailable: ${(e as Error).message}`);
  }

  const fmt = (b: NonNullable<typeof scan>["weakest"][number]) => ({ situation: b.label, snaps: b.metrics.attempts, epa_per_play: round(b.metrics.epa_per_play, 3), epa_vs_team: round(b.epa_delta_vs_team, 3) });
  log(`home ${team} ${season} built in ${Date.now() - t0}ms`);
  return {
    team,
    season,
    rating: rating ? summarizeRating(rating) : null,
    rating_snapshot_id: rating?.snapshot.id ?? null,
    trend,
    badges,
    form,
    last_game,
    next_game: nextGame || pulse ? { game: nextGame, pulse, opponent, opponent_rating } : null,
    weakest: scan ? scan.weakest.slice(0, 3).map(fmt) : [],
    strongest: scan ? scan.strongest.slice(0, 3).map(fmt) : [],
    context_coverage,
    computed_at: { seq, head },
  };
}

export async function nextOpponent(store: ChalkStore, team: string): Promise<string | null> {
  const games = (await store.query<Game>(`FROM ${COLL.games}`)).map((g) => g.data).filter((g) => (g.home_team === team || g.away_team === team) && g.home_score === null && g.gameday && Date.parse(g.gameday) >= Date.now() - 86400e3).sort((a, b) => (a.gameday ?? "").localeCompare(b.gameday ?? ""));
  const g = games[0];
  if (g) return g.home_team === team ? g.away_team : g.home_team;
  const pulse = (await store.query<GameStateDoc>(`FROM ${GAME_STATE}`)).map((r) => r.data).filter((s) => (s.home_team === team || s.away_team === team) && s.phase !== "final").sort((a, b) => (a.kickoff ?? "").localeCompare(b.kickoff ?? ""))[0];
  return pulse ? (pulse.home_team === team ? pulse.away_team : pulse.home_team) : null;
}

/** Plays for a team-season with their context rows joined, for tendency/opponent intents. */
export async function loadTeamPlaysWithContext(store: ChalkStore, f: SituationFilter): Promise<{ rows: NedbRow<Play>[]; ctx: Map<string, PlayContext>; seq: number; head: string }> {
  const { rows, seq, head } = await store.queryAt<Play>(compileNql(f));
  const games = new Set(rows.map((r) => r.data.game_id));
  const ctx = await loadContext(store, games);
  return { rows, ctx, seq, head };
}

export { nqlStr };
