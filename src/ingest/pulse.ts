/**
 * Pulse ingest — near-live observations into NEDB (V3 §6, §20).
 *
 * pulseTick(): ask the PulseSource for upcoming + recent (+ live when the
 * provider supports it), write each provider row as an immutable observation
 * in football_raw_pulse (same idempotency rule as historical ingest: identical
 * payload -> duplicate, changed payload -> new version caused_by the previous
 * + a source_changes event), then derive a football_game_state row per event
 * with lineage. The derived row is what the UI and the deviation engine read.
 *
 * game_state ids are `${provider}:${event_id}`; when a pulse event can be
 * matched to an NFLData game_id (same season, home, away) we record it so the
 * live layer joins the knowledge layer.
 */
import { COLL } from "../store/collections.ts";
import { deterministicId, hashPayload } from "../store/hash.ts";
import { nqlStr, type NedbRow } from "../store/nedb.ts";
import type { Store } from "../store/nedb.ts";
import type { PulseSource, PulseGameState } from "../source/pulse.ts";
import type { SourceRecord } from "../source/types.ts";
import type { Game } from "../model/football.ts";
import { INGEST_VERSION, diffKeys, type RawDoc } from "./ingest.ts";

export const PULSE_NORMALIZER = "chalk-normalize-pulse";
export const PULSE_NORMALIZER_VERSION = "0.1.0";
export const RAW_PULSE = "football_raw_pulse";
export const GAME_STATE = "football_game_state";
export const PULSE_EVENTS = "football_pulse_events";

export interface GameStateDoc extends PulseGameState {
  id: string;
  source: string;
  /** NFLData game_id when matched, else null. */
  game_id: string | null;
  /** Coarse phase derived from status/scores — provider-agnostic. */
  phase: "scheduled" | "live" | "final" | "unknown";
  observed_at: string;
  derived_from: string[];
  normalizer: string;
  normalizer_version: string;
  created_at: string;
}

export interface PulseTickResult {
  tick_id: string;
  source: string;
  observations: number;
  raw_written: number;
  raw_duplicates: number;
  raw_changed: number;
  states_written: number;
  states_skipped: number;
  live_games: string[];
  errors: Array<{ where: string; id?: string; error: string }>;
  nedb_seq: number;
  nedb_head: string;
  duration_ms: number;
}

export async function pulseTick(opts: {
  store: Store;
  source: PulseSource;
  /** Known NFLData games for matching (season -> games). Optional. */
  knownGames?: Game[];
  log?: (l: string) => void;
  now?: () => string;
}): Promise<PulseTickResult> {
  const { store, source } = opts;
  const log = opts.log ?? (() => {});
  const now = opts.now ?? (() => new Date().toISOString());
  const started = Date.now();
  const r: PulseTickResult = {
    tick_id: "",
    source: source.id,
    observations: 0,
    raw_written: 0,
    raw_duplicates: 0,
    raw_changed: 0,
    states_written: 0,
    states_skipped: 0,
    live_games: [],
    errors: [],
    nedb_seq: 0,
    nedb_head: "",
    duration_ms: 0,
  };
  await store.ensureDatabase();

  const recs: SourceRecord[] = [];
  for (const [name, fn] of [["upcoming", () => source.upcoming()], ["recent", () => source.recent()], ["live", () => source.live()]] as const) {
    try {
      const rows = await fn();
      recs.push(...rows);
      log(`pulse ${source.id}.${name}: ${rows.length} rows`);
    } catch (e) {
      r.errors.push({ where: name, error: (e as Error).message });
      log(`pulse ${source.id}.${name} FAILED: ${(e as Error).message}`);
    }
  }
  r.observations = recs.length;

  // Existing raws + states for this provider in two queries.
  const existingRaw = new Map<string, NedbRow<RawDoc>>();
  for (const row of await store.query<RawDoc>(`FROM ${RAW_PULSE} WHERE source = ${nqlStr(source.id)}`)) existingRaw.set(row._id, row);
  const existingState = new Map<string, NedbRow<GameStateDoc>>();
  for (const row of await store.query<GameStateDoc>(`FROM ${GAME_STATE} WHERE source = ${nqlStr(source.id)}`)) existingState.set(row._id, row);

  const byEvent = new Map<string, SourceRecord>();
  for (const rec of recs) byEvent.set(rec.recordId, rec); // live wins over schedule for the same event (last write)

  for (const rec of byEvent.values()) {
    const rawIdStr = `${rec.source}:pulse:${rec.recordId}`;
    const hash = hashPayload(rec.payload);
    const prev = existingRaw.get(rawIdStr) ?? null;
    let rawHash: string;
    try {
      if (prev && prev.data.source_hash === hash) {
        r.raw_duplicates++;
        rawHash = prev._hash;
      } else {
        const doc: RawDoc = {
          source: rec.source,
          source_endpoint: rec.endpoint,
          source_record_id: rec.recordId,
          source_payload: rec.payload,
          source_hash: hash,
          source_retrieved_at: rec.retrievedAt,
          ingest_version: INGEST_VERSION,
          source_version: prev ? (prev.data.source_version ?? 1) + 1 : 1,
        };
        const row = await store.put(RAW_PULSE, rawIdStr, doc as unknown as Record<string, unknown>, {
          causedBy: prev ? [prev._hash] : undefined,
          evidence: prev ? "pulse observation changed" : "pulse observation",
        });
        r.raw_written++;
        rawHash = row._hash;
        if (prev) {
          r.raw_changed++;
          await store.put(
            COLL.source_changes,
            deterministicId("srcchg", { rawIdStr, from: prev._hash, to: row._hash }),
            {
              raw_collection: RAW_PULSE,
              raw_id: rawIdStr,
              source: rec.source,
              source_record_id: rec.recordId,
              previous_hash: prev._hash,
              new_hash: row._hash,
              previous_source_version: prev.data.source_version ?? 1,
              new_source_version: doc.source_version,
              changed_fields: diffKeys(prev.data.source_payload, rec.payload),
              detected_at: now(),
              ingest_version: INGEST_VERSION,
            },
            { causedBy: [prev._hash, row._hash], evidence: "pulse record changed" },
          );
        }
      }
      // Derived game state.
      const gs = source.toGameState(rec);
      const phase = phaseOf(gs);
      const game_id = matchGame(gs, opts.knownGames ?? []);
      const stateId = `${rec.source}:${gs.provider_event_id}`;
      const prevState = existingState.get(stateId);
      if (prevState && prevState.data.derived_from?.[0] === rawHash && prevState.data.normalizer_version === PULSE_NORMALIZER_VERSION) {
        r.states_skipped++;
      } else {
        const doc: GameStateDoc = {
          ...gs,
          id: stateId,
          source: rec.source,
          game_id,
          phase,
          observed_at: rec.retrievedAt,
          derived_from: [rawHash],
          normalizer: PULSE_NORMALIZER,
          normalizer_version: PULSE_NORMALIZER_VERSION,
          created_at: now(),
        };
        await store.put(GAME_STATE, stateId, doc as unknown as Record<string, unknown>, {
          causedBy: prevState ? [rawHash, prevState._hash] : [rawHash],
          evidence: `${PULSE_NORMALIZER}@${PULSE_NORMALIZER_VERSION}`,
        });
        r.states_written++;
      }
      if (phase === "live") r.live_games.push(stateId);
    } catch (e) {
      r.errors.push({ where: "event", id: rec.recordId, error: (e as Error).message });
    }
  }

  r.nedb_seq = await store.seq();
  r.nedb_head = await store.head();
  r.duration_ms = Date.now() - started;
  r.tick_id = deterministicId("pulse", { source: source.id, at: started });
  await store.put(PULSE_EVENTS, r.tick_id, { ...r, created_at: now() }, { evidence: "pulse tick" });
  log(`pulse tick ${r.tick_id}: obs=${r.observations} raw+${r.raw_written} dup=${r.raw_duplicates} chg=${r.raw_changed} state+${r.states_written} live=${r.live_games.length} errors=${r.errors.length} seq=${r.nedb_seq}`);
  return r;
}

export function phaseOf(gs: PulseGameState): GameStateDoc["phase"] {
  const s = (gs.status ?? "").toLowerCase();
  if (/finished|final|ft|after over time|aot/.test(s)) return "final";
  if (/not started|ns|scheduled|time to be defined|tbd|postponed/.test(s)) return "scheduled";
  if (/q[1-4]|quarter|half|ot|overtime|in play|live|1st|2nd|3rd|4th/.test(s) || (gs.progress && gs.progress.length)) return "live";
  if (gs.home_score !== null && gs.away_score !== null) {
    // Scores present, no status: final if kickoff is well in the past, live if within a game window.
    if (gs.kickoff) {
      const age = Date.now() - Date.parse(gs.kickoff);
      if (age > 5 * 3600_000) return "final";
      if (age > 0) return "live";
    }
    return "unknown";
  }
  return gs.kickoff && Date.parse(gs.kickoff) > Date.now() ? "scheduled" : "unknown";
}

export function matchGame(gs: PulseGameState, games: Game[]): string | null {
  const season = gs.season ? Number(gs.season) : null;
  const hit = games.find((g) => g.home_team === gs.home_team && g.away_team === gs.away_team && (season === null || g.season === season));
  return hit ? hit.id : null;
}

/** Cadence loop; the ONLY place polling exists (V3 §20). */
export async function pulseLoop(opts: {
  store: Store;
  source: PulseSource;
  intervalMs: number;
  knownGames?: () => Promise<Game[]>;
  log?: (l: string) => void;
  onTick?: (r: PulseTickResult) => void;
  signal?: AbortSignal;
}): Promise<void> {
  const log = opts.log ?? (() => {});
  while (!opts.signal?.aborted) {
    try {
      const knownGames = opts.knownGames ? await opts.knownGames() : [];
      const r = await pulseTick({ store: opts.store, source: opts.source, knownGames, log });
      opts.onTick?.(r);
    } catch (e) {
      log(`pulse loop tick failed: ${(e as Error).message}`);
    }
    await new Promise((res) => setTimeout(res, opts.intervalMs));
  }
  log("pulse loop stopped");
}
