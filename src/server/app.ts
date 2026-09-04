/*
 * SPDX-License-Identifier: BUSL-1.1
 * Copyright (c) 2026 Interchained LLC. All rights reserved.
 * CHALK / Sports-Rater — https://sports-rater.com — Licensor: Interchained LLC
 */
/**
 * CHALK HTTP server — open JSON API + SSE ask loop + static client.
 *
 * Zero web framework: node:http. Every route is listed in openapi.ts.
 * Every /ask is logged to football_query_events with plan, latency, evidence
 * counts and errors (V3 §39).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { auditSeason } from "../ingest/audit.ts";
import { shareCopy, injectOg, publicBase } from "./share.ts";
import { homeSnapshotId, homeServeDecision, loadHomeSnapshot, persistHomeSnapshot, type HomePayload, dataStampFrom, type IngestEventLike, type PulseEventLike } from "./home.ts";
import type { RatingDefinition } from "../rating/definitions.ts";
import { logoConfig } from "./logos.ts";
import { createRequire } from "node:module";
const CHALK_VERSION: string = (createRequire(import.meta.url)("../../package.json") as { version: string }).version;
import { evidenceKey, findObservation, listRecord } from "../llm/record.ts";
import { adminOverview, adminAuthorized, validateTelemetry, telemetryDoc, TELEMETRY } from "./admin.ts";
import { setHidden, listModeration, hiddenSet, validateModeration } from "./moderation.ts";
import type { ObservationRecord } from "../llm/explain.ts";
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
import { BUILTIN_DEFINITIONS, CARD_SUBJECTS, OFFENSE_DEFAULT_V1, THIRD_DOWN_DEFAULT_V1, validateDefinition, definitionSubjectMismatch, filterDefinitionsBySubject, RATING_SUBJECTS } from "../rating/definitions.ts";
import { invalidateProfileCache, leagueProfilesFor, rankings, rateSubject } from "../rating/rank.ts";
import { subjectTrend } from "../rating/trend.ts";
import { invalidateLeagueCache } from "../rating/league.ts";
import { compareDefinitions, leagueThirdDown, listDefinitions, loadDefinition, rateThirdDown } from "../rating/league.ts";
import { computeRating, persistDefinition } from "../rating/rating.ts";
import { LICENSING } from "../source/licensing.ts";
import { COLL } from "../store/collections.ts";
import { deterministicId } from "../store/hash.ts";
import { NedbError, nqlStr, type NedbRow } from "../store/nedb.ts";
import type { Store } from "../store/nedb.ts";
import { GAME_STATE, PULSE_EVENTS, type GameStateDoc } from "../ingest/pulse.ts";
import type { RawDoc } from "../ingest/ingest.ts";
import { execute, summarizeRating } from "./intents.ts";
import { openapiDocument } from "./openapi.ts";
import { baseFilter, buildHome, leagueBadgePopulation, loadTeamPlaysWithContext, nextOpponent } from "./home.ts";
import { thirdDownTrend } from "../engine/trend.ts";
import { evaluateBadges, BADGE_DEFINITIONS } from "../rating/badges.ts";
import { opponentReport, summarizeOpponentReport } from "../engine/opponent.ts";
import { analyzeDeviation } from "../engine/deviation.ts";
import { identiconSvg, RateLimiter, verifyIdentity } from "../fans/identity.ts";
import { consensus, fanChain, feed, post, rate, react, validatePost, validateRate, validateReaction, SR, validateFavorite, favorite, favoriteOf, validatePick, pick, fanPicks, pickLeaderboard, picksForGame, validateHype, hype, hypeFor, reactionCounts, HYPE_LABELS } from "../fans/fans.ts";

// Fan-layer anti-spam: 20 writes burst per handle, refilling 1 per 10s; 60 per address, 1 per 5s.
const fanLimiter = new RateLimiter(20, 1 / 10_000);
const ipLimiter = new RateLimiter(60, 1 / 5_000);
setInterval(() => { fanLimiter.sweep(); ipLimiter.sweep(); }, 600_000).unref();

export interface ServerOptions {
  store: Store;
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

const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json", ".webmanifest": "application/manifest+json", ".ico": "image/x-icon", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8" };

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
  // Data version stamp = last seq at which ingest/pulse wrote (dataStampFrom), maintained by the watcher
  // tick below. null until the first tick has run. Persisted Home snapshots
  // carry the stamp they were built from; equal stamp => nothing changed.
  let dataStamp: string | null = null;
  const homeInflight = new Map<string, Promise<HomePayload>>();
  /** Build once per key at a time, persist with the current stamp, log the cost. Concurrent callers share the promise. */
  function computeHome(team: string, season: number, def: RatingDefinition): Promise<HomePayload> {
    const key = homeSnapshotId(team, season, def.id);
    const running = homeInflight.get(key);
    if (running) return running;
    const t0 = Date.now();
    const stampAtStart = dataStamp;
    const job = buildHome(store, team, season, def, log)
      .then(async (payload) => {
        if (stampAtStart !== null) {
          await persistHomeSnapshot(store, payload, def.id, stampAtStart, Date.now() - t0).catch((e) => log(`home snapshot persist failed for ${key}: ${(e as Error).message}`));
        } else {
          log(`home ${key} built before the first data tick — not persisted (stamp unknown); next build will be`);
        }
        return payload;
      })
      .finally(() => homeInflight.delete(key));
    homeInflight.set(key, job);
    return job;
  }
  /** Snapshot-first Home: instant when a snapshot exists, background refresh when it is stale, inline build only for a never-built key. */
  async function serveHome(team: string, season: number, def: RatingDefinition, force: boolean): Promise<HomePayload & { served: { source: "snapshot" | "computed"; fresh: boolean; refreshing: boolean; data_stamp: string | null; snapshot_stamp: string | null; built_ms: number | null } }> {
    const snap = force ? null : await loadHomeSnapshot(store, team, season, def.id);
    const decision = force ? "compute" : homeServeDecision(snap?.data ?? null, dataStamp);
    if (decision === "fresh_snapshot") {
      return { ...snap!.data.payload, served: { source: "snapshot", fresh: true, refreshing: false, data_stamp: dataStamp, snapshot_stamp: snap!.data.data_stamp, built_ms: snap!.data.built_ms } };
    }
    if (decision === "stale_snapshot") {
      log(`home ${team} ${season}: snapshot stamp ${snap!.data.data_stamp} != data ${dataStamp ?? "unknown"} — serving stale, recomputing in background`);
      computeHome(team, season, def).catch((e) => log(`home background recompute failed for ${team} ${season}: ${(e as Error).message}`));
      return { ...snap!.data.payload, served: { source: "snapshot", fresh: false, refreshing: true, data_stamp: dataStamp, snapshot_stamp: snap!.data.data_stamp, built_ms: snap!.data.built_ms } };
    }
    const t0 = Date.now();
    const payload = await computeHome(team, season, def);
    return { ...payload, served: { source: "computed", fresh: true, refreshing: false, data_stamp: dataStamp, snapshot_stamp: null, built_ms: Date.now() - t0 } };
  }
  let teamsCache: { at: number; teams: string[]; seasons: number[] } | null = null;

  let healthCache: { at: number; value: Record<string, unknown> } | null = null;
  let healthRefreshing: Promise<void> | null = null;
  async function refreshHealth(): Promise<void> {
    const [health, seq, head] = await Promise.all([store.health().catch((e) => ({ ok: false, error: (e as Error).message })), store.seq().catch(() => null), store.head().catch(() => null)]);
    healthCache = { at: Date.now(), value: { ...health, seq, head } };
  }
  async function healthSnapshot(): Promise<Record<string, unknown>> {
    if (!healthCache) await refreshHealth();
    else if (Date.now() - healthCache.at > 5_000 && !healthRefreshing) healthRefreshing = refreshHealth().catch((e) => log(`health refresh failed: ${(e as Error).message}`)).finally(() => { healthRefreshing = null; });
    return { ...healthCache!.value, age_ms: Date.now() - healthCache!.at };
  }

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
        // /s/TEAM — share landing: the app shell with OG/Twitter tags for this team's headline, so a pasted
        // link previews the hero and the number. The SPA reads the team from the path (v0.12.0).
        const sm = url.pathname.match(/^\/s\/([A-Za-z]{2,3})$/);
        if (sm && req.method === "GET") {
          const team = sm[1].toUpperCase();
          const season = Number(url.searchParams.get("season") ?? defaultSeason);
          let html = await readFile(path.join(webDir, "index.html"), "utf8");
          try {
            // Snapshot only (see /api/v1/share): a crawler must never trigger a 30 s Home build.
            const snap = await loadHomeSnapshot(store, team, season, THIRD_DOWN_DEFAULT_V1.id);
            if (!snap) throw new Error(`no Home snapshot yet for ${team} ${season}`);
            html = injectOg(html, shareCopy(snap.data.payload, url.searchParams.get("headline") ?? "third_down", publicBase(process.env, req.headers)));
          } catch (e) {
            log(`share landing ${team} ${season}: OG tags skipped — ${(e as Error).message}`);
          }
          res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" });
          res.end(html);
          return;
        }
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
      // Liveness must not queue behind a scan on the engine thread: serve the last
      // known engine state and refresh it off the request path when older than 5 s.
      const nedb = await healthSnapshot();
      return json(res, 200, { chalk: "ok", version: CHALK_VERSION, nedb: { url: store.url, db: store.db, ...nedb }, llm: llm ? { url: llm.url, model: llm.model, provider: llm.provider, has_key: Boolean(llm.key) } : null, defaults: { team: defaultTeam, season: defaultSeason || null } });
    }
    if (p === "/api/v1/openapi.json") return json(res, 200, openapiDocument(`${url.protocol}//${url.host}`));
    if (p === "/api/v1/meta") {
      const mt = await meta();
      const defs = await listDefinitions(store);
      return json(res, 200, { teams: mt.teams, seasons: mt.seasons, defaults: { team: defaultTeam, season: defaultSeason || null }, rating_definitions: defs.map((d) => ({ id: d.id, name: d.name, version: d.version, components: d.components })), licensing: LICENSING, team_logos: logoConfig(), telemetry: process.env.CHALK_TELEMETRY !== "0", license: { spdx: "BUSL-1.1", name: "Business Source License 1.1", licensor: "Interchained LLC", copyright: `Copyright (c) ${new Date().getUTCFullYear()} Interchained LLC. All rights reserved.` }, suggested_questions: SUGGESTED });
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
      { const mismatch = definitionSubjectMismatch(def, "third_down"); if (mismatch) throw new HttpError(400, mismatch); }
      const r = await rateThirdDown(store, team, season, def, (q.get("side") as "offense" | "defense") ?? "offense", log);
      if (!r) throw new HttpError(404, `no third-down data for ${team} ${season}`);
      return json(res, 200, { summary: summarizeRating(r), snapshot: r.snapshot, definition: def, rank: r.rank, league: r.league, analysis_id: r.analysis.id, _hash: r.stored_hash, cached: r.cached });
    }
    if (p === "/api/v1/ratings/third-down/league" && m === "GET") {
      const season = Number(q.get("season") ?? defaultSeason);
      const def = (await loadDefinition(store, q.get("definition") ?? THIRD_DOWN_DEFAULT_V1.id));
      if (!def) throw new HttpError(404, "unknown rating definition");
      { const mismatch = definitionSubjectMismatch(def, "third_down"); if (mismatch) throw new HttpError(400, mismatch); }
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
      for (const d of [a, b]) { const mismatch = definitionSubjectMismatch(d, "third_down"); if (mismatch) throw new HttpError(400, `${mismatch} — compare is third-down only`); }
      const r = await compareDefinitions(store, team, season, a, b, (q.get("side") as "offense" | "defense") ?? "offense");
      if (!r) throw new HttpError(404, `no third-down data for ${team} ${season}`);
      return json(res, 200, { disagreement: r.disagreement, a: { summary: summarizeRating(r.a), snapshot: r.a.snapshot }, b: { summary: summarizeRating(r.b), snapshot: r.b.snapshot } });
    }
    if ((mm = p.match(/^\/api\/v1\/ratings\/(offense|defense|red-zone|red_zone|explosiveness|ball-security|ball_security|third-down|third_down)\/trend$/)) && m === "GET") {
      const subject = mm[1].replace("-", "_");
      const team = need(q, "team").toUpperCase();
      const season = Number(q.get("season") ?? defaultSeason);
      const def = (await loadDefinition(store, q.get("definition") ?? CARD_SUBJECTS.find((c) => c.subject === subject)!.definition.id));
      if (!def) throw new HttpError(404, "unknown rating definition");
      { const mismatch = definitionSubjectMismatch(def, subject as (typeof RATING_SUBJECTS)[number]); if (mismatch) throw new HttpError(400, mismatch); }
      const side = def.subject === "defense" ? "defense" : "offense";
      const lp = await leagueProfilesFor(store, season, side, log);
      const games = (await store.query<Game>(`FROM ${COLL.games} WHERE season = ${season}`)).map((g) => g.data);
      return json(res, 200, subjectTrend(lp.rows, games, team, season, def, { seq: lp.seq, head: lp.head }));
    }
    if (p === "/api/v1/rankings" && m === "GET") {
      const season = Number(q.get("season") ?? defaultSeason);
      const def = (await loadDefinition(store, q.get("definition") ?? OFFENSE_DEFAULT_V1.id));
      if (!def) throw new HttpError(404, "unknown rating definition");
      return json(res, 200, await rankings(store, season, def, log));
    }
    // League table for any non-third-down subject (third-down has its own richer route above): the
    // rankings() rows — score, sample, provisional, and rank movement vs a week earlier.
    if ((mm = p.match(/^\/api\/v1\/ratings\/(offense|defense|red-zone|red_zone|explosiveness|ball-security|ball_security)\/league$/)) && m === "GET") {
      const subject = mm[1].replace("-", "_") as (typeof RATING_SUBJECTS)[number];
      const season = Number(q.get("season") ?? defaultSeason);
      const def = (await loadDefinition(store, q.get("definition") ?? CARD_SUBJECTS.find((c) => c.subject === subject)!.definition.id));
      if (!def) throw new HttpError(404, "unknown rating definition");
      { const mismatch = definitionSubjectMismatch(def, subject); if (mismatch) throw new HttpError(400, mismatch); }
      const r = await rankings(store, season, def, log);
      return json(res, 200, { subject, season, definition: { id: def.id, name: def.name, version: def.version }, population: r.population, through_week: r.through_week, seq: r.computed_at.seq, head: r.computed_at.head, table: r.rows.map((row) => ({ rank: row.rank, team: row.team, score: row.score, sample: row.sample, provisional: row.provisional, movement: row.movement })) });
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
      { const mismatch = definitionSubjectMismatch(def, "third_down"); if (mismatch) throw new HttpError(400, mismatch); }
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
    // Sharecard copy: title / caption / canonical URL / preview image for a team's headline (v0.12.0).
    if ((mm = p.match(/^\/api\/v1\/share\/([A-Za-z]{2,3})$/)) && m === "GET") {
      const team = mm[1].toUpperCase();
      const season = Number(q.get("season") ?? defaultSeason);
      // Snapshot only — never compute Home inline for a caption. No snapshot yet → 404 with the reason; the client
      // has a local caption and the picture never waits on the store (v0.12.11).
      const snap = await loadHomeSnapshot(store, team, season, THIRD_DOWN_DEFAULT_V1.id);
      if (!snap) throw new HttpError(404, `no Home snapshot yet for ${team} ${season} — open the dashboard once; the caption is built from it`);
      return json(res, 200, { ...shareCopy(snap.data.payload, q.get("headline") ?? "third_down", publicBase(process.env, req.headers)), snapshot_stamp: snap.data.data_stamp });
    }
    if ((mm = p.match(/^\/api\/v1\/teams\/([A-Za-z]{2,3})\/home$/)) && m === "GET") {
      const team = mm[1].toUpperCase();
      const season = Number(q.get("season") ?? defaultSeason);
      const def = (await loadDefinition(store, q.get("definition") ?? THIRD_DOWN_DEFAULT_V1.id)) ?? THIRD_DOWN_DEFAULT_V1;
      const mismatch = definitionSubjectMismatch(def, "third_down");
      if (mismatch) throw new HttpError(400, `${mismatch} — the Home third-down rating only takes third_down definitions; use /api/v1/ratings/${def.subject.replace("_", "-")}?definition=${encodeURIComponent(def.id)}`);
      return json(res, 200, await serveHome(team, season, def, q.get("fresh") === "1"));
    }
    // ------------------------------------------------- Sports-Rater fan layer
    if (p.startsWith("/api/v1/fans/") && m === "POST") {
      const body = (await readJson(req)) as Record<string, unknown>;
      const who = verifyIdentity(body.identity ?? body);
      if (!who.ok) throw new HttpError(400, "invalid identity", who.errors);
      const ip = clientIp(req);
      const l1 = fanLimiter.take(who.identity!.fan_id);
      const l2 = ipLimiter.take(ip);
      if (!l1.ok || !l2.ok) {
        res.setHeader("retry-after", String(Math.ceil(Math.max(l1.retry_after_ms, l2.retry_after_ms) / 1000)));
        throw new HttpError(429, `slow down — ${!l1.ok ? "this handle" : "this address"} is writing too fast`, { retry_after_ms: Math.max(l1.retry_after_ms, l2.retry_after_ms) });
      }
      const now = new Date().toISOString();
      if (p === "/api/v1/fans/ratings") {
        const v = validateRate(body);
        if (!v.ok) throw new HttpError(400, "invalid rating", v.errors);
        const r = await rate(store, who.identity!, v.value!, now);
        const card = CARD_SUBJECTS.find((c) => c.subject === v.value!.subject);
        const chalk = card ? await rateSubject(store, v.value!.team, v.value!.season, card.definition, log).catch(() => null) : null;
        const cons = await consensus(store, v.value!.team, v.value!.season, v.value!.subject, chalk?.snapshot.score ?? v.value!.chalk_score ?? null);
        return json(res, 201, { ok: true, replaced: r.replaced, id: r.row._id, _hash: r.row._hash, chain_index: r.row.data.chain_index, consensus: cons });
      }
      if (p === "/api/v1/fans/reactions") {
        const v = validateReaction(body);
        if (!v.ok) throw new HttpError(400, "invalid reaction", v.errors);
        const r = await react(store, who.identity!, v.value!, now);
        return json(res, 201, { ok: true, replaced: r.replaced, id: r.row._id, _hash: r.row._hash, chain_index: r.row.data.chain_index });
      }
      if (p === "/api/v1/fans/posts") {
        const v = validatePost(body);
        if (!v.ok) throw new HttpError(400, "invalid take", v.errors);
        const r = await post(store, who.identity!, v.value!, now);
        return json(res, 201, { ok: true, id: r._id, _hash: r._hash, chain_index: r.data.chain_index });
      }
      // Fan knobs that are NOT facts (v0.11.0): allegiance, picks (settled by the facts later), sentiment.
      if (p === "/api/v1/fans/favorites") {
        const v = validateFavorite(body);
        if (!v.ok) throw new HttpError(400, "invalid favorite", v.errors);
        const r = await favorite(store, who.identity!, v.value!, now);
        return json(res, 201, { ok: true, replaced: r.replaced, team: v.value!.team, id: r.row._id, _hash: r.row._hash, chain_index: r.row.data.chain_index });
      }
      if (p === "/api/v1/fans/picks") {
        const v = validatePick(body);
        if (!v.ok) throw new HttpError(400, "invalid pick", v.errors);
        let r;
        try { r = await pick(store, who.identity!, v.value!, now); } catch (e) { throw new HttpError(/not found/.test((e as Error).message) ? 404 : 409, (e as Error).message); }
        const [mine, crowd] = await Promise.all([fanPicks(store, who.identity!.fan_id, r.game.season ?? undefined), picksForGame(store, v.value!.game_id)]);
        return json(res, 201, { ok: true, replaced: r.replaced, id: r.row._id, _hash: r.row._hash, chain_index: r.row.data.chain_index, pick: r.row.data.pick, record: mine.record, crowd });
      }
      if (p === "/api/v1/fans/hype") {
        const v = validateHype(body);
        if (!v.ok) throw new HttpError(400, "invalid hype", v.errors);
        const r = await hype(store, who.identity!, v.value!, now);
        const agg = await hypeFor(store, v.value!.team, v.value!.season, v.value!.week);
        return json(res, 201, { ok: true, replaced: r.replaced, id: r.row._id, _hash: r.row._hash, chain_index: r.row.data.chain_index, mine: v.value!.value, ...agg });
      }
      throw new HttpError(404, `no route ${m} ${p}`);
    }
    if (p === "/api/v1/feed" && m === "GET") {
      const include = (q.get("include") ?? "post,pick,rating").split(",").filter((k): k is "post" | "rating" | "reaction" | "pick" => ["post", "rating", "reaction", "pick"].includes(k));
      const f = await feed(store, { team: q.get("team")?.toUpperCase() || undefined, limit: Math.min(200, Number(q.get("limit") ?? 50)), include });
      return json(res, 200, { count: f.items.length, seq: f.seq, head: f.head, items: f.items.map((i) => ({ ...i, identicon: identiconSvg(i.fan_id, 32) })) });
    }
    if (p === "/api/v1/fans/favorite" && m === "GET") {
      const fan_id = need(q, "fan_id");
      if (!/^[0-9a-f]{64}$/.test(fan_id)) throw new HttpError(400, "fan_id: 64 hex chars");
      return json(res, 200, { fan_id, team: await favoriteOf(store, fan_id) });
    }
    if (p === "/api/v1/fans/picks" && m === "GET") {
      const fan_id = need(q, "fan_id");
      if (!/^[0-9a-f]{64}$/.test(fan_id)) throw new HttpError(400, "fan_id: 64 hex chars");
      const season = q.get("season") ? Number(q.get("season")) : undefined;
      return json(res, 200, { fan_id, season: season ?? null, ...(await fanPicks(store, fan_id, season)) });
    }
    if (p === "/api/v1/fans/picks/leaderboard" && m === "GET") {
      const season = Number(q.get("season") ?? defaultSeason);
      const rows = await pickLeaderboard(store, season, Math.min(100, Number(q.get("limit") ?? 20)));
      return json(res, 200, { season, count: rows.length, rows: rows.map((r) => ({ ...r, identicon: identiconSvg(r.fan_id, 24) })) });
    }
    if (p === "/api/v1/fans/picks/game" && m === "GET") {
      const game_id = need(q, "game_id");
      if (!/^\d{4}_\d{2}_[A-Z]{2,3}_[A-Z]{2,3}$/.test(game_id)) throw new HttpError(400, "game_id: e.g. 2025_01_TB_ATL");
      return json(res, 200, await picksForGame(store, game_id));
    }
    if (p === "/api/v1/fans/hype" && m === "GET") {
      const team = need(q, "team").toUpperCase();
      const season = Number(q.get("season") ?? defaultSeason);
      const week = Number(need(q, "week"));
      if (!Number.isInteger(week) || week < 1 || week > 22) throw new HttpError(400, "week: integer 1-22");
      return json(res, 200, { ...(await hypeFor(store, team, season, week)), labels: HYPE_LABELS.slice(1) });
    }
    if (p === "/api/v1/fans/consensus" && m === "GET") {
      const team = need(q, "team").toUpperCase();
      const season = Number(q.get("season") ?? defaultSeason);
      const subjects = q.get("subject") ? [q.get("subject")!] : CARD_SUBJECTS.map((c) => c.subject);
      const out = [];
      for (const s of subjects) {
        const card = CARD_SUBJECTS.find((c) => c.subject === s);
        const chalk = card ? await rateSubject(store, team, season, card.definition, log).catch(() => null) : null;
        out.push(await consensus(store, team, season, s, chalk?.snapshot.score ?? null));
      }
      return json(res, 200, { team, season, consensus: out });
    }
    if ((mm = p.match(/^\/api\/v1\/fans\/([0-9a-f]{64})$/)) && m === "GET") {
      const chain = await fanChain(store, mm[1]);
      return json(res, 200, { fan_id: mm[1], identicon: identiconSvg(mm[1], 64), ...chain });
    }
    if ((mm = p.match(/^\/api\/v1\/identicon\/([0-9a-f]{6,64})\.svg$/)) && m === "GET") {
      const svg = identiconSvg(mm[1].padEnd(64, "0"), Number(q.get("size") ?? 40));
      res.writeHead(200, { "content-type": "image/svg+xml", "cache-control": "public, max-age=31536000, immutable" });
      res.end(svg);
      return;
    }
    if (p === "/api/v1/rating-definitions" && m === "GET") {
      const subject = q.get("subject");
      if (subject && !(RATING_SUBJECTS as readonly string[]).includes(subject)) throw new HttpError(400, `subject: one of ${RATING_SUBJECTS.join("|")}`);
      return json(res, 200, { subject: subject ?? null, definitions: filterDefinitionsBySubject(await listDefinitions(store), subject), rateable_metrics: (await import("../rating/definitions.ts")).RATEABLE_METRICS });
    }
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

    // ---- admin (env-gated: CHALK_ADMIN_TOKEN unset => these routes do not exist)
    if (p.startsWith("/api/v1/admin/")) {
      const tok = process.env.CHALK_ADMIN_TOKEN;
      if (!tok) throw new HttpError(404, `no route ${m} ${p}`);
      if (!adminAuthorized(req.headers.authorization, tok)) { log(`admin: rejected token from ${clientIp(req)}`); throw new HttpError(401, "admin token required"); }
      // Moderation: what is on the feed (incl. hidden state), hide/unhide, regenerate.
      if (p === "/api/v1/admin/feed" && m === "GET") {
        const limit = Math.min(200, Number(q.get("limit") ?? 50));
        const [obs, posts, hidden] = await Promise.all([store.query<ObservationRecord>(`FROM ${COLL.observations}`), store.query<Record<string, unknown>>(`FROM ${SR.posts}`), hiddenSet(store)]);
        const answers = obs.map((r) => ({ coll: COLL.observations, id: r._id, seq: r._seq, hash: r._hash, created_at: r.data.created_at, question: r.data.question, intent: r.data.intent, team: r.data.team ?? null, model: r.data.model, answer: (r.data.answer ?? "").slice(0, 600), statements: r.data.statements ?? [], error: r.data.error, truncated: r.data.answer_truncated, hidden: hidden.has(`${COLL.observations}:${r._id}`) })).sort((a, b) => b.seq - a.seq).slice(0, limit);
        const takes = posts.map((r) => ({ coll: SR.posts, id: r._id, seq: r._seq, hash: r._hash, created_at: String(r.data.created_at), handle: String(r.data.handle), text: String(r.data.text), team: (r.data.team as string | null) ?? null, hidden: hidden.has(`${SR.posts}:${r._id}`) })).sort((a, b) => b.seq - a.seq).slice(0, limit);
        return json(res, 200, { answers, takes, hidden: hidden.size, moderation: await listModeration(store, 100) });
      }
      if ((p === "/api/v1/admin/hide" || p === "/api/v1/admin/unhide") && m === "POST") {
        const v = validateModeration(await readJson(req));
        if (!v.ok) throw new HttpError(400, v.errors.join("; "));
        const hide = p.endsWith("/hide");
        const row = await setHidden(store, v.value!.coll, v.value!.id, hide, v.value!.reason);
        log(`admin: ${hide ? "hid" : "restored"} ${v.value!.coll}/${v.value!.id}${v.value!.reason ? ` — ${v.value!.reason}` : ""}`);
        store.invalidateCache();
        return json(res, 200, { ok: true, hidden: hide, moderation_hash: row._hash, coll: v.value!.coll, id: v.value!.id });
      }
      if (p === "/api/v1/admin/regenerate" && m === "POST") {
        const body = (await readJson(req)) as { id?: string; reason?: string };
        if (!body.id) throw new HttpError(400, "id required (football_observations id)");
        if (!llm || !llm.key) throw new HttpError(503, "regenerate needs the LLM (CHALK_LLM_KEY unset)");
        const old = await store.get<ObservationRecord>(COLL.observations, body.id);
        if (!old) throw new HttpError(404, `observation ${body.id} not found`);
        const team = old.data.team ?? (old.data.query_plan?.filters as { team?: string })?.team ?? defaultTeam;
        const season = old.data.season ?? (old.data.query_plan?.filters as { season?: number })?.season ?? defaultSeason;
        const t0 = Date.now();
        const ctx = await planContext({ team, season });
        const planned = await planQuestion(old.data.question, ctx, llm, store, log);
        if (!planned.ok || !planned.plan) throw new HttpError(422, `could not re-plan: ${planned.errors.join("; ")}`);
        const exec = await execute(planned.plan, { store, log });
        let fresh: ObservationRecord | null = null; let freshHash: string | null = null; let llmError: string | null = null;
        for await (const ev of explain(llm, store, old.data.question, planned.plan, exec.package, { team, season, register: old.data.register ?? "fan" }, log)) {
          if (ev.type === "observation") { fresh = ev.observation; freshHash = ev.hash; }
          else if (ev.type === "error") llmError = ev.error;
        }
        if (!fresh || !fresh.answer) throw new HttpError(502, `regeneration produced no stored answer${llmError ? `: ${llmError}` : ""}`);
        await setHidden(store, COLL.observations, body.id, true, `${body.reason ? body.reason + " — " : ""}regenerated → ${fresh.id}`);
        store.invalidateCache();
        log(`admin: regenerated ${body.id} → ${fresh.id} (${planned.plan.intent}, ${Date.now() - t0}ms)`);
        return json(res, 200, { ok: true, old_id: body.id, new_id: fresh.id, new_hash: freshHash, intent: planned.plan.intent, plan_source: planned.plan.source, plan_fallback: planned.fallback_used, statements: exec.package.deterministic_statements ?? [], answer: fresh.answer, latency_ms: Date.now() - t0 });
      }
      if (p === "/api/v1/admin/overview" && m === "GET") {
        const season = q.get("season") ? Number(q.get("season")) : undefined;
        const windowDays = Math.min(3650, Math.max(1, Number(q.get("window") ?? 30)));
        return json(res, 200, await adminOverview(store, { season, windowDays }));
      }
      throw new HttpError(404, `no admin route ${m} ${p}`);
    }
    // ---- anonymous telemetry: one small row per page view / tab / ask. No IP, no UA. Rate limited per address like fan writes.
    if (p === "/api/v1/telemetry" && m === "POST") {
      if (process.env.CHALK_TELEMETRY === "0") return json(res, 204, {});
      const ip = clientIp(req);
      const lim = ipLimiter.take(ip);
      if (!lim.ok) throw new HttpError(429, `too many events; retry in ${Math.ceil(lim.retry_after_ms / 1000)}s`);
      const v = validateTelemetry(await readJson(req));
      if (!v.ok) throw new HttpError(400, v.errors.join("; "));
      const doc = telemetryDoc(v.value!);
      const id = deterministicId("tel", { ...doc, ip_bucket: undefined, nonce: Math.random() });
      await store.put(TELEMETRY, id, doc as unknown as Record<string, unknown>, { evidence: "telemetry" });
      return json(res, 202, { ok: true });
    }
    if (p === "/api/v1/record" && m === "GET") {
      const team = q.get("team")?.toUpperCase() || undefined;
      const season = q.get("season") ? Number(q.get("season")) : undefined;
      const beforeSeq = q.get("before") ? Number(q.get("before")) : undefined;
      if (beforeSeq !== undefined && !Number.isFinite(beforeSeq)) throw new HttpError(400, "before: numeric seq cursor");
      const r = await listRecord(store, { team, season, limit: Math.min(100, Number(q.get("limit") ?? 30)), beforeSeq });
      { const rxc = await reactionCounts(store, COLL.observations, r.items.map((i) => i.id)); for (const it of r.items) it.reactions = rxc.get(it.id) ?? { like: 0, agree: 0, disagree: 0 }; }
      return json(res, 200, { count: r.items.length, total: r.total, next_before: r.next_before, seq: r.seq, head: r.head, items: r.items });
    }
    if ((mm = p.match(/^\/api\/v1\/observations\/([^/]+)$/)) && m === "GET") {
      const row = await store.get(COLL.observations, decodeURIComponent(mm[1]));
      if (!row) throw new HttpError(404, "observation not found");
      return json(res, 200, { _id: row._id, _hash: row._hash, _seq: row._seq, ...row.data });
    }
    if ((mm = p.match(/^\/api\/v1\/provenance\/([^/]+)\/([^/]+)$/)) && m === "GET") {
      const coll = decodeURIComponent(mm[1]);
      const id = decodeURIComponent(mm[2]);
      if (!/^(football|sr)_[a-z_]+$/.test(coll)) throw new HttpError(400, "collection must be a football_* or sr_* collection");
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
    if (p === "/api/v1/ingest/audit" && m === "GET") {
      const season = Number(q.get("season") ?? defaultSeason);
      if (!Number.isInteger(season)) throw new HttpError(400, "season: integer required");
      const a = await auditSeason(store, season);
      return json(res, 200, q.get("full") === "1" ? a : { ...a, per_game: undefined });
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
    const body = (await readJson(req)) as { question?: string; team?: string; season?: number; game_id?: string; play_id?: string; explain?: boolean; live?: boolean; mode?: string };
    const register: "fan" | "coach" = body.mode === "coach" ? "coach" : "fan";
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
        const season = (plan.filter?.season ?? (plan.filters.season as number) ?? defaultSeason) as number;
        // The Record: same inputs (intent, filters, calculation hashes, summary,
        // prompt version) => serve the stored answer instead of streaming a new
        // one. `live: true` forces a fresh stream; the old answer is kept.
        const key = evidenceKey(plan, pkg, undefined, register);
        qe.evidence_key = key; qe.register = register;
        const prior = body.live === true ? null : await findObservation(store, key).catch((e) => { log(`record lookup failed (streaming live instead): ${(e as Error).message}`); return null; });
        if (prior) {
          qe.observation_id = prior._id; qe.model = prior.data.model; qe.from_record = true;
          send("token", { text: prior.data.answer });
          send("observation", { id: prior._id, _hash: prior._hash, model: prior.data.model, latency_ms: 0, answer_truncated: false, from_record: true, recorded_at: prior.data.created_at, recorded_latency_ms: prior.data.latency_ms, register: prior.data.register ?? "fan" });
          send("done", { latency_ms: Date.now() - started });
          return;
        }
        for await (const ev of explain(llm, store, question, plan, pkg, { team, season, register }, log)) {
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
    if (rel === "/admin") rel = "/admin.html";
    // The admin shell holds no data, but it does not exist unless the server is configured for it.
    if (/^\/admin(\.html|\.js|\.css)?$/.test(rel) && !process.env.CHALK_ADMIN_TOKEN) throw new HttpError(404, "admin is not enabled (CHALK_ADMIN_TOKEN unset)");
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
      // index.html, app.js and styles.css revalidate on every load (ETag-less, tiny files): a deploy must never leave a browser running last week's client. Images/fonts keep a short cache.
      const revalidate = /\.(html|js|css)$/.test(file);
      res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream", "cache-control": revalidate ? "no-cache" : "public, max-age=300" });
      res.end(data);
    } catch (e) {
      throw new HttpError(404, `static file not found: ${rel} (${(e as Error).message})`);
    }
  }

  await new Promise<void>((resolve) => server.listen(opts.port, opts.host, resolve));
  await meta().catch((e) => log(`meta warmup failed: ${(e as Error).message}`));
  // The Record is looked up by evidence_key on every ask and listed by team; eq indexes keep both off the scan path. Idempotent.
  for (const field of ["evidence_key", "team"]) {
    await store.client.createIndex(COLL.observations, field, "eq").catch((e) => log(`index ${COLL.observations}.${field} failed (lookups fall back to scans): ${(e as Error).message}`));
  }

  // Data-change watcher: when another process (chalk ingest / chalk watch)
  // finishes a run, a new football_ingest_events row appears. Drop every
  // in-process cache so the next request recomputes against the new plays.
  // Polls a tiny collection; logs every invalidation.
  const watchMs = Number(process.env.CHALK_INGEST_WATCH_MS ?? 60_000);
  if (watchMs > 0) {
    const tick = async () => {
      try {
        // Stamp = last seq at which ingest / pulse actually wrote something —
        // NOT the event count: a do-nothing watch tick still writes its own
        // event row and must not mark every Home snapshot stale (v0.9.1).
        // queryFull bypasses the NQL cache on purpose: a watcher that reads its
        // own cached answer cannot see the ingest it is watching for.
        const [ingestEvents, pulseEvents] = await Promise.all([
          store.client.queryFull(`FROM ${COLL.ingest_events}`).then((r) => r.rows as IngestEventLike[]),
          store.client.queryFull(`FROM ${PULSE_EVENTS}`).then((r) => r.rows as PulseEventLike[]).catch((e) => { log(`ingest watcher: ${PULSE_EVENTS} unreadable (${(e as Error).message}) — pulse ignored in data stamp`); return [] as PulseEventLike[]; }),
        ]);
        // The code version rides along: a deploy that changes rating math must rebuild every snapshot once,
        // without anyone remembering ?fresh=1 (v0.12.2). Data-only ticks still hold the stamp.
        const next = `${dataStampFrom(ingestEvents, pulseEvents)}:v${CHALK_VERSION}`;
        if (dataStamp !== null && next !== dataStamp) {
          store.invalidateCache();
          invalidateLeagueCache();
          invalidateProfileCache();
          teamsCache = null;
          log(`data changed (stamp ${dataStamp} -> ${next}; ${ingestEvents.length} ingest runs, ${pulseEvents.length} pulse ticks on record): caches invalidated`);
        }
        dataStamp = next;
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
    const existing = await loadHomeSnapshot(store, defaultTeam, defaultSeason, THIRD_DOWN_DEFAULT_V1.id).catch(() => null);
    log(existing ? `warmup: persisted home snapshot for ${defaultTeam} ${defaultSeason} (data ${existing.data.data_stamp}, now ${dataStamp ?? "?"}) serves instantly; ${existing.data.data_stamp === dataStamp ? "fresh — no rebuild needed" : "stale — rebuilding in background"}` : `warmup: no persisted home for ${defaultTeam} ${defaultSeason} yet — building (first request will wait on this same build)`);
    (existing && existing.data.data_stamp === dataStamp ? Promise.resolve(existing.data.payload) : computeHome(defaultTeam, defaultSeason, THIRD_DOWN_DEFAULT_V1)).then(
      () => log(`warmup: home ${defaultTeam} ${defaultSeason} ready in ${Date.now() - t0}ms`),
      (e) => log(`warmup failed (server still serving): ${(e as Error).message}`),
    );
  }
  log(`CHALK listening on http://${opts.host}:${opts.port}  (nedb ${store.url}/${store.db}, llm ${llm ? `${llm.model}${llm.key ? "" : " [no key]"}` : "off"}, default ${defaultTeam} ${defaultSeason || "?"})`);
  return server;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const s = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(s), "x-powered-by": "CHALK (Interchained LLC) · BUSL-1.1" });
  res.end(s);
}

function clientIp(req: IncomingMessage): string {
  return (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() || req.socket.remoteAddress || "?";
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
    case "sr_posts": return `take by ${d.handle}`;
    case "sr_ratings": return `${d.handle} rated ${d.team} ${d.subject} ${d.score}`;
    case "sr_picks": return `${d.handle} picked ${d.pick} (${d.game_id})`;
    case "sr_favorites": return `${d.handle} favorite ${d.team}`;
    case "sr_hype": return `${d.handle} hype ${d.team} wk${d.week} = ${d.value}`;
    case "sr_reactions": return `${d.handle} ${d.reaction}`;
    case "sr_chain_tips": return `chain tip ${d.handle}`;
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
