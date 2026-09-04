/**
 * NFLDataSource — adapter for the public NFLData.org API
 * (https://api.nfldata.org, OpenAPI 3.1 at /openapi.json).
 *
 * Verified against the live contract on 2026-09-03:
 *   GET /v1/games          season, week, team, game_type, limit<=1000, offset
 *   GET /v1/games/{id}
 *   GET /v1/plays          game_id, season, week, play_type, limit<=500, offset
 *                          (NO team filter — CHALK filters posteam downstream)
 *   GET /v1/participation  game_id, limit<=1000, offset
 *   GET /v1/charting       game_id, season, week, limit<=1000, offset
 *   GET /v1/meta           seasons[], teams[]
 *   GET /v1/health         row_counts, last_refresh
 *
 * Paginated responses are { data, total, limit, offset }.
 *
 * This file is the ONLY place NFLData field names are allowed to appear on the
 * read side. It does not interpret them; it wraps and yields.
 */
import { SourceError } from "./types.ts";
import type {
  FootballSource,
  GameQuery,
  PlayQuery,
  SourceMeta,
  SourceRecord,
} from "./types.ts";

export interface NFLDataOptions {
  baseUrl?: string;
  /** Per-request timeout. Default 60s — season pages are ~500 rows. */
  timeoutMs?: number;
  /** Retries on 429/5xx/network. Default 4 with exponential backoff. */
  retries?: number;
  userAgent?: string;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  /** Called after every HTTP response — the observability hook. */
  onRequest?: (info: { url: string; status: number; ms: number; rows: number }) => void;
}

interface Paginated<T> {
  data: T[];
  total: number;
  limit: number;
  offset: number;
}

const PLAYS_PAGE = 500;
const WIDE_PAGE = 1000;

export class NFLDataSource implements FootballSource {
  readonly id = "nfldata";
  private readonly base: string;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly ua: string;
  private readonly fetchImpl: typeof fetch;
  private readonly onRequest?: NFLDataOptions["onRequest"];

  constructor(opts: NFLDataOptions = {}) {
    this.base = (opts.baseUrl ?? "https://api.nfldata.org").replace(/\/+$/, "");
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.retries = opts.retries ?? 5;
    this.ua = opts.userAgent ?? "chalk-engine/0.1 (+https://sports-rater.com)";
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.onRequest = opts.onRequest;
  }

  async meta(): Promise<SourceMeta> {
    const [meta, health] = await Promise.all([
      this.getJson<{ seasons: number[]; teams: SourceMeta["teams"] }>("/v1/meta", {}),
      this.getJson<{ row_counts?: Record<string, number>; last_refresh?: string }>("/v1/health", {}),
    ]);
    return {
      source: this.id,
      seasons: meta.body.seasons,
      teams: meta.body.teams,
      lastRefresh: health.body.last_refresh,
      counts: health.body.row_counts,
    };
  }

  async *games(q: GameQuery): AsyncGenerator<SourceRecord[]> {
    yield* this.paginate("/v1/games", {
      season: q.season,
      week: q.week,
      team: q.team,
      game_type: q.gameType,
    }, WIDE_PAGE, (row) => String((row as { game_id: string }).game_id));
  }

  async game(gameId: string): Promise<SourceRecord | null> {
    const endpoint = `/v1/games/${encodeURIComponent(gameId)}`;
    try {
      const { body, retrievedAt } = await this.getJson<Record<string, unknown>>(endpoint, {});
      return { source: this.id, endpoint: "/v1/games/{game_id}", recordId: gameId, payload: body, retrievedAt };
    } catch (e) {
      if (e instanceof SourceError && e.status === 404) return null;
      throw e;
    }
  }

  async *plays(q: PlayQuery): AsyncGenerator<SourceRecord[]> {
    if (!q.gameId && q.season === undefined) {
      throw new Error("NFLDataSource.plays: need gameId or season (a bare /v1/plays walk is 1.28M rows)");
    }
    yield* this.paginate("/v1/plays", {
      game_id: q.gameId,
      season: q.season,
      week: q.week,
    }, PLAYS_PAGE, (row) => {
      const r = row as { game_id: string; play_id: number };
      return `${r.game_id}:${r.play_id}`;
    });
  }

  async *participation(gameId: string): AsyncGenerator<SourceRecord[]> {
    yield* this.paginate("/v1/participation", { game_id: gameId }, WIDE_PAGE, (row) => {
      const r = row as { game_id: string; play_id: number };
      return `${r.game_id}:${r.play_id}`;
    });
  }

  async *charting(gameId: string): AsyncGenerator<SourceRecord[]> {
    yield* this.paginate("/v1/charting", { game_id: gameId }, WIDE_PAGE, (row) => {
      const r = row as { game_id: string; play_id: number };
      return `${r.game_id}:${r.play_id}`;
    });
  }

  // ---------------------------------------------------------------- internals

  private async *paginate(
    endpoint: string,
    params: Record<string, string | number | undefined>,
    pageSize: number,
    idOf: (row: unknown) => string,
  ): AsyncGenerator<SourceRecord[]> {
    let offset = 0;
    for (;;) {
      const { body, retrievedAt } = await this.getJson<Paginated<unknown>>(endpoint, {
        ...params,
        limit: pageSize,
        offset,
      });
      const rows = body.data ?? [];
      if (rows.length > 0) {
        yield rows.map((payload) => ({
          source: this.id,
          endpoint,
          recordId: idOf(payload),
          payload,
          retrievedAt,
        }));
      }
      offset += rows.length;
      const total = typeof body.total === "number" ? body.total : offset;
      if (offset >= total) return;
      // A short page BEFORE the advertised total is the source contradicting
      // itself (throttled/partial 200). Refuse to accept it quietly: throw so
      // the caller records the game in `errors` and refetches next run, rather
      // than a season silently coming up one game short.
      if (rows.length < pageSize) {
        throw new SourceError(`${endpoint} short page: got ${offset} of advertised ${total} rows (page ${rows.length}/${pageSize}, ${JSON.stringify(params)}) — incomplete upstream response`, endpoint, 200, JSON.stringify(body).slice(0, 200));
      }
      if (rows.length === 0) return; // total > 0 but a full-size empty page cannot happen; guard against a loop
    }
  }

  private async getJson<T>(
    endpoint: string,
    params: Record<string, string | number | undefined>,
  ): Promise<{ body: T; retrievedAt: string }> {
    const url = new URL(this.base + endpoint);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }
    let attempt = 0;
    let lastErr: unknown;
    while (attempt <= this.retries) {
      const started = Date.now();
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
      try {
        const res = await this.fetchImpl(url, {
          headers: { accept: "application/json", "user-agent": this.ua },
          signal: ctl.signal,
        });
        const text = await res.text();
        const ms = Date.now() - started;
        if (res.ok) {
          const body = JSON.parse(text) as T;
          const rows = Array.isArray((body as { data?: unknown[] })?.data)
            ? (body as { data: unknown[] }).data.length
            : 1;
          this.onRequest?.({ url: url.toString(), status: res.status, ms, rows });
          return { body, retrievedAt: new Date().toISOString() };
        }
        this.onRequest?.({ url: url.toString(), status: res.status, ms, rows: 0 });
        // 403 is included: api.nfldata.org sits behind Cloudflare and answers
        // 403 (not 429) when a client is throttled mid-run. Observed 2026-09-03
        // during a 285-game ingest — 64 games 403'd, all 200 again minutes later.
        const retryable = res.status === 429 || res.status === 403 || res.status >= 500;
        lastErr = new SourceError(
          `nfldata ${res.status} ${res.statusText} for ${url}`,
          url.toString(),
          res.status,
          text.slice(0, 2000),
        );
        if (!retryable) throw lastErr;
        const retryAfter = Number(res.headers.get("retry-after"));
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoff(attempt));
      } catch (e) {
        if (e instanceof SourceError) throw e;
        lastErr = new SourceError(
          `nfldata network failure for ${url}: ${(e as Error).message}`,
          url.toString(),
          null,
          "",
        );
        await sleep(backoff(attempt));
      } finally {
        clearTimeout(timer);
      }
      attempt++;
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }
}

function backoff(attempt: number): number {
  // 2s, 4s, 8s, 16s, 32s (+jitter), capped at 45s — throttles clear in tens of seconds.
  return Math.min(45_000, 2_000 * 2 ** attempt) + Math.floor(Math.random() * 500);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
