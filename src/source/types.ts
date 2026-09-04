/**
 * FootballSource — the provider boundary.
 *
 * Everything CHALK knows about football enters through this interface. A
 * provider (NFLData today, Sportradar/imports/private datasets tomorrow) is
 * responsible for ONE thing: handing back its records verbatim, wrapped in a
 * SourceRecord envelope that says where each record came from. It never
 * normalizes. Normalization is CHALK's job, downstream, with lineage.
 *
 * Invariant (spec §3): the internal schema must never depend on one provider.
 * Nothing outside src/source/ may import a provider's field names.
 */

/** A single record exactly as the provider returned it, plus its address. */
export interface SourceRecord<T = unknown> {
  /** Provider id, e.g. "nfldata". */
  source: string;
  /** Provider endpoint the record came from, e.g. "/v1/plays". */
  endpoint: string;
  /** Provider-side identity of the record, e.g. "2025_18_CAR_TB:1012". */
  recordId: string;
  /** The payload, byte-for-byte as decoded from the provider. Never mutated. */
  payload: T;
  /** ISO timestamp of the HTTP response that carried the record. */
  retrievedAt: string;
}

export interface GameQuery {
  season?: number;
  week?: number;
  team?: string;
  gameType?: string;
}

export interface PlayQuery {
  gameId?: string;
  season?: number;
  week?: number;
}

export interface SourceMeta {
  source: string;
  seasons: number[];
  teams: Array<{ abbr: string; name: string; conf?: string; division?: string }>;
  /** Provider's own notion of freshness, when it publishes one. */
  lastRefresh?: string;
  /** Provider row counts or similar capacity hints, when published. */
  counts?: Record<string, number>;
}

/**
 * Pages are yielded, not accumulated: a season is ~49k plays and the caller
 * decides whether to stream them into NEDB or hold them.
 */
export interface FootballSource {
  readonly id: string;
  meta(): Promise<SourceMeta>;
  games(q: GameQuery): AsyncGenerator<SourceRecord[]>;
  game(gameId: string): Promise<SourceRecord | null>;
  plays(q: PlayQuery): AsyncGenerator<SourceRecord[]>;
  participation(gameId: string): AsyncGenerator<SourceRecord[]>;
  charting(gameId: string): AsyncGenerator<SourceRecord[]>;
}

export class SourceError extends Error {
  readonly status: number | null;
  readonly url: string;
  readonly body: string;
  constructor(message: string, url: string, status: number | null, body: string) {
    super(message);
    this.name = "SourceError";
    this.url = url;
    this.status = status;
    this.body = body;
  }
}
