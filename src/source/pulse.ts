/*
 * SPDX-License-Identifier: BUSL-1.1
 * Copyright (c) 2026 Interchained LLC. All rights reserved.
 * CHALK / Sports-Rater — https://sports-rater.com — Licensor: Interchained LLC
 */
/**
 * PulseSource — the near-live provider boundary (V3 §4).
 *
 * A PulseSource hands back CHANGING game state while games happen: schedule,
 * scores, clock/period, and discrete events, each wrapped in a SourceRecord so
 * it lands in NEDB as an immutable observation. CHALK never polls a provider
 * from business logic — `pulseTick()` in src/ingest/pulse.ts is the only
 * caller, and it runs on a cadence the operator chooses.
 *
 * Pulse v1 = TheSportsDB. Free tier (key "3") is verified live for the
 * schedule/scores endpoints below; Premium (~$9/mo) adds `livescore` at
 * ~2-minute freshness. CHALK calls this near-live, never realtime.
 *
 * Future: SportradarSource implements PulseSource with no engine change.
 */
import { SourceError } from "./types.ts";
import type { SourceRecord } from "./types.ts";

export interface PulseGameState {
  /** Provider event id. */
  provider_event_id: string;
  home_team: string;
  away_team: string;
  home_score: number | null;
  away_score: number | null;
  /** Provider status string verbatim (e.g. "Not Started", "Match Finished", "Q3"). */
  status: string | null;
  /** Provider's kickoff timestamp (ISO) when known. */
  kickoff: string | null;
  /** Provider's progress/clock string verbatim when present. */
  progress: string | null;
  season: string | null;
  /** Provider round/week when present. */
  round: string | null;
}

export interface PulseSource {
  readonly id: string;
  /** Upcoming league games (schedule). */
  upcoming(): Promise<SourceRecord[]>;
  /** Recently completed league games with final scores. */
  recent(): Promise<SourceRecord[]>;
  /** Games in progress right now. Premium-only on TheSportsDB; free tier returns []. */
  live(): Promise<SourceRecord[]>;
  /** One event by provider id. */
  event(providerEventId: string): Promise<SourceRecord | null>;
  /** Provider payload -> PulseGameState (adapter-owned mapping). */
  toGameState(rec: SourceRecord): PulseGameState;
}

export interface TheSportsDBOptions {
  /** API key. "3" is the public test key (schedule + scores). Premium unlocks livescore. */
  key?: string;
  baseUrl?: string;
  /** TheSportsDB league id for the NFL. */
  leagueId?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  onRequest?: (info: { url: string; status: number; ms: number }) => void;
}

const NFL_LEAGUE_ID = "4391";

/** Team name -> NFL abbreviation, so pulse rows join CHALK's knowledge layer. */
export const TEAM_NAME_TO_ABBR: Record<string, string> = {
  "Arizona Cardinals": "ARI", "Atlanta Falcons": "ATL", "Baltimore Ravens": "BAL", "Buffalo Bills": "BUF",
  "Carolina Panthers": "CAR", "Chicago Bears": "CHI", "Cincinnati Bengals": "CIN", "Cleveland Browns": "CLE",
  "Dallas Cowboys": "DAL", "Denver Broncos": "DEN", "Detroit Lions": "DET", "Green Bay Packers": "GB",
  "Houston Texans": "HOU", "Indianapolis Colts": "IND", "Jacksonville Jaguars": "JAX", "Kansas City Chiefs": "KC",
  "Las Vegas Raiders": "LV", "Los Angeles Chargers": "LAC", "Los Angeles Rams": "LA", "Miami Dolphins": "MIA",
  "Minnesota Vikings": "MIN", "New England Patriots": "NE", "New Orleans Saints": "NO", "New York Giants": "NYG",
  "New York Jets": "NYJ", "Philadelphia Eagles": "PHI", "Pittsburgh Steelers": "PIT", "San Francisco 49ers": "SF",
  "Seattle Seahawks": "SEA", "Tampa Bay Buccaneers": "TB", "Tennessee Titans": "TEN", "Washington Commanders": "WAS",
};

export class TheSportsDBSource implements PulseSource {
  readonly id = "thesportsdb";
  private readonly key: string;
  private readonly base: string;
  private readonly league: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly onRequest?: TheSportsDBOptions["onRequest"];
  readonly premium: boolean;

  constructor(opts: TheSportsDBOptions = {}) {
    this.key = opts.key ?? process.env.THESPORTSDB_KEY ?? "3";
    this.premium = this.key !== "3";
    this.base = (opts.baseUrl ?? "https://www.thesportsdb.com").replace(/\/+$/, "");
    this.league = opts.leagueId ?? NFL_LEAGUE_ID;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.onRequest = opts.onRequest;
  }

  async upcoming(): Promise<SourceRecord[]> {
    return this.events(`/api/v1/json/${this.key}/eventsnextleague.php?id=${this.league}`, "eventsnextleague");
  }
  async recent(): Promise<SourceRecord[]> {
    return this.events(`/api/v1/json/${this.key}/eventspastleague.php?id=${this.league}`, "eventspastleague");
  }
  async live(): Promise<SourceRecord[]> {
    if (!this.premium) return []; // documented: livescore is a Premium (v2) endpoint
    return this.events(`/api/v2/json/livescore/${this.league}`, "livescore", { "X-API-KEY": this.key });
  }
  async event(id: string): Promise<SourceRecord | null> {
    const recs = await this.events(`/api/v1/json/${this.key}/lookupevent.php?id=${encodeURIComponent(id)}`, "lookupevent");
    return recs[0] ?? null;
  }

  toGameState(rec: SourceRecord): PulseGameState {
    const e = rec.payload as Record<string, unknown>;
    const s = (k: string) => (typeof e[k] === "string" && (e[k] as string).length ? (e[k] as string) : null);
    const n = (k: string) => {
      const v = e[k];
      if (typeof v === "number") return v;
      if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
      return null;
    };
    const home = s("strHomeTeam") ?? "";
    const away = s("strAwayTeam") ?? "";
    return {
      provider_event_id: String(e.idEvent ?? rec.recordId),
      home_team: TEAM_NAME_TO_ABBR[home] ?? home,
      away_team: TEAM_NAME_TO_ABBR[away] ?? away,
      home_score: n("intHomeScore"),
      away_score: n("intAwayScore"),
      status: s("strStatus"),
      kickoff: s("strTimestamp"),
      progress: s("strProgress"),
      season: s("strSeason"),
      round: s("intRound"),
    };
  }

  private async events(pathAndQuery: string, endpoint: string, extraHeaders: Record<string, string> = {}): Promise<SourceRecord[]> {
    const url = this.base + pathAndQuery;
    const started = Date.now();
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(url, { headers: { accept: "application/json", ...extraHeaders }, signal: ctl.signal });
      const text = await res.text();
      this.onRequest?.({ url: redact(url, this.key), status: res.status, ms: Date.now() - started });
      if (!res.ok) throw new SourceError(`thesportsdb ${res.status} for ${endpoint}`, redact(url, this.key), res.status, text.slice(0, 500));
      const body = JSON.parse(text) as { events?: Array<Record<string, unknown>> | null; livescore?: Array<Record<string, unknown>> | null };
      const rows = body.events ?? body.livescore ?? [];
      const retrievedAt = new Date().toISOString();
      return rows.map((payload) => ({
        source: this.id,
        endpoint,
        recordId: String(payload.idEvent ?? payload.idLiveScore ?? hashish(payload)),
        payload,
        retrievedAt,
      }));
    } catch (e) {
      if (e instanceof SourceError) throw e;
      throw new SourceError(`thesportsdb network failure for ${endpoint}: ${(e as Error).message}`, redact(url, this.key), null, "");
    } finally {
      clearTimeout(timer);
    }
  }
}

function redact(url: string, key: string): string {
  return key === "3" ? url : url.split(key).join("<key>");
}
function hashish(o: unknown): string {
  return Buffer.from(JSON.stringify(o)).toString("base64url").slice(0, 24);
}
