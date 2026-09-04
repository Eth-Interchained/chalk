/**
 * CHALK HTTP server — open JSON API + SSE ask loop + static client.
 *
 * Zero web framework: node:http. Every route is listed in openapi.ts.
 * Every /ask is logged to football_query_events with plan, latency, evidence
 * counts and errors (V3 §39).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scanSituations } from "../engine/scan.ts";
import { compileNql, validateFilter } from "../engine/situation.ts";
import { analyzeTendency, baselineFilter } from "../engine/tendency.ts";
import { compare } from "../engine/comparison.ts";
import { runThirdDown, summarizeThirdDown } from "../engine/thirddown.ts";
import { explain, deterministicFallback, type EvidencePackage } from "../llm/explain.ts";
import { llmConfigFromEnv, type LlmConfig } from "../llm/client.ts";
import { planQuestion, type PlanContext, type QueryPlan } from "../llm/planner.ts";
import type { Game, Play } from "../model/football.ts";
import { BUILTIN_DEFINITIONS, CARD_SUBJECTS, OFFENSE_DEFAULT_V1, THIRD_DOWN_DEFAULT_V1, validateDefinition } from "../rating/definitions.ts";
import { invalidateProfileCache, rankings, rateSubject } from "../rating/rank.ts";
import { invalidateLeagueCache } from "../rating/league.ts";
import { compareDefinitions, leagueThirdDown, listDefinitions, loadDefinition, rateThirdDown } from "../rating/league.ts";
import { computeRating, persistDefinition } from "../rating/rating.ts";
import { LICENSING } from "../source/licensing.ts";
import { COLL } from "../store/collections.ts";
import { deterministicId } from "../store/hash.ts";
import { ChalkStore, NedbError, nqlStr, type NedbRow } from "../store/nedb.ts";
import { GAME_STATE, PULSE_EVENTS, type GameStateDoc } from "../ingest/pulse.ts";
import type { RawDoc } from "../ingest/ingest.ts";
import { execute, summarizeRating } from "./intents.ts";
import { openapiDocument } from "./openapi.ts";
import { baseFilter, buildHome, leagueBadgePopulation, loadTeamPlaysWithContext, nextOpponent } from "./home.ts";
import { thirdDownTrend } from "../engine/trend.ts";
import { evaluateBadges, BADGE_DEFINITIONS } from "../rating/badges.ts";
import { opponentReport, summarizeOpponentReport } from "../engine/opponent.ts";
import { analyzeDeviation } from "../engine/deviation.ts";

export interface ServerOptions {
  store: ChalkStore;
  host: string;
  port: number;
  log: (l: string) => void;
  llm?: LlmConfig | null;
  webDir?: string;
  defaultTeam?: string;
  defaultSeason?: number;
}

class HttpError extends Error {
  readonly status: number;
  readonly extra?: unknown;
  constructor(status: number, message: string, extra?: unknown) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json", ".webmanifest": "application/manifest+json", ".ico": "image/x-icon" };

export async function startServer(opts: ServerOptions): Promise<Server> {
  const { store, log } = opts;
  const llm = opts.llm === undefined ? llmConfigFromEnv() : opts.llm;
  // Read-through NQL cache (see ChalkStore.cacheTtlMs). Writes from this
  // process (analyses, ratings, observations) never change the play/game
  // tables, so a short TTL is safe; ingest runs in another process and lands
  // within one TTL. Env CHALK_QUERY_CACHE_MS=0 disables.
  store.cacheTtlMs = Number(process.env.CHALK_QUERY_CACHE_MS ?? 90_000);
  store.onCacheHit = (i) => log(`nql cache hit (${i.rows} rows, ${(i.ageMs / 1000).toFixed(0)}s old): ${i.nql.slice(0, 90)}`);
  const webDir = opts.webDir ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web");
  const defaultTeam = opts.defaultTeam ?? process.env.CHALK_DEFAULT_TEAM ?? "TB";
  let defaultSeason = opts.defaultSeason ?? (process.env.CHALK_DEFAULT_SEASON ? Number(process.env.CHALK_DEFAULT_SEASON) : 0);
  let teamsCache: { at: number; teams: string[]; seasons: number[] } | null = null;

  async function meta(): Promise<{ teams: string[]; seasons: number[] }> {
    if (teamsCache && Date.now() - teamsCache.at < 60_000) return teamsCache;
    const rows = await store.query<Game>(`FROM ${COLL.games}`);
    const teams = new Set<string>();
    const seasons = new Set<number>();
    for (const r of rows) {
      if (r.data.home_team) teams.add(r.data.home_team);
      if (r.data.away_team) teams.add(r.data.away_team);
      // A season is selectable once it has at least one played game; a bare
      // schedule (2026 before kickoff) stays out of the picker.
      if (r.data.season !== null && r.data.home_score !== null) seasons.add(r.data.season);
    }
    teamsCache = { at: Date.now(), teams: [...teams].sort(), seasons: [...seasons].sort((a, b) => b - a) };
    if (!defaultSeason && teamsCache.seasons.length) defaultSeason = teamsCache.seasons[0];
    return teamsCache;
  }

  const server = createServer(async (req, res) => {
    const started = Date.now();
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-headers", "content-type");
    res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
    try {
      if (url.pathname.startsWith("/api/")) {
        await api(req, res, url);
      } else {
        await serveStatic(res, url.pathname);
      }
    } catch (e) {
      const status = e instanceof HttpError ? e.status : e instanceof NedbError ? 502 : 500;
      const message = (e as Error).message;
      if (status >= 500) log(`${req.method} ${url.pathname} -> ${status} ${message}`);
      if (!res.headersSent) json(res, status, { error: message, status, ...(e instanceof HttpError && e.extra ? { detail: e.extra } : {}) });
      else res.end();
    } finally {
      const ms = Date.now() - started;
      if (url.pathname.startsWith("/api/")) log(`${req.method} ${url.pathname}${url.search} ${res.statusCode} ${ms}ms`);
    }
  });

  // ------------------------------------------------------------------ routes

  async function api(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const p = url.pathname;
    const q = url.searchParams;
    const m = req.method ?? "GET";

    if (p === "/api/v1/health" && m === "GET") {
      const [health, seq, head] = await Promise.all([store.health().catch((e) => ({ ok: false, error: (e as Error).message })), store.seq().catch(() => null), store.head().catch(() => null)]);
      return json(res, 200, { chalk: "ok", version: "0.3.0", nedb: { url: store.url, db: store.db, ...health, seq, head }, llm: llm ? { url: llm.url, model: llm.model, provider: llm.provider, has_key: Boolean(llm.key) } : null, defaults: { team: defaultTeam, season: defaultSeason || null } });
    }
    if (p === "/api/v1/openapi.json") return json(res, 200, openapiDocument(`${url.protocol}//${url.host}`));
    if (p === "/api/v1/meta") {
      const mt = await meta();
      const defs = await listDefinitions(store);
      return json(res, 200, { teams: mt.teams, seasons: mt.seasons, defaults: { team: defaultTeam, season: defaultSeason || null }, rating_definitions: defs.map((d) => ({ id: d.id, name: d.name, version: d.version, components: d.components })), licensing: LICENSING, suggested_questions: SUGGESTED });
    }
    if (p === "/api/v1/teams") return json(res, 200, { teams: (await meta()).teams });
    if (p === "/api/v1/verify") return json(res, 200, await store.verify());

    if (p === "/api/v1/games" && m === "GET") {
      const where: string[] = [];
      if (q.get("season")) where.push(`season = ${Number(q.get("season"))}`);
      if (q.get("week")) where.push(`week = ${Number(q.get("week"))}`);
      let rows = await store.query<Game>(`FROM ${COLL.games}${where.length ? ` WHERE ${where.join(" AND ")}` : ""}`);
      const team = q.get("team")?.toUpperCase();
      if (team) rows = rows.filter((r) => r.data.home_team === team || r.data.away_team === team);
      rows.sort((a, b) => (a.data.season ?? 0) - (b.data.season ?? 0) || (a.data.week ?? 0) - (b.data.week ?? 0) || a._id.localeCompare(b._id));
      return json(res, 200, { count: rows.length, games: rows.map((r) => ({ ...r.data, _hash: r._hash })) });
    }
    let mm: RegExpMatchArray | null;
    if ((mm = p.match(/^\/api\/v1\/games\/([^/]+)$/)) && m === "GET") {
      const id = decodeURIComponent(mm[1]);
      const g = await store.get<Game>(COLL.games, id);
      if (!g) throw new HttpError(404, `game ${id} not ingested`);
      const teams = [g.data.home_team, g.data.away_team].filter((t): t is string => Boolean(t));
      const third = await Promise.all(teams.map((t) => runThirdDown(store, { team: t, game_id: id }, { log })));
      const pulse = await store.query<GameStateDoc>(`FROM ${GAME_STATE} WHERE game_id = ${nqlStr(id)}`);
      const deviations = g.data.season === null ? [] : await Promise.all(teams.map(async (t) => {
        const f = baseFilter(t, g.data.season!);
        const { rows, seq, head } = await store.queryAt<Play>(compileNql(f));
        const d = analyzeDeviation(rows, f, id, { seq, head });
        return { team: t, level: d.level, driver: d.driver, headline: d.headline, lines: d.lines, id: d.id };
      }));
      return json(res, 200, { game: g.data, _hash: g._hash, third_down: third.map((t) => ({ team: t.analysis.filter.team, analysis_id: t.analysis.id, summary: summarizeThirdDown(t.analysis) })), deviations, pulse: pulse.map((r) => r.data) });
    }
    if ((mm = p.match(/^\/api\/v1\/games\/([^/]+)\/plays$/)) && m === "GET") {
      const id = decodeURIComponent(mm[1]);
      let rows = await store.query<Play>(`FROM ${COLL.plays} WHERE game_id = ${nqlStr(id)}`);
      const team = q.get("team")?.toUpperCase();
      if (team) rows = rows.filter((r) => r.data.posteam === team);
      if (q.get("down")) rows = rows.filter((r) => r.data.down === Number(q.get("down")));
      rows.sort((a, b) => a.data.play_id - b.data.play_id);
      return json(res, 200, { count: rows.length, plays: rows.map((r) => ({ ...r.data, _hash: r._hash })) });
    }
    if ((mm = p.match(/^\/api\/v1\/plays\/([^/]+)$/)) && m === "GET") {
      const id = decodeURIComponent(mm[1]);
      const play = await store.get<Play>(COLL.plays, id);
      if (!play) throw new HttpError(404, `play ${id} not ingested`);
      const raws = await store.query<RawDoc>(`FROM ${COLL.raw_plays} WHERE source_record_id_game = ${nqlStr(play.data.game_id)}`);
      const raw = raws.find((r) => r._hash === play.data.derived_from?.[0]) ?? null;
      const lineage = await store.trace(COLL.plays, id);
      return json(res, 200, { play: play.data, _hash: play._hash, _seq: play._seq, raw: raw ? { _hash: raw._hash, ...raw.data } : null, lineage: lineage.map((r) => ({ _coll: r._coll, _id: r._id, _hash: r._hash, _seq: r._seq, _caused_by: r._caused_by ?? [] })) });
    }

    if (p === "/api/v1/analyses/third-down" && m === "GET") {
      const team = need(q, "team").toUpperCase();
      const season = q.get("season") ? Number(q.get("season")) : undefined;
      const game_id = q.get("game_id") ?? undefined;
      if (season === undefined && !game_id) throw new HttpError(400, "season or game_id required");
      const r = await runThirdDown(store, { team, season, game_id, side: (q.get("side") as "offense" | "defense") ?? "offense", opponent: q.get("opponent") ?? undefined, exclude_garbage_time: q.get("exclude_garbage_time") === "true", exclude_penalties: q.get("exclude_penalties") === "true", week_min: q.get("week_min") ? Number(q.get("week_min")) : undefined, week_max: q.get("week_max") ? Number(q.get("week_max")) : undefined }, { log });
      return json(res, 200, { id: r.analysis.id, cached: r.cached, _hash: r.stored?._hash ?? null, nql: r.nql, summary: summarizeThirdDown(r.analysis), analysis: r.analysis });
    }
    if (p === "/api/v1/analyses/scan" && m === "GET") {
      const v = validateFilter({ team: need(q, "team"), season: q.get("season") ? Number(q.get("season")) : undefined, game_id: q.get("game_id") ?? undefined, side: q.get("side") ?? "offense" });
      if (!v.ok) throw new HttpError(400, v.errors.join("; "));
      const { rows, seq, head } = await store.queryAt<Play>(compileNql(v.filter!));
      let league: NedbRow<Play>[] | undefined;
      if (q.get("league") === "true" && v.filter!.season !== undefined) league = (await store.queryAt<Play>(`FROM ${COLL.plays} WHERE season = ${v.filter!.season}`)).rows;
      const scan = scanSituations(rows, v.filter!, { seq, head }, league);
      return json(res, 200, { ...scan, buckets: scan.buckets.map((b) => ({ ...b, evidence: b.evidence.slice(0, 200), evidence_count: b.evidence.length })), weakest: scan.weakest.map((b) => ({ ...b, evidence: b.evidence.slice(0, 200) })), strongest: scan.strongest.map((b) => ({ ...b, evidence: b.evidence.slice(0, 200) })) });
    }
    if ((mm = p.match(/^\/api\/v1\/analyses\/([^/]+)\/evidence$/)) && m === "GET") {
      const a = await store.get<{ evidence?: string[]; a?: { evidence: string[] }; b?: { evidence: string[] } }>(COLL.analyses, decodeURIComponent(mm[1])) ?? await store.get<{ evidence?: string[] }>(COLL.tendencies, decodeURIComponent(mm[1])) ?? await store.get<{ a?: { evidence: string[] }; b?: { evidence: string[] } }>(COLL.comparisons, decodeURIComponent(mm[1]));
      if (!a) throw new HttpError(404, "analysis not found");
      const ids = (a.data as { evidence?: string[] }).evidence ?? [...((a.data as { a?: { evidence: string[] } }).a?.evidence ?? []), ...((a.data as { b?: { evidence: string[] } }).b?.evidence ?? [])];
      const plays = await loadPlays(ids);
      return json(res, 200, { id: a._id, count: plays.length, plays });
    }
    if ((mm = p.match(/^\/api\/v1\/analyses\/([^/]+)$/)) && m === "GET") {
      const id = decodeURIComponent(mm[1]);
      const row = (await store.get(COLL.analyses, id)) ?? (await store.get(COLL.tendencies, id)) ?? (await store.get(COLL.comparisons, id));
      if (!row) throw new HttpError(404, "analysis not found");
      return json(res, 200, { _id: row._id, _hash: row._hash, _seq: row._seq, _coll: row._coll, ...row.data });
    }

    if (p === "/api/v1/tendencies" && m === "POST") {
      const body = await readJson(req);
      const v = validateFilter(body);
      if (!v.ok) throw new HttpError(400, "invalid filter", v.errors);
      const { rows, seq, head } = await store.queryAt<Play>(compileNql(baselineFilter(v.filter!)));
      const t = analyzeTendency(rows, v.filter!, { seq, head });
      const existing = await store.get(COLL.tendencies, t.id);
      const stored = existing ?? (await store.put(COLL.tendencies, t.id, t as unknown as Record<string, unknown>, { causedBy: t.evidence_hashes.slice(0, 2000), evidence: `tendency@${t.algorithm_version}` }));
      return json(res, 200, { ...t, _hash: stored._hash, cached: Boolean(existing), unknown_keys: v.unknown_keys });
    }
    if (p === "/api/v1/comparisons" && m === "POST") {
      const body = (await readJson(req)) as { a?: unknown; b?: unknown };
      const va = validateFilter(body.a);
      const vb = validateFilter(body.b);
      if (!va.ok || !vb.ok) throw new HttpError(400, "invalid filters", { a: va.errors, b: vb.errors });
      const ra = await store.queryAt<Play>(compileNql(va.filter!));
      const rb = await store.queryAt<Play>(compileNql(vb.filter!));
      const seen = new Set<string>();
      const union = [...ra.rows, ...rb.rows].filter((r) => (seen.has(r._id) ? false : (seen.add(r._id), true)));
      const c = compare(union, va.filter!, vb.filter!, { seq: Math.max(ra.seq, rb.seq), head: rb.head });
      const existing = await store.get(COLL.comparisons, c.id);
      const stored = existing ?? (await store.put(COLL.comparisons, c.id, c as unknown as Record<string, unknown>, { evidence: `comparison@${c.algorithm_version}` }));
      return json(res, 200, { ...c, _hash: stored._hash, cached: Boolean(existing) });
    }

    if (p === "/api/v1/ratings/third-down" && m === "GET") {
      const team = need(q, "team").toUpperCase();
      const season = Number(q.get("season") ?? defaultSeason);
      const def = (await loadDefinition(store, q.get("definition") ?? THIRD_DOWN_DEFAULT_V1.id));
      if (!def) throw new HttpError(404, `unknown rating definition ${q.get("definition")}`);
      const r = await rateThirdDown(store, team, season, def, (q.get("side") as "offense" | "defense") ?? "offense", log);
      if (!r) throw new HttpError(404, `no third-down data for ${team} ${season}`);
      return json(res, 200, { summary: summarizeRating(r), snapshot: r.snapshot, definition: def, rank: r.rank, league: r.league, analysis_id: r.analysis.id, _hash: r.stored_hash, cached: r.cached });
    }
    if (p === "/api/v1/ratings/third-down/league" && m === "GET") {
      const season = Number(q.get("season") ?? defaultSeason);
      const def = (await loadDefinition(store, q.get("definition") ?? THIRD_DOWN_DEFAULT_V1.id));
      if (!def) throw new HttpError(404, "unknown rating definition");
      const l = await leagueThirdDown(store, season, (q.get("side") as "offense" | "defense") ?? "offense", log);
      const window = { season, description: `${season} as ingested` };
      const table = l.members.map((mem) => {
        const s = computeRating(def, mem, l.members, window);
        const a = l.analyses.get(mem.key)!;
        return { team: mem.key, score: s.score, attempts: mem.attempts, conversion_pct: a.metrics.conversion_rate === null ? null : Math.round(a.metrics.conversion_rate * 1000) / 10, epa_per_play: a.metrics.epa_per_play === null ? null : Math.round(a.metrics.epa_per_play * 1000) / 1000, success_pct: a.metrics.success_rate === null ? null : Math.round(a.metrics.success_rate * 1000) / 10, provisional: s.provisional, analysis_id: a.id };
      }).sort((x, y) => (y.score ?? -1) - (x.score ?? -1) || x.team.localeCompare(y.team)).map((row, i) => ({ rank: i + 1, ...row }));
      return json(res, 200, { season, definition: { id: def.id, name: def.name, version: def.version }, population: l.members.length, seq: l.seq, head: l.head, table });
    }
    if (p === "/api/v1/ratings/compare" && m === "GET") {
      const team = need(q, "team").toUpperCase();
      const season = Number(q.get("season") ?? defaultSeason);
      const a = await loadDefinition(store, need(q, "a"));
      const b = await loadDefinition(store, need(q, "b"));
      if (!a || !b) throw new HttpError(404, "unknown rating definition");
      const r = await compareDefinitions(store, team, season, a, b, (q.get("side") as "offense" | "defense") ?? "offense");
      if (!r) throw new HttpError(404, `no third-down data for ${team} ${season}`);
      return json(res, 200, { disagreement: r.disagreement, a: { summary: summarizeRating(r.a), snapshot: r.a.snapshot }, b: { summary: summarizeRating(r.b), snapshot: r.b.snapshot } });
    }
    if (p === "/api/v1/rankings" && m === "GET") {
      const season = Number(q.get("season") ?? defaultSeason);
      const def = (await loadDefinition(store, q.get("definition") ?? OFFENSE_DEFAULT_V1.id));
      if (!def) throw new HttpError(404, "unknown rating definition");
      return json(res, 200, await rankings(store, season, def, log));
    }
    if ((mm = p.match(/^\/api\/v1\/ratings\/(offense|defense|red-zone|red_zone|explosiveness|ball-security|ball_security)$/)) && m === "GET") {
      const subject = mm[1].replace("-", "_");
      const team = need(q, "team").toUpperCase();
      const season = Number(q.get("season") ?? defaultSeason);
      const def = (await loadDefinition(store, q.get("definition") ?? CARD_SUBJECTS.find((c) => c.subject === subject)!.definition.id));
      if (!def) throw new HttpError(404, "unknown rating definition");
      if (def.subject !== subject) throw new HttpError(400, `definition ${def.id} is for subject ${def.subject}, not ${subject}`);
      const r = await rateSubject(store, team, season, def, log);
      if (!r) throw new HttpError(404, `no ${season} data for ${team}`);
      return json(res, 200, { subject, snapshot: r.snapshot, definition: def, rank: r.rank, population: r.population, league: r.league, profile: r.profile, _hash: r.stored_hash, cached: r.cached });
    }
    if (p === "/api/v1/ratings/third-down/trend" && m === "GET") {
      const team = need(q, "team").toUpperCase();
      const season = Number(q.get("season") ?? defaultSeason);
      const def = (await loadDefinition(store, q.get("definition") ?? THIRD_DOWN_DEFAULT_V1.id));
      if (!def) throw new HttpError(404, "unknown rating definition");
      const l = await leagueThirdDown(store, season, (q.get("side") as "offense" | "defense") ?? "offense", log);
      const t = thirdDownTrend(l.plays, team, season, def, { seq: l.seq, head: l.head }, (q.get("side") as "offense" | "defense") ?? "offense");
      return json(res, 200, t);
    }
    if (p === "/api/v1/badges" && m === "GET") {
      const team = need(q, "team").toUpperCase();
      const season = Number(q.get("season") ?? defaultSeason);
      const pop = await leagueBadgePopulation(store, season, "offense", log);
      return json(res, 200, { team, season, badges: evaluateBadges(team, pop), definitions: BADGE_DEFINITIONS, population: pop.length });
    }
    if (p === "/api/v1/reports/opponent" && m === "GET") {
      const team = need(q, "team").toUpperCase();
      const opponent = (q.get("opponent") ?? (await nextOpponent(store, team)))?.toUpperCase();
      if (!opponent) throw new HttpError(400, "opponent required (no upcoming game found to infer it)");
      const season = Number(q.get("season") ?? defaultSeason);
      const side = (q.get("side") as "offense" | "defense") ?? "offense";
      const f = baseFilter(opponent, season, side);
      const { rows, ctx, seq, head } = await loadTeamPlaysWithContext(store, f);
      const r = opponentReport(team, rows, f, ctx, { seq, head });
      return json(res, 200, { summary: summarizeOpponentReport(r), statements: r.statements, id: r.id, evidence_count: r.evidence.length, context_rows: ctx.size });
    }
    if ((mm = p.match(/^\/api\/v1\/teams\/([A-Za-z]{2,3})\/home$/)) && m === "GET") {
      const team = mm[1].toUpperCase();
      const season = Number(q.get("season") ?? defaultSeason);
      const def = (await loadDefinition(store, q.get("definition") ?? THIRD_DOWN_DEFAULT_V1.id)) ?? THIRD_DOWN_DEFAULT_V1;
      return json(res, 200, await buildHome(store, team, season, def, log));
    }
    if (p === "/api/v1/rating-definitions" && m === "GET") return json(res, 200, { definitions: await listDefinitions(store), rateable_metrics: (await import("../rating/definitions.ts")).RATEABLE_METRICS });
    if (p === "/api/v1/rating-definitions" && m === "POST") {
      const body = await readJson(req);
      const v = validateDefinition(body);
      if (!v.ok) throw new HttpError(400, "invalid rating definition", v.errors);
      if (BUILTIN_DEFINITIONS.some((d) => d.id === v.definition!.id)) throw new HttpError(409, "id collides with a built-in definition");
      const row = await persistDefinition(store, v.definition!);
      return json(res, 201, { definition: v.definition, _hash: row._hash });
    }

    if (p === "/api/v1/plan" && m === "POST") {
      const body = (await readJson(req)) as { question?: string; team?: string; season?: number; game_id?: string; play_id?: string };
      if (!body.question) throw new HttpError(400, "question required");
      const ctx = await planContext(body);
      const out = await planQuestion(body.question, ctx, llm, store, log);
      return json(res, out.ok ? 200 : 422, out);
    }
    if (p === "/api/v1/ask" && m === "POST") return ask(req, res);

    if ((mm = p.match(/^\/api\/v1\/observations\/([^/]+)$/)) && m === "GET") {
      const row = await store.get(COLL.observations, decodeURIComponent(mm[1]));
      if (!row) throw new HttpError(404, "observation not found");
      return json(res, 200, { _id: row._id, _hash: row._hash, _seq: row._seq, ...row.data });
    }
    if ((mm = p.match(/^\/api\/v1\/provenance\/([^/]+)\/([^/]+)$/)) && m === "GET") {
      const coll = decodeURIComponent(mm[1]);
      const id = decodeURIComponent(mm[2]);
      if (!/^football_[a-z_]+$/.test(coll)) throw new HttpError(400, "collection must be a football_* collection");
      const rows = await store.trace(coll, id);
      if (!rows.length) throw new HttpError(404, "record not found");
      const byHash = new Map(rows.map((r) => [r._hash, r]));
      const nodes = rows.map((r) => ({ _coll: r._coll, _id: r._id, _hash: r._hash, _seq: r._seq, _caused_by: r._caused_by ?? [], label: labelFor(r) }));
      const edges = rows.flatMap((r) => (r._caused_by ?? []).filter((h) => byHash.has(h)).map((h) => ({ from: r._hash, to: h })));
      const root = rows.find((r) => r._id === id && r._coll === coll) ?? rows[0];
      const depth = (h: string, seen = new Set<string>()): number => { if (seen.has(h)) return 0; seen.add(h); const n = byHash.get(h); return n ? 1 + Math.max(0, ...(n._caused_by ?? []).filter((x) => byHash.has(x)).map((x) => depth(x, seen))) : 0; };
      return json(res, 200, { root: { _coll: root._coll, _id: root._id, _hash: root._hash }, node_count: nodes.length, edge_count: edges.length, depth: depth(root._hash), collections: countBy(rows.map((r) => r._coll)), nodes, edges, records: rows.slice(0, 50).map((r) => ({ _coll: r._coll, _id: r._id, _hash: r._hash, data: r.data })) });
    }
    if (p === "/api/v1/ingest/status" && m === "GET") {
      const [events, changes, pulse] = await Promise.all([
        store.query(`FROM ${COLL.ingest_events} ORDER BY started_at DESC LIMIT 10`).catch(() => store.query(`FROM ${COLL.ingest_events}`)),
        store.query(`FROM ${COLL.source_changes} ORDER BY detected_at DESC LIMIT 25`).catch(() => store.query(`FROM ${COLL.source_changes}`)),
        store.query(`FROM ${PULSE_EVENTS} ORDER BY created_at DESC LIMIT 10`).catch(() => [] as NedbRow[]),
      ]);
      const [seq, head] = await Promise.all([store.seq(), store.head()]);
      return json(res, 200, { nedb: { seq, head }, ingest_runs: events.map((r) => ({ _hash: r._hash, ...r.data })), source_changes: changes.map((r) => ({ _hash: r._hash, ...r.data })), pulse_ticks: pulse.map((r) => ({ _hash: r._hash, ...r.data })) });
    }
    if (p === "/api/v1/pulse/games" && m === "GET") {
      const rows = await store.query<GameStateDoc>(`FROM ${GAME_STATE}`);
      const team = q.get("team")?.toUpperCase();
      const states = rows.map((r) => ({ ...r.data, _hash: r._hash })).filter((s) => !team || s.home_team === team || s.away_team === team).sort((a, b) => (a.kickoff ?? "").localeCompare(b.kickoff ?? ""));
      return json(res, 200, { count: states.length, live: states.filter((s) => s.phase === "live"), states });
    }
    throw new HttpError(404, `no route ${m} ${p}`);
  }

  // --------------------------------------------------------------------- ask

  async function planContext(body: { team?: string; season?: number; game_id?: string; play_id?: string }): Promise<PlanContext> {
    const mt = await meta();
    const team = (body.team ?? defaultTeam).toUpperCase();
    const next = await nextOpponent(store, team).catch((e) => { log(`next opponent lookup failed: ${(e as Error).message}`); return null; });
    return { default_team: team, default_season: body.season ?? defaultSeason ?? mt.seasons[0], game_id: body.game_id, play_id: body.play_id, teams: mt.teams, next_opponent: next ?? undefined };
  }

  async function ask(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = (await readJson(req)) as { question?: string; team?: string; season?: number; game_id?: string; play_id?: string; explain?: boolean };
    if (!body.question || typeof body.question !== "string") throw new HttpError(400, "question required");
    const question = body.question.trim().slice(0, 500);
    const started = Date.now();
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no" });
    const send = (event: string, data: unknown) => { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
    const qe: Record<string, unknown> = { question, context: { team: body.team, season: body.season, game_id: body.game_id, play_id: body.play_id }, created_at: new Date().toISOString() };
    let plan: QueryPlan | undefined;
    let pkg: EvidencePackage | undefined;
    try {
      const ctx = await planContext(body);
      const planned = await planQuestion(question, ctx, llm, store, log);
      qe.plan_ok = planned.ok;
      qe.plan_errors = planned.errors;
      qe.plan_fallback = planned.fallback_used;
      send("plan", { ok: planned.ok, plan: planned.plan ? { id: planned.plan.id, intent: planned.plan.intent, filters: planned.plan.filters, source: planned.plan.source, model: planned.plan.model, notes: planned.plan.notes, latency_ms: planned.plan.latency_ms } : null, errors: planned.errors, fallback_used: planned.fallback_used });
      if (!planned.ok || !planned.plan) {
        send("error", { error: "CHALK could not turn that into a football query it can execute.", errors: planned.errors });
        send("done", { latency_ms: Date.now() - started });
        return;
      }
      plan = planned.plan;
      const t0 = Date.now();
      const exec = await execute(plan, { store, log });
      pkg = exec.package;
      qe.intent = plan.intent;
      qe.calculation_ids = pkg.calculation_ids;
      qe.evidence_count = pkg.evidence_ids.length;
      qe.exec_ms = Date.now() - t0;
      send("evidence", { kind: pkg.kind, summary: pkg.summary, calculation_ids: pkg.calculation_ids, calculation_hashes: pkg.calculation_hashes, evidence_count: pkg.evidence_ids.length, evidence_ids: pkg.evidence_ids.slice(0, 300), deterministic_statements: pkg.deterministic_statements ?? [], unsupported: pkg.unsupported ?? [], detail: exec.detail, exec_ms: qe.exec_ms });

      const wantExplain = body.explain !== false && plan.intent !== "unsupported";
      if (wantExplain && llm && llm.key) {
        const team = (plan.filter?.team ?? (plan.filters.team as string) ?? defaultTeam) as string;
        const season = (plan.filter?.season ?? defaultSeason) as number;
        for await (const ev of explain(llm, store, question, plan, pkg, { team, season }, log)) {
          if (ev.type === "token") send("token", { text: ev.text });
          else if (ev.type === "observation") { qe.observation_id = ev.observation.id; qe.model = ev.observation.model; qe.answer_truncated = ev.observation.answer_truncated; qe.llm_ms = ev.observation.latency_ms; send("observation", { id: ev.observation.id, _hash: ev.hash, model: ev.observation.model, prompt_version: ev.observation.prompt_version, finish_reason: ev.observation.finish_reason, answer_truncated: ev.observation.answer_truncated, latency_ms: ev.observation.latency_ms, error: ev.observation.error }); }
          else if (ev.type === "error") { qe.llm_error = ev.error; send("token", { text: `\n\n${deterministicFallback(pkg)}` }); send("error", { error: ev.error, recoverable: true }); }
        }
      } else {
        const why = !llm ? "LLM disabled" : !llm.key ? "no LLM key configured" : "explanation not requested";
        qe.llm_skipped = why;
        send("token", { text: deterministicFallback(pkg) });
        send("observation", { id: null, skipped: why });
      }
      send("done", { latency_ms: Date.now() - started });
    } catch (e) {
      qe.error = (e as Error).message;
      log(`ask failed: ${(e as Error).stack ?? (e as Error).message}`);
      send("error", { error: (e as Error).message, recoverable: false });
      send("done", { latency_ms: Date.now() - started });
    } finally {
      qe.latency_ms = Date.now() - started;
      res.end();
      try {
        await store.put(COLL.query_events, deterministicId("qev", { question, started }), qe, { causedBy: pkg?.calculation_hashes.filter(Boolean), evidence: "query event" });
      } catch (e) {
        log(`failed to record query event: ${(e as Error).message}`);
      }
    }
  }

  // ----------------------------------------------------------------- helpers

  async function loadPlays(ids: string[]): Promise<Array<Play & { _hash: string }>> {
    // Group by game to keep NQL calls to one per game instead of one per play.
    const byGame = new Map<string, Set<string>>();
    for (const id of ids) { const g = id.split(":")[0]; if (!byGame.has(g)) byGame.set(g, new Set()); byGame.get(g)!.add(id); }
    const out: Array<Play & { _hash: string }> = [];
    for (const [g, want] of byGame) {
      const rows = await store.query<Play>(`FROM ${COLL.plays} WHERE game_id = ${nqlStr(g)}`);
      for (const r of rows) if (want.has(r._id)) out.push({ ...r.data, _hash: r._hash });
    }
    const order = new Map(ids.map((id, i) => [id, i]));
    out.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    return out;
  }

  async function serveStatic(res: ServerResponse, pathname: string): Promise<void> {
    let rel = pathname === "/" ? "/index.html" : pathname;
    if (rel.includes("..")) throw new HttpError(400, "bad path");
    let file = path.join(webDir, rel);
    try {
      const st = await stat(file);
      if (st.isDirectory()) file = path.join(file, "index.html");
    } catch {
      // SPA fallback: unknown paths render the app shell.
      file = path.join(webDir, "index.html");
    }
    try {
      const data = await readFile(file);
      res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream", "cache-control": file.endsWith("index.html") ? "no-cache" : "public, max-age=300" });
      res.end(data);
    } catch (e) {
      throw new HttpError(404, `static file not found: ${rel} (${(e as Error).message})`);
    }
  }

  await new Promise<void>((resolve) => server.listen(opts.port, opts.host, resolve));
  await meta().catch((e) => log(`meta warmup failed: ${(e as Error).message}`));

  // Data-change watcher: when another process (chalk ingest / chalk watch)
  // finishes a run, a new football_ingest_events row appears. Drop every
  // in-process cache so the next request recomputes against the new plays.
  // Polls a tiny collection; logs every invalidation.
  let lastIngestCount = -1;
  const watchMs = Number(process.env.CHALK_INGEST_WATCH_MS ?? 60_000);
  if (watchMs > 0) {
    const tick = async () => {
      try {
        const n = (await store.client.queryFull(`FROM ${COLL.ingest_events}`)).count + (await store.client.queryFull(`FROM ${PULSE_EVENTS}`).catch(() => ({ count: 0 }))).count;
        if (lastIngestCount >= 0 && n !== lastIngestCount) {
          store.invalidateCache();
          invalidateLeagueCache();
          invalidateProfileCache();
          teamsCache = null;
          log(`data changed (${lastIngestCount} -> ${n} ingest/pulse events): caches invalidated`);
        }
        lastIngestCount = n;
      } catch (e) {
        log(`ingest watcher tick failed: ${(e as Error).message}`);
      }
    };
    await tick();
    const timer = setInterval(tick, watchMs);
    server.on("close", () => clearInterval(timer));
  }
  // Warm the default team's home in the background so the first fan sees
  // ~300ms, not the ~10s cold path (three season-scale NQL scans).
  if (defaultSeason && process.env.CHALK_WARMUP !== "0") {
    const t0 = Date.now();
    buildHome(store, defaultTeam, defaultSeason, THIRD_DOWN_DEFAULT_V1, () => {}).then(
      () => log(`warmup: home ${defaultTeam} ${defaultSeason} ready in ${Date.now() - t0}ms`),
      (e) => log(`warmup failed (server still serving): ${(e as Error).message}`),
    );
  }
  log(`CHALK listening on http://${opts.host}:${opts.port}  (nedb ${store.url}/${store.db}, llm ${llm ? `${llm.model}${llm.key ? "" : " [no key]"}` : "off"}, default ${defaultTeam} ${defaultSeason || "?"})`);
  return server;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const s = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(s) });
  res.end(s);
}

function need(q: URLSearchParams, k: string): string {
  const v = q.get(k);
  if (!v) throw new HttpError(400, `${k} required`);
  return v;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 1_000_000) throw new HttpError(413, "body too large");
    chunks.push(c as Buffer);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (e) {
    throw new HttpError(400, `invalid JSON body: ${(e as Error).message}`);
  }
}

function countBy(xs: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const x of xs) out[x] = (out[x] ?? 0) + 1;
  return out;
}

function labelFor(r: NedbRow): string {
  const d = r.data as Record<string, unknown>;
  switch (r._coll) {
    case COLL.plays: return `${d.posteam} ${d.down !== null ? `${d.down}&${d.ydstogo}` : ""} ${d.play_type} ${d.yards_gained}yd (Q${d.quarter})`;
    case COLL.raw_plays: return `raw ${d.source} ${d.source_endpoint} v${d.source_version}`;
    case COLL.raw_games: return `raw game ${d.source_record_id}`;
    case COLL.games: return `${d.away_team} @ ${d.home_team} wk${d.week}`;
    case COLL.analyses: return `${d.algorithm}@${d.algorithm_version}`;
    case COLL.ratings: return `${d.definition_name} ${d.score}/100`;
    case COLL.rating_definitions: return `definition ${d.name} v${d.version}`;
    case COLL.observations: return `observation (${d.model})`;
    case COLL.tendencies: return `tendency`;
    case COLL.comparisons: return `comparison`;
    default: return r._coll;
  }
}

const SUGGESTED = [
  "Why is Tampa struggling on third down?",
  "What should I know about this week's opponent?",
  "What situations are hurting Tampa the most?",
  "What does Tampa do on 3rd and medium?",
  "How does Tampa's third-down rating break down?",
  "Compare Tampa's first half and second half",
  "Tampa in the red zone",
  "Tampa when trailing",
];
