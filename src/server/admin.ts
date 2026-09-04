/**
 * Admin — what the store can tell us about how Sports-Rater is used.
 *
 * Everything here is an aggregation over rows CHALK already writes for its own
 * provenance: football_query_events (every ask), football_observations (every
 * answer), sr_* (every fan write), ingest/pulse events, home snapshots — plus
 * one deliberately anonymous telemetry row per page view (sr_telemetry: team,
 * season, mode, view, viewport bucket, fan handle if one exists; NO IP, NO
 * user agent). The public promise is "no accounts, no personal data" and this
 * module keeps it: nothing here identifies a person beyond the nickname they
 * chose.
 *
 * Gated by CHALK_ADMIN_TOKEN (bearer). Unset => the routes do not exist.
 */
import { COLL } from "../store/collections.ts";
import { nqlStr, type NedbRow } from "../store/nedb.ts";
import type { Store } from "../store/nedb.ts";
import { SR, type FanRating, type FanReaction, type FanPost, type ReactionKind } from "../fans/fans.ts";
import type { ObservationRecord } from "../llm/explain.ts";
import { PULSE_EVENTS } from "../ingest/pulse.ts";
import { auditSeason, type SeasonAudit } from "../ingest/audit.ts";
import { CARD_SUBJECTS } from "../rating/definitions.ts";

export const TELEMETRY = "sr_telemetry";
export const TELEMETRY_VERSION = "1";

export interface QueryEventDoc {
  question: string;
  context?: { team?: string; season?: number; game_id?: string; play_id?: string };
  created_at: string;
  plan_ok?: boolean;
  plan_errors?: string[];
  plan_fallback?: boolean;
  intent?: string;
  evidence_count?: number;
  exec_ms?: number;
  observation_id?: string;
  model?: string;
  answer_truncated?: boolean;
  llm_ms?: number;
  llm_error?: string;
  llm_skipped?: string;
  latency_ms?: number;
  error?: string;
  evidence_key?: string;
  from_record?: boolean;
}

export interface TelemetryDoc {
  v: string;
  event: "view" | "ask" | "react" | "rate" | "post" | "tab";
  team: string | null;
  season: number | null;
  mode: "fan" | "coach" | null;
  view: "home" | "feed" | null;
  /** Viewport width bucket: "xs" <480, "sm" <768, "md" <1100, "lg" */
  viewport: "xs" | "sm" | "md" | "lg" | null;
  /** Fan handle when the visitor created one (their own nickname + hash prefix); never an IP. */
  handle: string | null;
  /** Coarse day bucket (UTC) — enough for a heatmap, too coarse to track a person. */
  day: string;
  hour: number;
  created_at: string;
}

const VIEWPORTS = ["xs", "sm", "md", "lg"] as const;
const EVENTS = ["view", "ask", "react", "rate", "post", "tab"] as const;

export function validateTelemetry(input: unknown): { ok: boolean; value?: Omit<TelemetryDoc, "v" | "day" | "hour" | "created_at">; errors: string[] } {
  if (!input || typeof input !== "object") return { ok: false, errors: ["telemetry: object required"] };
  const o = input as Record<string, unknown>;
  const errors: string[] = [];
  const event = EVENTS.includes(o.event as TelemetryDoc["event"]) ? (o.event as TelemetryDoc["event"]) : null;
  if (!event) errors.push(`event: one of ${EVENTS.join("|")}`);
  const team = typeof o.team === "string" && /^[A-Za-z]{2,3}$/.test(o.team) ? o.team.toUpperCase() : null;
  const season = typeof o.season === "number" && Number.isInteger(o.season) && o.season > 1990 && o.season < 2100 ? o.season : null;
  const mode = o.mode === "coach" || o.mode === "fan" ? o.mode : null;
  const view = o.view === "home" || o.view === "feed" ? o.view : null;
  const viewport = VIEWPORTS.includes(o.viewport as (typeof VIEWPORTS)[number]) ? (o.viewport as TelemetryDoc["viewport"]) : null;
  const handle = typeof o.handle === "string" && /^[A-Za-z0-9_][A-Za-z0-9_ .\-]{0,23}#[0-9a-f]{6}$/.test(o.handle) ? o.handle : null;
  if (errors.length) return { ok: false, errors };
  return { ok: true, value: { event: event!, team, season, mode, view, viewport, handle }, errors: [] };
}

export function telemetryDoc(v: NonNullable<ReturnType<typeof validateTelemetry>["value"]>, now = new Date()): TelemetryDoc {
  const iso = now.toISOString();
  return { v: TELEMETRY_VERSION, ...v, day: iso.slice(0, 10), hour: now.getUTCHours(), created_at: iso };
}

// --------------------------------------------------------------- aggregation

export interface HeatCell { dow: number; hour: number; n: number }

function heat(times: string[]): HeatCell[] {
  const grid = new Map<string, number>();
  for (const t of times) {
    const d = new Date(t);
    if (Number.isNaN(d.getTime())) continue;
    const k = `${d.getUTCDay()}:${d.getUTCHours()}`;
    grid.set(k, (grid.get(k) ?? 0) + 1);
  }
  return [...grid].map(([k, n]) => { const [dow, hour] = k.split(":").map(Number); return { dow, hour, n }; }).sort((a, b) => a.dow - b.dow || a.hour - b.hour);
}

function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))];
}

function byDay(times: string[]): Array<{ day: string; n: number }> {
  const m = new Map<string, number>();
  for (const t of times) { const d = t.slice(0, 10); m.set(d, (m.get(d) ?? 0) + 1); }
  return [...m].map(([day, n]) => ({ day, n })).sort((a, b) => a.day.localeCompare(b.day));
}

function counts<T>(items: T[], key: (x: T) => string | null | undefined): Array<{ key: string; n: number }> {
  const m = new Map<string, number>();
  for (const it of items) { const k = key(it); if (k === null || k === undefined || k === "") continue; m.set(k, (m.get(k) ?? 0) + 1); }
  return [...m].map(([key, n]) => ({ key, n })).sort((a, b) => b.n - a.n);
}

export interface AdminOverview {
  generated_at: string;
  window_days: number;
  asks: { total: number; in_window: number; per_day: Array<{ day: string; n: number }>; heat: HeatCell[]; from_record: number; from_record_rate: number | null; plan_fallback: number; plan_failed: number; errors: number; llm_skipped: number; intents: Array<{ key: string; n: number }>; teams: Array<{ key: string; n: number }>; team_intent: Array<{ team: string; intent: string; n: number }>; latency_ms: { p50: number | null; p95: number | null; llm_p50: number | null; llm_p95: number | null; exec_p50: number | null } };
  questions: { top: Array<{ key: string; n: number }>; unanswered: Array<{ question: string; created_at: string; reason: string }>; fallbacks: Array<{ question: string; created_at: string; intent: string | null; errors: string[] }> };
  answers: { total: number; complete: number; truncated: number; errored: number; models: Array<{ key: string; n: number }>; reactions: Record<ReactionKind, number>; most_reacted: Array<{ id: string; question: string; agree: number; disagree: number; like: number }> };
  fans: { total: number; active_7d: number; ratings: number; posts: number; reactions: number; top_handles: Array<{ handle: string; chain_length: number; updated_at: string }>; consensus: Array<{ subject: string; fans: number; mean: number | null }>; rating_distribution: Array<{ bucket: string; n: number }> };
  preferences: { views: number; teams: Array<{ key: string; n: number }>; seasons: Array<{ key: string; n: number }>; modes: Array<{ key: string; n: number }>; tabs: Array<{ key: string; n: number }>; viewports: Array<{ key: string; n: number }>; events: Array<{ key: string; n: number }>; heat: HeatCell[]; per_day: Array<{ day: string; n: number }>; returning_handles: number };
  health: { seq: number; head: string; ingest_runs: Array<{ finished_at: string; scope: unknown; games: number; plays: number; errors: number }>; pulse_ticks: number; home_snapshots: Array<{ id: string; data_stamp: string; built_ms: number; created_at: string }>; audit: SeasonAudit | null };
}

export async function adminOverview(store: Store, opts: { season?: number; windowDays?: number } = {}): Promise<AdminOverview> {
  const windowDays = opts.windowDays ?? 30;
  const since = Date.now() - windowDays * 86_400_000;
  const [qevRows, obsRows, ratings, posts, reactions, tips, tele, ingestRows, pulseRows, snaps] = await Promise.all([
    store.query<QueryEventDoc>(`FROM ${COLL.query_events}`),
    store.query<ObservationRecord>(`FROM ${COLL.observations}`),
    store.query<FanRating>(`FROM ${SR.ratings}`),
    store.query<FanPost>(`FROM ${SR.posts}`),
    store.query<FanReaction>(`FROM ${SR.reactions}`),
    store.query<{ handle: string; chain_length: number; updated_at: string }>(`FROM ${SR.chain_tips}`),
    store.query<TelemetryDoc>(`FROM ${TELEMETRY}`).catch(() => [] as NedbRow<TelemetryDoc>[]),
    store.query<Record<string, unknown>>(`FROM ${COLL.ingest_events}`),
    store.query<Record<string, unknown>>(`FROM ${PULSE_EVENTS}`).catch(() => [] as NedbRow<Record<string, unknown>>[]),
    store.query<{ data_stamp: string; built_ms: number; created_at: string }>(`FROM ${COLL.home_snapshots}`).catch(() => [] as NedbRow<{ data_stamp: string; built_ms: number; created_at: string }>[]),
  ]);
  const qev = qevRows.map((r) => r.data);
  const inWin = qev.filter((q) => new Date(q.created_at).getTime() >= since);
  const fromRecord = inWin.filter((q) => q.from_record).length;
  const planFailed = inWin.filter((q) => q.plan_ok === false);
  const fallbacks = inWin.filter((q) => q.plan_fallback && q.plan_ok !== false);
  const errored = inWin.filter((q) => q.error || q.llm_error);
  const teamOf = (q: QueryEventDoc) => (q.context?.team ?? "").toUpperCase() || null;
  const ti = new Map<string, number>();
  for (const q of inWin) { const t = teamOf(q); if (!t || !q.intent) continue; const k = `${t}|${q.intent}`; ti.set(k, (ti.get(k) ?? 0) + 1); }
  const normQ = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ").replace(/[?!.]+$/, "");

  const obs = obsRows.map((r) => ({ ...r.data, _id: r._id }));
  const rx = reactions.map((r) => r.data);
  const rxOnObs = rx.filter((r) => r.target_coll === COLL.observations);
  const rxCount: Record<ReactionKind, number> = { like: 0, agree: 0, disagree: 0 };
  const perObs = new Map<string, Record<ReactionKind, number>>();
  for (const r of rxOnObs) { rxCount[r.reaction]++; const c = perObs.get(r.target_id!) ?? { like: 0, agree: 0, disagree: 0 }; c[r.reaction]++; perObs.set(r.target_id!, c); }
  const mostReacted = [...perObs].map(([id, c]) => ({ id, question: obs.find((o) => o._id === id)?.question ?? "?", ...c })).sort((a, b) => (b.agree + b.disagree + b.like) - (a.agree + a.disagree + a.like)).slice(0, 10);

  const fanIds = new Set<string>([...ratings.map((r) => r.data.fan_id), ...posts.map((p) => p.data.fan_id), ...rx.map((r) => r.fan_id)]);
  const active7 = new Set<string>();
  const since7 = Date.now() - 7 * 86_400_000;
  for (const r of ratings) if (new Date(r.data.created_at).getTime() >= since7) active7.add(r.data.fan_id);
  for (const p of posts) if (new Date(p.data.created_at).getTime() >= since7) active7.add(p.data.fan_id);
  for (const r of rx) if (new Date(r.created_at).getTime() >= since7) active7.add(r.fan_id);
  const latestPerFanSubject = new Map<string, FanRating>();
  for (const r of ratings) latestPerFanSubject.set(`${r.data.fan_id}|${r.data.team}|${r.data.season}|${r.data.subject}`, r.data);
  const cons = CARD_SUBJECTS.map((c) => {
    const s = [...latestPerFanSubject.values()].filter((r) => r.subject === c.subject && (opts.season === undefined || r.season === opts.season)).map((r) => r.score);
    return { subject: c.subject, fans: s.length, mean: s.length ? Math.round((s.reduce((a, b) => a + b, 0) / s.length) * 10) / 10 : null };
  });
  const dist = ["0-19", "20-39", "40-59", "60-79", "80-100"].map((b) => ({ bucket: b, n: 0 }));
  for (const r of latestPerFanSubject.values()) dist[Math.min(4, Math.floor(r.score / 20))].n++;

  const tel = tele.map((r) => r.data).filter((t) => new Date(t.created_at).getTime() >= since);
  const views = tel.filter((t) => t.event === "view");

  const audit = opts.season !== undefined ? await auditSeason(store, opts.season).catch(() => null) : null;
  const [seq, head] = await Promise.all([store.seq(), store.head()]);

  return {
    generated_at: new Date().toISOString(),
    window_days: windowDays,
    asks: {
      total: qev.length,
      in_window: inWin.length,
      per_day: byDay(inWin.map((q) => q.created_at)),
      heat: heat(inWin.map((q) => q.created_at)),
      from_record: fromRecord,
      from_record_rate: inWin.length ? Math.round((fromRecord / inWin.length) * 1000) / 10 : null,
      plan_fallback: fallbacks.length,
      plan_failed: planFailed.length,
      errors: errored.length,
      llm_skipped: inWin.filter((q) => q.llm_skipped).length,
      intents: counts(inWin, (q) => q.intent),
      teams: counts(inWin, teamOf),
      team_intent: [...ti].map(([k, n]) => { const [team, intent] = k.split("|"); return { team, intent, n }; }).sort((a, b) => b.n - a.n),
      latency_ms: {
        p50: percentile(inWin.map((q) => q.latency_ms).filter((x): x is number => typeof x === "number"), 0.5),
        p95: percentile(inWin.map((q) => q.latency_ms).filter((x): x is number => typeof x === "number"), 0.95),
        llm_p50: percentile(inWin.map((q) => q.llm_ms).filter((x): x is number => typeof x === "number"), 0.5),
        llm_p95: percentile(inWin.map((q) => q.llm_ms).filter((x): x is number => typeof x === "number"), 0.95),
        exec_p50: percentile(inWin.map((q) => q.exec_ms).filter((x): x is number => typeof x === "number"), 0.5),
      },
    },
    questions: {
      top: counts(inWin, (q) => normQ(q.question)).slice(0, 25),
      unanswered: [...planFailed.map((q) => ({ question: q.question, created_at: q.created_at, reason: (q.plan_errors ?? []).join("; ") || "planner could not interpret" })), ...inWin.filter((q) => q.intent === "unsupported").map((q) => ({ question: q.question, created_at: q.created_at, reason: "unsupported by CHALK" })), ...errored.filter((q) => q.plan_ok !== false).map((q) => ({ question: q.question, created_at: q.created_at, reason: q.error ?? q.llm_error ?? "error" }))].sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 50),
      fallbacks: fallbacks.map((q) => ({ question: q.question, created_at: q.created_at, intent: q.intent ?? null, errors: q.plan_errors ?? [] })).sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 50),
    },
    answers: {
      total: obs.length,
      complete: obs.filter((o) => o.answer && !o.error && !o.answer_truncated).length,
      truncated: obs.filter((o) => o.answer_truncated).length,
      errored: obs.filter((o) => o.error).length,
      models: counts(obs, (o) => o.model),
      reactions: rxCount,
      most_reacted: mostReacted,
    },
    fans: {
      total: fanIds.size,
      active_7d: active7.size,
      ratings: ratings.length,
      posts: posts.length,
      reactions: rx.length,
      top_handles: tips.map((t) => t.data).sort((a, b) => b.chain_length - a.chain_length).slice(0, 20),
      consensus: cons,
      rating_distribution: dist,
    },
    preferences: {
      views: views.length,
      teams: counts(views, (t) => t.team),
      seasons: counts(views, (t) => (t.season === null ? null : String(t.season))),
      modes: counts(views, (t) => t.mode),
      tabs: counts(tel.filter((t) => t.event === "tab" || t.event === "view"), (t) => t.view),
      viewports: counts(views, (t) => t.viewport),
      events: counts(tel, (t) => t.event),
      heat: heat(views.map((t) => t.created_at)),
      per_day: byDay(views.map((t) => t.created_at)),
      returning_handles: new Set(views.map((t) => t.handle).filter(Boolean)).size,
    },
    health: {
      seq, head,
      ingest_runs: ingestRows.map((r) => r.data).sort((a, b) => String(b.finished_at).localeCompare(String(a.finished_at))).slice(0, 10).map((r) => ({ finished_at: String(r.finished_at), scope: r.scope, games: Number(r.games_fetched ?? 0), plays: Number(r.plays_fetched ?? 0), errors: Array.isArray(r.errors) ? r.errors.length : 0 })),
      pulse_ticks: pulseRows.length,
      home_snapshots: snaps.map((s) => ({ id: s._id, data_stamp: s.data.data_stamp, built_ms: s.data.built_ms, created_at: s.data.created_at })).sort((a, b) => b.created_at.localeCompare(a.created_at)),
      audit,
    },
  };
}

/** Constant-time-ish bearer check. */
export function adminAuthorized(header: string | undefined, token: string | undefined): boolean {
  if (!token || token.length < 16) return false;
  const m = /^Bearer\s+(.+)$/i.exec(header ?? "");
  if (!m) return false;
  const given = m[1].trim();
  if (given.length !== token.length) return false;
  let diff = 0;
  for (let i = 0; i < token.length; i++) diff |= given.charCodeAt(i) ^ token.charCodeAt(i);
  return diff === 0;
}
