/**
 * Ingest — provider records -> immutable raw versions -> normalized records,
 * idempotently, with source-change detection and a per-run ingest event.
 *
 * Idempotency model (verified: nedbd re-puts always create a new version, so
 * dedup is CHALK's job):
 *   raw id      = `${source}:${endpoint}:${recordId}`   (deterministic)
 *   source_hash = blake2b(canonical payload)
 *   existing raw with same source_hash   -> duplicate, no write
 *   existing raw with different hash     -> new raw version (caused_by previous)
 *                                           + football_source_changes event
 *   no existing raw                      -> write
 *
 *   normalized id = provider recordId (game_id, or game_id:play_id)
 *   normalized derived_from == current raw hash && same normalizer version
 *                                        -> skip
 *   otherwise                            -> write, caused_by [raw hash]
 *
 * Every run ends with a football_ingest_events record carrying the counters
 * and the NEDB head/seq after the run — NEDB dogfooded visibly (spec §38).
 */
import { COLL } from "../store/collections.ts";
import { hashPayload, deterministicId } from "../store/hash.ts";
import { ChalkStore, nqlStr, type NedbRow } from "../store/nedb.ts";
import type { FootballSource, SourceRecord } from "../source/types.ts";
import type { Game, Play } from "../model/football.ts";
import {
  normalizeNflDataGame,
  normalizeNflDataPlay,
  GAME_NORMALIZER_VERSION,
  PLAY_NORMALIZER_VERSION,
} from "./normalize.ts";

export const INGEST_VERSION = "0.1.0";

export interface RawDoc {
  source: string;
  source_endpoint: string;
  source_record_id: string;
  source_payload: unknown;
  source_hash: string;
  source_retrieved_at: string;
  ingest_version: string;
  /** Monotonic per raw id — 1 for first observation, 2 when upstream changed, ... */
  source_version: number;
}

export interface IngestCounters {
  games_fetched: number;
  plays_fetched: number;
  raw_written: number;
  raw_duplicates: number;
  raw_changed: number;
  normalized_written: number;
  normalized_skipped: number;
  errors: Array<{ where: string; id?: string; error: string }>;
}

export interface IngestResult extends IngestCounters {
  run_id: string;
  source: string;
  scope: IngestScope;
  started_at: string;
  finished_at: string;
  duration_ms: number;
  nedb_seq: number;
  nedb_head: string;
  /** Hash of the ingest event document as stored. */
  event_hash: string;
  /** Games processed in this run. */
  game_ids: string[];
}

export interface IngestScope {
  season?: number;
  week?: number;
  team?: string;
  gameId?: string;
  /** Also pull /participation and /charting raw rows for each game. */
  deep?: boolean;
}

export interface IngestOptions {
  store: ChalkStore;
  source: FootballSource;
  scope: IngestScope;
  log?: (line: string) => void;
  /** Progress callback after each game. */
  onProgress?: (c: IngestCounters & { game_id: string; games_done: number; games_total: number }) => void;
  now?: () => string;
}

export async function ingest(opts: IngestOptions): Promise<IngestResult> {
  const { store, source, scope } = opts;
  const log = opts.log ?? (() => {});
  const now = opts.now ?? (() => new Date().toISOString());
  const started = Date.now();
  const started_at = now();
  const counters: IngestCounters = {
    games_fetched: 0,
    plays_fetched: 0,
    raw_written: 0,
    raw_duplicates: 0,
    raw_changed: 0,
    normalized_written: 0,
    normalized_skipped: 0,
    errors: [],
  };

  await store.ensureDatabase();

  // 1. Resolve the game list for the scope.
  const gameRecords: SourceRecord[] = [];
  if (scope.gameId) {
    const g = await source.game(scope.gameId);
    if (!g) throw new Error(`ingest: game ${scope.gameId} not found at ${source.id}`);
    gameRecords.push(g);
  } else {
    if (scope.season === undefined) throw new Error("ingest: scope needs season or gameId");
    for await (const page of source.games({ season: scope.season, week: scope.week, team: scope.team })) {
      gameRecords.push(...page);
    }
  }
  // Providers may list future/unplayed games. Drop games without a score —
  // there are no plays to ingest and normalizing them would create ghost rows.
  const playable = gameRecords.filter((g) => {
    const p = g.payload as { home_score?: unknown; away_score?: unknown };
    return typeof p.home_score === "number" && typeof p.away_score === "number";
  });
  counters.games_fetched = playable.length;
  log(`scope ${JSON.stringify(scope)} -> ${gameRecords.length} games listed, ${playable.length} with results`);

  // 2. Raw + normalized games.
  const games: Map<string, { game: Game; rawHash: string }> = new Map();
  for (const rec of playable) {
    try {
      const raw = await upsertRaw(store, COLL.raw_games, rec, counters, now);
      const game = normalizeNflDataGame(rec.payload as Record<string, unknown>, raw._hash, now());
      await upsertNormalized(store, COLL.games, game.id, game as unknown as Record<string, unknown>, raw._hash, GAME_NORMALIZER_VERSION, counters);
      games.set(game.id, { game, rawHash: raw._hash });
    } catch (e) {
      counters.errors.push({ where: "game", id: rec.recordId, error: (e as Error).message });
      log(`ERROR game ${rec.recordId}: ${(e as Error).message}`);
    }
  }

  // 3. Plays per game — one query for existing raws + one for existing
  //    normalized per game, then batched writes.
  const gameIds = [...games.keys()].sort();
  let done = 0;
  for (const gameId of gameIds) {
    const ctx = games.get(gameId)!;
    try {
      const fetched: SourceRecord[] = [];
      for await (const page of source.plays({ gameId })) fetched.push(...page);
      counters.plays_fetched += fetched.length;
      await ingestPlaysForGame(store, gameId, fetched, ctx.game, counters, now, log);
      if (scope.deep) {
        for await (const page of source.participation(gameId)) {
          for (const rec of page) await upsertRaw(store, COLL.raw_participation, rec, counters, now);
        }
        for await (const page of source.charting(gameId)) {
          for (const rec of page) await upsertRaw(store, COLL.raw_charting, rec, counters, now);
        }
      }
    } catch (e) {
      counters.errors.push({ where: "plays", id: gameId, error: (e as Error).message });
      log(`ERROR plays ${gameId}: ${(e as Error).message}`);
    }
    done++;
    opts.onProgress?.({ ...counters, game_id: gameId, games_done: done, games_total: gameIds.length });
  }

  // 4. Indexes. Every coarse NQL the engines issue filters on these fields;
  //    without eq indexes each query is a full scan of the play table
  //    (measured 1.7s for a 9-row game query over 48k plays). Idempotent.
  await ensureIndexes(store, log);

  // 5. Ingest event.
  const finished_at = now();
  const seq = await store.seq();
  const head = await store.head();
  const run_id = deterministicId("ingest", { source: source.id, scope, started_at });
  const eventDoc = {
    run_id,
    source: source.id,
    scope,
    ingest_version: INGEST_VERSION,
    started_at,
    finished_at,
    duration_ms: Date.now() - started,
    ...counters,
    nedb_seq_after: seq,
    nedb_head_after: head,
    game_ids: gameIds,
  };
  const ev = await store.put(COLL.ingest_events, run_id, eventDoc, { evidence: `ingest@${INGEST_VERSION}` });
  log(
    `ingest ${run_id}: games=${counters.games_fetched} plays=${counters.plays_fetched} raw+${counters.raw_written} dup=${counters.raw_duplicates} changed=${counters.raw_changed} norm+${counters.normalized_written} skip=${counters.normalized_skipped} errors=${counters.errors.length} seq=${seq} head=${head.slice(0, 12)}…`,
  );
  return {
    run_id,
    source: source.id,
    scope,
    started_at,
    finished_at,
    duration_ms: Date.now() - started,
    ...counters,
    nedb_seq: seq,
    nedb_head: head,
    event_hash: ev._hash,
    game_ids: gameIds,
  };
}

export const INDEXES: Array<{ coll: string; field: string }> = [
  { coll: COLL.plays, field: "game_id" },
  { coll: COLL.plays, field: "posteam" },
  { coll: COLL.plays, field: "defteam" },
  { coll: COLL.plays, field: "season" },
  { coll: COLL.raw_plays, field: "source_record_id_game" },
  { coll: COLL.games, field: "season" },
];

export async function ensureIndexes(store: ChalkStore, log: (l: string) => void = () => {}): Promise<void> {
  for (const ix of INDEXES) {
    try {
      await store.client.createIndex(ix.coll, ix.field, "eq");
    } catch (e) {
      log(`index ${ix.coll}.${ix.field} failed: ${(e as Error).message}`);
    }
  }
}

// --------------------------------------------------------------------- raws

export function rawId(rec: Pick<SourceRecord, "source" | "endpoint" | "recordId">): string {
  return `${rec.source}:${rec.endpoint}:${rec.recordId}`;
}

/** Single-record raw upsert (games, deep collections). */
async function upsertRaw(
  store: ChalkStore,
  coll: string,
  rec: SourceRecord,
  counters: IngestCounters,
  now: () => string,
): Promise<NedbRow<RawDoc>> {
  const id = rawId(rec);
  const hash = hashPayload(rec.payload);
  const existing = await store.get<RawDoc>(coll, id);
  return decideAndWriteRaw(store, coll, id, rec, hash, existing, counters, now);
}

async function decideAndWriteRaw(
  store: ChalkStore,
  coll: string,
  id: string,
  rec: SourceRecord,
  hash: string,
  existing: NedbRow<RawDoc> | null,
  counters: IngestCounters,
  now: () => string,
): Promise<NedbRow<RawDoc>> {
  if (existing && existing.data.source_hash === hash) {
    counters.raw_duplicates++;
    return existing;
  }
  const doc: RawDoc = {
    source: rec.source,
    source_endpoint: rec.endpoint,
    source_record_id: rec.recordId,
    source_payload: rec.payload,
    source_hash: hash,
    source_retrieved_at: rec.retrievedAt,
    ingest_version: INGEST_VERSION,
    source_version: existing ? (existing.data.source_version ?? 1) + 1 : 1,
  };
  const row = (await store.put(coll, id, doc as unknown as Record<string, unknown>, {
    causedBy: existing ? [existing._hash] : undefined,
    evidence: existing ? `source change detected by ingest@${INGEST_VERSION}` : `ingest@${INGEST_VERSION}`,
  })) as unknown as NedbRow<RawDoc>;
  counters.raw_written++;
  if (existing) {
    counters.raw_changed++;
    await recordSourceChange(store, coll, id, existing, row, now);
  }
  return row;
}

async function recordSourceChange(
  store: ChalkStore,
  coll: string,
  rawIdStr: string,
  before: NedbRow<RawDoc>,
  after: NedbRow<RawDoc>,
  now: () => string,
): Promise<void> {
  const changed_fields = diffKeys(before.data.source_payload, after.data.source_payload);
  const id = deterministicId("srcchg", { rawIdStr, from: before._hash, to: after._hash });
  await store.put(
    COLL.source_changes,
    id,
    {
      raw_collection: coll,
      raw_id: rawIdStr,
      source: after.data.source,
      source_record_id: after.data.source_record_id,
      previous_hash: before._hash,
      previous_source_hash: before.data.source_hash,
      new_hash: after._hash,
      new_source_hash: after.data.source_hash,
      previous_source_version: before.data.source_version ?? 1,
      new_source_version: after.data.source_version,
      changed_fields,
      detected_at: now(),
      ingest_version: INGEST_VERSION,
    },
    { causedBy: [before._hash, after._hash], evidence: "upstream record changed" },
  );
}

/** Top-level keys whose canonical value differs. */
export function diffKeys(a: unknown, b: unknown): string[] {
  const ao = (a ?? {}) as Record<string, unknown>;
  const bo = (b ?? {}) as Record<string, unknown>;
  const keys = new Set([...Object.keys(ao), ...Object.keys(bo)]);
  const out: string[] = [];
  for (const k of keys) {
    if (JSON.stringify(ao[k] ?? null) !== JSON.stringify(bo[k] ?? null)) out.push(k);
  }
  return out.sort();
}

// ---------------------------------------------------------------- normalized

async function upsertNormalized(
  store: ChalkStore,
  coll: string,
  id: string,
  doc: Record<string, unknown>,
  rawHash: string,
  normalizerVersion: string,
  counters: IngestCounters,
): Promise<void> {
  const existing = await store.get<{ derived_from?: string[]; normalizer_version?: string }>(coll, id);
  if (
    existing &&
    existing.data.derived_from?.[0] === rawHash &&
    existing.data.normalizer_version === normalizerVersion
  ) {
    counters.normalized_skipped++;
    return;
  }
  await store.put(coll, id, doc, {
    causedBy: existing ? [rawHash, existing._hash] : [rawHash],
    evidence: `${String(doc.normalizer)}@${normalizerVersion}`,
  });
  counters.normalized_written++;
}

/**
 * Plays for one game. Bulk-reads the existing raw + normalized rows for the
 * game (two NQL queries), decides per play, then batch-writes.
 */
async function ingestPlaysForGame(
  store: ChalkStore,
  gameId: string,
  fetched: SourceRecord[],
  game: Game,
  counters: IngestCounters,
  now: () => string,
  log: (l: string) => void,
): Promise<void> {
  // NQL cannot address nested fields (verified: `source_payload.game_id = X`
  // returns zero rows silently), so raw play docs carry a top-level
  // `source_record_id_game` key purely for this lookup.
  const existingRaw = new Map<string, NedbRow<RawDoc>>();
  for (const r of await store.query<RawDoc>(`FROM ${COLL.raw_plays} WHERE source_record_id_game = ${nqlStr(gameId)}`)) {
    existingRaw.set(r._id, r);
  }
  const existingNorm = new Map<string, NedbRow<Play>>();
  for (const r of await store.query<Play>(`FROM ${COLL.plays} WHERE game_id = ${nqlStr(gameId)}`)) {
    existingNorm.set(r._id, r);
  }

  // Raw decisions.
  const rawOps: Array<{ coll: string; id: string; doc: Record<string, unknown>; causedBy?: string[]; rec: SourceRecord; hash: string; prev: NedbRow<RawDoc> | null }> = [];
  const rawHashById = new Map<string, string>();
  for (const rec of fetched) {
    const id = rawId(rec);
    const hash = hashPayload(rec.payload);
    const prev = existingRaw.get(id) ?? null;
    if (prev && prev.data.source_hash === hash) {
      counters.raw_duplicates++;
      rawHashById.set(rec.recordId, prev._hash);
      continue;
    }
    const doc: RawDoc & { source_record_id_game: string } = {
      source: rec.source,
      source_endpoint: rec.endpoint,
      source_record_id: rec.recordId,
      source_record_id_game: gameId,
      source_payload: rec.payload,
      source_hash: hash,
      source_retrieved_at: rec.retrievedAt,
      ingest_version: INGEST_VERSION,
      source_version: prev ? (prev.data.source_version ?? 1) + 1 : 1,
    };
    rawOps.push({
      coll: COLL.raw_plays,
      id,
      doc: doc as unknown as Record<string, unknown>,
      causedBy: prev ? [prev._hash] : undefined,
      rec,
      hash,
      prev,
    });
  }
  if (rawOps.length) {
    const res = await store.batchPut(rawOps);
    counters.raw_written += res.written;
    for (const e of res.errors) counters.errors.push({ where: "raw_play", id: e.id, error: e.error });
    // /batch returns the stored hash per op (verified live) — no readback needed.
    for (const op of rawOps) {
      const h = res.hashes.get(op.id);
      if (!h) {
        counters.errors.push({ where: "raw_play_hash", id: op.id, error: "batch result carried no hash for this op" });
        continue;
      }
      rawHashById.set(op.rec.recordId, h);
      if (op.prev) {
        counters.raw_changed++;
        const after: NedbRow<RawDoc> = { _id: op.id, _hash: h, _seq: -1, _coll: COLL.raw_plays, data: op.doc as unknown as RawDoc };
        await recordSourceChange(store, COLL.raw_plays, op.id, op.prev, after, now);
      }
    }
  }

  // Normalized decisions.
  const normOps: Array<{ coll: string; id: string; doc: Record<string, unknown>; causedBy?: string[] }> = [];
  const ts = now();
  for (const rec of fetched) {
    const rawHash = rawHashById.get(rec.recordId);
    if (!rawHash) continue; // error already recorded
    const play = normalizeNflDataPlay(rec.payload as Record<string, unknown>, rawHash, game, ts);
    const prev = existingNorm.get(play.id);
    if (prev && prev.data.derived_from?.[0] === rawHash && prev.data.normalizer_version === PLAY_NORMALIZER_VERSION) {
      counters.normalized_skipped++;
      continue;
    }
    normOps.push({
      coll: COLL.plays,
      id: play.id,
      doc: play as unknown as Record<string, unknown>,
      causedBy: prev ? [rawHash, prev._hash] : [rawHash],
    });
  }
  if (normOps.length) {
    const res = await store.batchPut(normOps);
    counters.normalized_written += res.written;
    for (const e of res.errors) counters.errors.push({ where: "play", id: e.id, error: e.error });
  }
  log(`  ${gameId}: fetched=${fetched.length} raw+${rawOps.length} norm+${normOps.length}`);
}
