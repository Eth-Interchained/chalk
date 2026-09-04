/*
 * SPDX-License-Identifier: BUSL-1.1
 * Copyright (c) 2026 Interchained LLC. All rights reserved.
 * CHALK / Sports-Rater — https://sports-rater.com — Licensor: Interchained LLC
 */
/**
 * Sports-Rater fan layer — ratings, reactions, takes, feed, consensus.
 *
 * Every fan write is a NEDB document in an `sr_*` collection:
 *   - `caused_by` the CHALK record it reacts to (rating snapshot, analysis,
 *     observation), so TRACE from a fan's take reaches the plays behind it.
 *   - `prev` = the hash of the same fan's previous write, so each fan is a
 *     hash chain the API can walk and verify link by link.
 * Ids are deterministic (fan + target + kind) so re-rating REPLACES the fan's
 * rating as a new version (history kept) rather than stacking duplicates.
 *
 * Consensus is arithmetic: mean of the latest fan rating per fan for a
 * team/subject, count, and the delta vs CHALK's deterministic score.
 * The model never touches this layer.
 */
import { COLL } from "../store/collections.ts";
import { deterministicId } from "../store/hash.ts";
import { nqlStr, type NedbRow } from "../store/nedb.ts";
import type { Store } from "../store/nedb.ts";
import type { FanIdentity } from "./identity.ts";
import { hiddenSet } from "../server/moderation.ts";

export const SR = {
  ratings: "sr_ratings",
  reactions: "sr_reactions",
  posts: "sr_posts",
  favorites: "sr_favorites",
  picks: "sr_picks",
  hype: "sr_hype",
  chain_tips: "sr_chain_tips",
} as const;
/** Every fan collection. The fact side (rating/engine/llm/planner/ingest/model) never reads any of these — tests/fact_wall.test.ts enforces it. */
export const SR_COLLECTIONS: readonly string[] = [SR.ratings, SR.reactions, SR.posts, SR.favorites, SR.picks, SR.hype, SR.chain_tips];
export const HYPE_LABELS = ["", "worried", "uneasy", "steady", "believing", "all in"] as const;

export const FAN_LAYER_VERSION = "0.2.0";
export const REACTION_KINDS = ["like", "agree", "disagree"] as const;
export type ReactionKind = (typeof REACTION_KINDS)[number];
export const POST_MAX = 280;

interface FanWriteBase {
  fan_id: string;
  handle: string;
  /** Hash of this fan's previous write (any sr_ collection), null for their first. */
  prev: string | null;
  /** Position in the fan's chain, 1-based. */
  chain_index: number;
  target_coll: string | null;
  target_id: string | null;
  target_hash: string | null;
  created_at: string;
  layer_version: string;
}

export interface FanRating extends FanWriteBase {
  kind: "rating";
  team: string;
  season: number;
  subject: string;
  score: number;
  /** CHALK's score at the moment the fan rated — the disagreement is frozen with the write. */
  chalk_score: number | null;
  snapshot_id: string | null;
}

export interface FanReaction extends FanWriteBase {
  kind: "reaction";
  reaction: ReactionKind;
}

export interface FanPost extends FanWriteBase {
  kind: "post";
  text: string;
  team: string | null;
  game_id: string | null;
}

export interface FanFavorite extends FanWriteBase {
  kind: "favorite";
  team: string;
}
export interface FanPick extends FanWriteBase {
  kind: "pick";
  game_id: string;
  season: number | null;
  week: number | null;
  home_team: string;
  away_team: string;
  /** The team the fan says wins. Settled later against football_games — never editable after kickoff. */
  pick: string;
}
export interface FanHype extends FanWriteBase {
  kind: "hype";
  team: string;
  season: number;
  week: number;
  /** 1 worried … 5 all in. Sentiment, explicitly not a stat. */
  value: number;
}
export type FanWrite = FanRating | FanReaction | FanPost | FanFavorite | FanPick | FanHype;

interface ChainTip {
  fan_id: string;
  handle: string;
  tip_hash: string;
  tip_coll: string;
  tip_id: string;
  chain_length: number;
  updated_at: string;
}

async function chainTip(store: Store, fan_id: string): Promise<NedbRow<ChainTip> | null> {
  return store.get<ChainTip>(SR.chain_tips, fan_id);
}

/** Resolve the target record (any football_* or sr_* collection) to its current hash. */
async function resolveTarget(store: Store, coll: string | null, id: string | null): Promise<{ hash: string | null; ok: boolean; error?: string }> {
  if (!coll || !id) return { hash: null, ok: true };
  if (!/^(football|sr)_[a-z_]+$/.test(coll)) return { hash: null, ok: false, error: `target_coll must be a football_* or sr_* collection` };
  const row = await store.get(coll, id);
  if (!row) return { hash: null, ok: false, error: `target ${coll}/${id} not found` };
  return { hash: row._hash, ok: true };
}

async function commit<T extends FanWrite>(store: Store, coll: string, id: string, doc: Omit<T, "prev" | "chain_index">, now: string): Promise<NedbRow<T>> {
  const tip = await chainTip(store, doc.fan_id);
  const full = { ...doc, prev: tip?.data.tip_hash ?? null, chain_index: (tip?.data.chain_length ?? 0) + 1 } as unknown as Record<string, unknown>;
  const causedBy = [doc.target_hash, tip?.data.tip_hash].filter((h): h is string => Boolean(h));
  const row = await store.put(coll, id, full, { causedBy, evidence: `sports-rater fan ${doc.kind}` });
  await store.put(SR.chain_tips, doc.fan_id, { fan_id: doc.fan_id, handle: doc.handle, tip_hash: row._hash, tip_coll: coll, tip_id: id, chain_length: full.chain_index as number, updated_at: now } satisfies ChainTip as unknown as Record<string, unknown>, { causedBy: [row._hash], evidence: "chain tip" });
  return row as unknown as NedbRow<T>;
}

// ------------------------------------------------------------------ writes

export interface RateInput { team: string; season: number; subject: string; score: number; snapshot_id?: string | null; chalk_score?: number | null }

export function validateRate(input: unknown): { ok: boolean; value?: RateInput; errors: string[] } {
  const errors: string[] = [];
  if (!input || typeof input !== "object") return { ok: false, errors: ["rating: object required"] };
  const o = input as Record<string, unknown>;
  const team = typeof o.team === "string" && /^[A-Z]{2,3}$/.test(o.team.toUpperCase()) ? o.team.toUpperCase() : null;
  if (!team) errors.push("team: 2-3 letter abbreviation");
  const season = typeof o.season === "number" && Number.isInteger(o.season) ? o.season : null;
  if (season === null) errors.push("season: integer");
  const subject = typeof o.subject === "string" && /^[a-z_]{3,32}$/.test(o.subject) ? o.subject : null;
  if (!subject) errors.push("subject: e.g. offense, third_down");
  const score = typeof o.score === "number" && Number.isInteger(o.score) && o.score >= 0 && o.score <= 100 ? o.score : null;
  if (score === null) errors.push("score: integer 0-100");
  const snapshot_id = typeof o.snapshot_id === "string" ? o.snapshot_id : null;
  const chalk_score = typeof o.chalk_score === "number" ? o.chalk_score : null;
  if (errors.length) return { ok: false, errors };
  return { ok: true, value: { team: team!, season: season!, subject: subject!, score: score!, snapshot_id, chalk_score }, errors: [] };
}

export async function rate(store: Store, who: FanIdentity, r: RateInput, now = new Date().toISOString()): Promise<{ row: NedbRow<FanRating>; replaced: boolean }> {
  const target = r.snapshot_id ? await resolveTarget(store, COLL.ratings, r.snapshot_id) : { hash: null, ok: true };
  if (!target.ok) throw new Error(target.error);
  const id = deterministicId("srr", { fan: who.fan_id, team: r.team, season: r.season, subject: r.subject });
  const existing = await store.get(SR.ratings, id);
  const row = await commit<FanRating>(store, SR.ratings, id, {
    kind: "rating", fan_id: who.fan_id, handle: who.handle, team: r.team, season: r.season, subject: r.subject, score: r.score,
    chalk_score: r.chalk_score ?? null, snapshot_id: r.snapshot_id ?? null,
    target_coll: r.snapshot_id ? COLL.ratings : null, target_id: r.snapshot_id ?? null, target_hash: target.hash, created_at: now, layer_version: FAN_LAYER_VERSION,
  }, now);
  return { row, replaced: Boolean(existing) };
}

export function validateReaction(input: unknown): { ok: boolean; value?: { target_coll: string; target_id: string; reaction: ReactionKind }; errors: string[] } {
  const errors: string[] = [];
  if (!input || typeof input !== "object") return { ok: false, errors: ["reaction: object required"] };
  const o = input as Record<string, unknown>;
  const target_coll = typeof o.target_coll === "string" ? o.target_coll : "";
  const target_id = typeof o.target_id === "string" ? o.target_id : "";
  if (!/^(football|sr)_[a-z_]+$/.test(target_coll)) errors.push("target_coll: football_* or sr_* collection");
  if (!target_id || target_id.length > 200) errors.push("target_id: required");
  const reaction = REACTION_KINDS.includes(o.reaction as ReactionKind) ? (o.reaction as ReactionKind) : null;
  if (!reaction) errors.push(`reaction: one of ${REACTION_KINDS.join("|")}`);
  if (errors.length) return { ok: false, errors };
  return { ok: true, value: { target_coll, target_id, reaction: reaction! }, errors: [] };
}

export async function react(store: Store, who: FanIdentity, v: { target_coll: string; target_id: string; reaction: ReactionKind }, now = new Date().toISOString()): Promise<{ row: NedbRow<FanReaction>; replaced: boolean }> {
  const target = await resolveTarget(store, v.target_coll, v.target_id);
  if (!target.ok) throw new Error(target.error);
  const id = deterministicId("srx", { fan: who.fan_id, coll: v.target_coll, id: v.target_id });
  const existing = await store.get(SR.reactions, id);
  const row = await commit<FanReaction>(store, SR.reactions, id, {
    kind: "reaction", fan_id: who.fan_id, handle: who.handle, reaction: v.reaction,
    target_coll: v.target_coll, target_id: v.target_id, target_hash: target.hash, created_at: now, layer_version: FAN_LAYER_VERSION,
  }, now);
  return { row, replaced: Boolean(existing) };
}

export function validatePost(input: unknown): { ok: boolean; value?: { text: string; team: string | null; game_id: string | null; target_coll: string | null; target_id: string | null }; errors: string[] } {
  const errors: string[] = [];
  if (!input || typeof input !== "object") return { ok: false, errors: ["post: object required"] };
  const o = input as Record<string, unknown>;
  const text = typeof o.text === "string" ? o.text.replace(/\s+/g, " ").trim() : "";
  if (text.length < 1 || text.length > POST_MAX) errors.push(`text: 1-${POST_MAX} chars`);
  if (/https?:\/\//i.test(text)) errors.push("text: links are not allowed in takes");
  const team = typeof o.team === "string" && /^[A-Z]{2,3}$/.test(o.team.toUpperCase()) ? o.team.toUpperCase() : null;
  const game_id = typeof o.game_id === "string" && /^\d{4}_\d{2}_[A-Z]{2,3}_[A-Z]{2,3}$/.test(o.game_id) ? o.game_id : null;
  const target_coll = typeof o.target_coll === "string" ? o.target_coll : null;
  const target_id = typeof o.target_id === "string" ? o.target_id : null;
  if ((target_coll && !target_id) || (!target_coll && target_id)) errors.push("target_coll and target_id go together");
  if (target_coll && !/^(football|sr)_[a-z_]+$/.test(target_coll)) errors.push("target_coll: football_* or sr_* collection");
  if (errors.length) return { ok: false, errors };
  return { ok: true, value: { text, team, game_id, target_coll, target_id }, errors: [] };
}

export async function post(store: Store, who: FanIdentity, v: { text: string; team: string | null; game_id: string | null; target_coll: string | null; target_id: string | null }, now = new Date().toISOString()): Promise<NedbRow<FanPost>> {
  const target = await resolveTarget(store, v.target_coll, v.target_id);
  if (!target.ok) throw new Error(target.error);
  const id = deterministicId("srp", { fan: who.fan_id, text: v.text, at: now });
  return commit<FanPost>(store, SR.posts, id, {
    kind: "post", fan_id: who.fan_id, handle: who.handle, text: v.text, team: v.team, game_id: v.game_id,
    target_coll: v.target_coll, target_id: v.target_id, target_hash: target.hash, created_at: now, layer_version: FAN_LAYER_VERSION,
  }, now);
}

// ---------------------------------------------------------------- favorites

export function validateFavorite(input: unknown): { ok: boolean; value?: { team: string }; errors: string[] } {
  const o = (input ?? {}) as Record<string, unknown>;
  const team = typeof o.team === "string" && /^[A-Z]{2,3}$/.test(o.team.toUpperCase()) ? o.team.toUpperCase() : null;
  return team ? { ok: true, value: { team }, errors: [] } : { ok: false, errors: ["team: 2-3 letter abbreviation"] };
}
/** One favorite per fan; re-declaring replaces (same id, new version — the chain keeps both). */
export async function favorite(store: Store, who: FanIdentity, v: { team: string }, now = new Date().toISOString()): Promise<{ row: NedbRow<FanFavorite>; replaced: boolean }> {
  const id = deterministicId("srf", { fan: who.fan_id });
  const existing = await store.get(SR.favorites, id);
  const row = await commit<FanFavorite>(store, SR.favorites, id, { kind: "favorite", fan_id: who.fan_id, handle: who.handle, team: v.team, target_coll: null, target_id: null, target_hash: null, created_at: now, layer_version: FAN_LAYER_VERSION }, now);
  return { row, replaced: Boolean(existing) };
}
export async function favoriteOf(store: Store, fan_id: string): Promise<string | null> {
  const row = await store.get<FanFavorite>(SR.favorites, deterministicId("srf", { fan: fan_id }));
  return row?.data.team ?? null;
}

// -------------------------------------------------------------------- picks

export interface PickGame { id: string; season: number | null; week: number | null; gameday: string | null; home_team: string | null; away_team: string | null; home_score: number | null; away_score: number | null; winner: string | null }

export function validatePick(input: unknown): { ok: boolean; value?: { game_id: string; pick: string }; errors: string[] } {
  const errors: string[] = [];
  const o = (input ?? {}) as Record<string, unknown>;
  const game_id = typeof o.game_id === "string" && /^\d{4}_\d{2}_[A-Z]{2,3}_[A-Z]{2,3}$/.test(o.game_id) ? o.game_id : null;
  if (!game_id) errors.push("game_id: e.g. 2025_01_TB_ATL");
  const pick = typeof o.pick === "string" && /^[A-Z]{2,3}$/.test(o.pick.toUpperCase()) ? o.pick.toUpperCase() : null;
  if (!pick) errors.push("pick: team abbreviation");
  return errors.length ? { ok: false, errors } : { ok: true, value: { game_id: game_id!, pick: pick! }, errors: [] };
}
/** Pure: why a pick cannot be placed on this game now — null when it can. `today` is a UTC YYYY-MM-DD. */
export function pickLockReason(g: PickGame, pick: string, today = new Date().toISOString().slice(0, 10)): string | null {
  if (!g.home_team || !g.away_team) return `game ${g.id} has no teams on record`;
  if (pick !== g.home_team && pick !== g.away_team) return `pick must be ${g.away_team} or ${g.home_team}`;
  if (g.home_score !== null || g.away_score !== null) return `game ${g.id} already has a score — picks are locked at kickoff`;
  if (g.gameday && g.gameday < today) return `game ${g.id} kicked off ${g.gameday} — picks are locked at kickoff`;
  return null;
}
export async function pick(store: Store, who: FanIdentity, v: { game_id: string; pick: string }, now = new Date().toISOString()): Promise<{ row: NedbRow<FanPick>; replaced: boolean; game: PickGame }> {
  const g = await store.get<PickGame>(COLL.games, v.game_id);
  if (!g) throw new Error(`game ${v.game_id} not found`);
  const lock = pickLockReason(g.data, v.pick, now.slice(0, 10));
  if (lock) throw new Error(lock);
  const id = deterministicId("srk", { fan: who.fan_id, game: v.game_id });
  const existing = await store.get(SR.picks, id);
  const row = await commit<FanPick>(store, SR.picks, id, {
    kind: "pick", fan_id: who.fan_id, handle: who.handle, game_id: v.game_id, season: g.data.season, week: g.data.week, home_team: g.data.home_team!, away_team: g.data.away_team!, pick: v.pick,
    target_coll: COLL.games, target_id: v.game_id, target_hash: g._hash, created_at: now, layer_version: FAN_LAYER_VERSION,
  }, now);
  return { row, replaced: Boolean(existing), game: g.data };
}
export type PickStatus = "won" | "lost" | "push" | "pending";
/** Pure: the facts settle the pick. Scores absent → pending; tie → push. */
export function settlePick(p: Pick<FanPick, "pick">, g: PickGame | null | undefined): PickStatus {
  if (!g || g.home_score === null || g.away_score === null) return "pending";
  if (g.winner === null) return "push";
  return g.winner === p.pick ? "won" : "lost";
}
export interface PickRecord { wins: number; losses: number; pushes: number; pending: number; pct: number | null }
export function tallyPicks(statuses: readonly PickStatus[]): PickRecord {
  const r: PickRecord = { wins: 0, losses: 0, pushes: 0, pending: 0, pct: null };
  for (const st of statuses) { if (st === "won") r.wins++; else if (st === "lost") r.losses++; else if (st === "push") r.pushes++; else r.pending++; }
  const settled = r.wins + r.losses;
  r.pct = settled ? Math.round((r.wins / settled) * 1000) / 10 : null;
  return r;
}
async function gamesById(store: Store, ids: Iterable<string>): Promise<Map<string, PickGame>> {
  const out = new Map<string, PickGame>();
  for (const id of new Set(ids)) { const g = await store.get<PickGame>(COLL.games, id); if (g) out.set(id, g.data); }
  return out;
}
export interface SettledPick { id: string; hash: string; game_id: string; season: number | null; week: number | null; home_team: string; away_team: string; pick: string; status: PickStatus; created_at: string; chain_index: number; final: { home_score: number | null; away_score: number | null } | null }
export async function fanPicks(store: Store, fan_id: string, season?: number): Promise<{ picks: SettledPick[]; record: PickRecord }> {
  let rows = await store.query<FanPick>(`FROM ${SR.picks} WHERE fan_id = ${nqlStr(fan_id)}`);
  if (season !== undefined) rows = rows.filter((r) => r.data.season === season);
  const games = await gamesById(store, rows.map((r) => r.data.game_id));
  const picks = rows.map((r) => { const g = games.get(r.data.game_id); return { id: r._id, hash: r._hash, game_id: r.data.game_id, season: r.data.season, week: r.data.week, home_team: r.data.home_team, away_team: r.data.away_team, pick: r.data.pick, status: settlePick(r.data, g), created_at: r.data.created_at, chain_index: r.data.chain_index, final: g && g.home_score !== null ? { home_score: g.home_score, away_score: g.away_score } : null }; })
    .sort((a, b) => (b.week ?? 0) - (a.week ?? 0) || b.created_at.localeCompare(a.created_at));
  return { picks, record: tallyPicks(picks.map((p) => p.status)) };
}
export interface LeaderboardRow { fan_id: string; handle: string; record: PickRecord; picks: number }
export async function pickLeaderboard(store: Store, season: number, limit = 20): Promise<LeaderboardRow[]> {
  const rows = (await store.query<FanPick>(`FROM ${SR.picks}`)).filter((r) => r.data.season === season);
  const games = await gamesById(store, rows.map((r) => r.data.game_id));
  const byFan = new Map<string, { handle: string; statuses: PickStatus[] }>();
  for (const r of rows) { const e = byFan.get(r.data.fan_id) ?? { handle: r.data.handle, statuses: [] }; e.handle = r.data.handle; e.statuses.push(settlePick(r.data, games.get(r.data.game_id))); byFan.set(r.data.fan_id, e); }
  return [...byFan.entries()].map(([fan_id, e]) => ({ fan_id, handle: e.handle, record: tallyPicks(e.statuses), picks: e.statuses.length }))
    .sort((a, b) => b.record.wins - a.record.wins || (b.record.pct ?? -1) - (a.record.pct ?? -1) || a.record.losses - b.record.losses || a.handle.localeCompare(b.handle))
    .slice(0, limit);
}
/** Crowd split on one game: how many fans took each side. */
export async function picksForGame(store: Store, game_id: string): Promise<{ game_id: string; total: number; by_team: Record<string, number> }> {
  const rows = await store.query<FanPick>(`FROM ${SR.picks} WHERE game_id = ${nqlStr(game_id)}`);
  const by_team: Record<string, number> = {};
  for (const r of rows) by_team[r.data.pick] = (by_team[r.data.pick] ?? 0) + 1;
  return { game_id, total: rows.length, by_team };
}

// --------------------------------------------------------------------- hype

export function validateHype(input: unknown): { ok: boolean; value?: { team: string; season: number; week: number; value: number }; errors: string[] } {
  const errors: string[] = [];
  const o = (input ?? {}) as Record<string, unknown>;
  const team = typeof o.team === "string" && /^[A-Z]{2,3}$/.test(o.team.toUpperCase()) ? o.team.toUpperCase() : null;
  if (!team) errors.push("team: 2-3 letter abbreviation");
  const season = typeof o.season === "number" && Number.isInteger(o.season) ? o.season : null;
  if (season === null) errors.push("season: integer");
  const week = typeof o.week === "number" && Number.isInteger(o.week) && o.week >= 1 && o.week <= 22 ? o.week : null;
  if (week === null) errors.push("week: integer 1-22");
  const value = typeof o.value === "number" && Number.isInteger(o.value) && o.value >= 1 && o.value <= 5 ? o.value : null;
  if (value === null) errors.push(`value: integer 1-5 (${HYPE_LABELS.slice(1).join(" … ")})`);
  return errors.length ? { ok: false, errors } : { ok: true, value: { team: team!, season: season!, week: week!, value: value! }, errors: [] };
}
export async function hype(store: Store, who: FanIdentity, v: { team: string; season: number; week: number; value: number }, now = new Date().toISOString()): Promise<{ row: NedbRow<FanHype>; replaced: boolean }> {
  const id = deterministicId("srh", { fan: who.fan_id, team: v.team, season: v.season, week: v.week });
  const existing = await store.get(SR.hype, id);
  const row = await commit<FanHype>(store, SR.hype, id, { kind: "hype", fan_id: who.fan_id, handle: who.handle, team: v.team, season: v.season, week: v.week, value: v.value, target_coll: null, target_id: null, target_hash: null, created_at: now, layer_version: FAN_LAYER_VERSION }, now);
  return { row, replaced: Boolean(existing) };
}
export interface HypeAggregate { team: string; season: number; week: number; n: number; mean: number | null; label: string | null; dist: number[] }
export function aggregateHype(values: readonly number[], team: string, season: number, week: number): HypeAggregate {
  const dist = [0, 0, 0, 0, 0];
  for (const v of values) if (v >= 1 && v <= 5) dist[v - 1]++;
  const n = values.length;
  const mean = n ? Math.round((values.reduce((a, b) => a + b, 0) / n) * 10) / 10 : null;
  return { team, season, week, n, mean, label: mean === null ? null : HYPE_LABELS[Math.min(5, Math.max(1, Math.round(mean)))], dist };
}
export async function hypeFor(store: Store, team: string, season: number, week: number): Promise<HypeAggregate & { mine?: number | null }> {
  const rows = await store.query<FanHype>(`FROM ${SR.hype} WHERE team = ${nqlStr(team)}`);
  return aggregateHype(rows.filter((r) => r.data.season === season && r.data.week === week).map((r) => r.data.value), team, season, week);
}

/** Reaction counts for a set of targets — used by the server routes to decorate record/feed items. */
export async function reactionCounts(store: Store, target_coll: string, ids: readonly string[]): Promise<Map<string, Record<ReactionKind, number>>> {
  const counts = new Map<string, Record<ReactionKind, number>>();
  if (!ids.length) return counts;
  const want = new Set(ids);
  const rx = await store.query<FanReaction>(`FROM ${SR.reactions} WHERE target_coll = ${nqlStr(target_coll)}`);
  for (const x of rx) { if (!want.has(x.data.target_id!)) continue; const c = counts.get(x.data.target_id!) ?? { like: 0, agree: 0, disagree: 0 }; c[x.data.reaction]++; counts.set(x.data.target_id!, c); }
  return counts;
}

// ------------------------------------------------------------------- reads

export interface FeedItem {
  kind: "post" | "rating" | "reaction" | "pick";
  id: string;
  hash: string;
  seq: number;
  fan_id: string;
  handle: string;
  created_at: string;
  chain_index: number;
  prev: string | null;
  team?: string | null;
  game_id?: string | null;
  text?: string;
  subject?: string;
  score?: number;
  chalk_score?: number | null;
  reaction?: ReactionKind;
  target_coll?: string | null;
  target_id?: string | null;
  reactions?: Record<ReactionKind, number>;
  pick?: string;
  home_team?: string;
  away_team?: string;
  week?: number | null;
}

export async function feed(store: Store, opts: { team?: string; limit?: number; include?: Array<FeedItem["kind"]> } = {}): Promise<{ items: FeedItem[]; seq: number; head: string }> {
  const include = new Set(opts.include ?? ["post", "rating"]);
  const items: FeedItem[] = [];
  let seq = 0, head = "";
  const hidden = await hiddenSet(store);
  if (include.has("post")) {
    const r = await store.queryAt<FanPost>(`FROM ${SR.posts}`);
    seq = Math.max(seq, r.seq); head = r.head || head;
    for (const x of r.rows.filter((p) => !hidden.has(`${SR.posts}:${p._id}`))) items.push({ kind: "post", id: x._id, hash: x._hash, seq: x._seq, fan_id: x.data.fan_id, handle: x.data.handle, created_at: x.data.created_at, chain_index: x.data.chain_index, prev: x.data.prev, team: x.data.team, game_id: x.data.game_id, text: x.data.text, target_coll: x.data.target_coll, target_id: x.data.target_id });
  }
  if (include.has("rating")) {
    const r = await store.queryAt<FanRating>(`FROM ${SR.ratings}`);
    seq = Math.max(seq, r.seq); head = r.head || head;
    for (const x of r.rows.filter((p) => !hidden.has(`${SR.ratings}:${p._id}`))) items.push({ kind: "rating", id: x._id, hash: x._hash, seq: x._seq, fan_id: x.data.fan_id, handle: x.data.handle, created_at: x.data.created_at, chain_index: x.data.chain_index, prev: x.data.prev, team: x.data.team, subject: x.data.subject, score: x.data.score, chalk_score: x.data.chalk_score, target_coll: x.data.target_coll, target_id: x.data.target_id });
  }
  if (include.has("reaction")) {
    const r = await store.queryAt<FanReaction>(`FROM ${SR.reactions}`);
    seq = Math.max(seq, r.seq); head = r.head || head;
    for (const x of r.rows) items.push({ kind: "reaction", id: x._id, hash: x._hash, seq: x._seq, fan_id: x.data.fan_id, handle: x.data.handle, created_at: x.data.created_at, chain_index: x.data.chain_index, prev: x.data.prev, reaction: x.data.reaction, target_coll: x.data.target_coll, target_id: x.data.target_id });
  }
  if (include.has("pick")) {
    const r = await store.queryAt<FanPick>(`FROM ${SR.picks}`);
    seq = Math.max(seq, r.seq); head = r.head || head;
    for (const x of r.rows) items.push({ kind: "pick", id: x._id, hash: x._hash, seq: x._seq, fan_id: x.data.fan_id, handle: x.data.handle, created_at: x.data.created_at, chain_index: x.data.chain_index, prev: x.data.prev, team: x.data.pick, game_id: x.data.game_id, pick: x.data.pick, home_team: x.data.home_team, away_team: x.data.away_team, week: x.data.week });
  }
  // Reaction counts on posts.
  const posts = items.filter((i) => i.kind === "post");
  if (posts.length) {
    const rx = await store.query<FanReaction>(`FROM ${SR.reactions} WHERE target_coll = ${nqlStr(SR.posts)}`);
    const counts = new Map<string, Record<ReactionKind, number>>();
    for (const x of rx) {
      const c = counts.get(x.data.target_id!) ?? { like: 0, agree: 0, disagree: 0 };
      c[x.data.reaction]++;
      counts.set(x.data.target_id!, c);
    }
    for (const p of posts) p.reactions = counts.get(p.id) ?? { like: 0, agree: 0, disagree: 0 };
  }
  const filtered = opts.team ? items.filter((i) => !i.team || i.team === opts.team || (i.kind === "pick" && (i.home_team === opts.team || i.away_team === opts.team))) : items;
  filtered.sort((a, b) => b.seq - a.seq);
  return { items: filtered.slice(0, opts.limit ?? 50), seq, head };
}

export interface Consensus {
  team: string;
  season: number;
  subject: string;
  fans: number;
  mean: number | null;
  median: number | null;
  chalk_score: number | null;
  /** fans - chalk */
  delta: number | null;
  distribution: Array<{ bucket: string; n: number }>;
}

export async function consensus(store: Store, team: string, season: number, subject: string, chalkScore: number | null): Promise<Consensus> {
  const rows = await store.query<FanRating>(`FROM ${SR.ratings} WHERE team = ${nqlStr(team)} AND season = ${season} AND subject = ${nqlStr(subject)}`);
  const scores = rows.map((r) => r.data.score);
  const mean = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
  const sorted = [...scores].sort((a, b) => a - b);
  const median = sorted.length ? (sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2) : null;
  const buckets = ["0-19", "20-39", "40-59", "60-79", "80-100"].map((b) => ({ bucket: b, n: 0 }));
  for (const s of scores) buckets[Math.min(4, Math.floor(s / 20))].n++;
  return { team, season, subject, fans: scores.length, mean: mean === null ? null : Math.round(mean * 10) / 10, median, chalk_score: chalkScore, delta: mean === null || chalkScore === null ? null : Math.round((mean - chalkScore) * 10) / 10, distribution: buckets };
}

export interface ChainLink { coll: string; id: string; hash: string; prev: string | null; chain_index: number; created_at: string; kind: string; ok: boolean }

/** Walk a fan's chain from the tip back to their first write, verifying each prev link. */
export async function fanChain(store: Store, fan_id: string, limit = 200): Promise<{ handle: string | null; length: number; verified: boolean; links: ChainLink[] }> {
  const tip = await chainTip(store, fan_id);
  if (!tip) return { handle: null, length: 0, verified: true, links: [] };
  // All of the fan's writes in one pass per collection, then follow prev.
  const byHash = new Map<string, NedbRow<FanWrite>>();
  for (const coll of [SR.posts, SR.ratings, SR.reactions, SR.favorites, SR.picks, SR.hype]) {
    for (const r of await store.query<FanWrite>(`FROM ${coll} WHERE fan_id = ${nqlStr(fan_id)}`)) byHash.set(r._hash, r);
  }
  // Replaced writes (re-pick, changed favorite, re-rate) keep their id and get a new hash; the
  // superseded version is still in the DAG. When a prev cites a hash the current index lacks, pull
  // each current doc's TRACE once (prior versions of the same id are part of the answer) and index
  // those too. Lazy: fans who never replaced anything pay nothing extra. (v0.12.1)
  let historyLoaded = false;
  const loadHistory = async () => {
    if (historyLoaded) return; historyLoaded = true;
    for (const row of [...byHash.values()]) {
      try {
        for (const v of await store.trace(row._coll, row._id)) { const d = v.data as Partial<FanWrite>; if (d.fan_id === fan_id && !byHash.has(v._hash)) byHash.set(v._hash, v as unknown as NedbRow<FanWrite>); }
      } catch (e) { /* named below: a missing history leaves the link unresolved and verified=false */ void e; }
    }
  };
  const links: ChainLink[] = [];
  let cur: string | null = tip.data.tip_hash;
  let verified = true;
  const seen = new Set<string>();
  while (cur && links.length < limit) {
    if (seen.has(cur)) { verified = false; break; }
    seen.add(cur);
    let row = byHash.get(cur);
    if (!row) { await loadHistory(); row = byHash.get(cur); }
    if (!row) {
      links.push({ coll: "?", id: "?", hash: cur, prev: null, chain_index: -1, created_at: "", kind: "unknown", ok: false });
      verified = false;
      break;
    }
    links.push({ coll: row._coll, id: row._id, hash: row._hash, prev: row.data.prev, chain_index: row.data.chain_index, created_at: row.data.created_at, kind: row.data.kind, ok: true });
    cur = row.data.prev;
  }
  return { handle: tip.data.handle, length: tip.data.chain_length, verified, links };
}
