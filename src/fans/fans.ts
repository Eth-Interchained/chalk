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
  chain_tips: "sr_chain_tips",
} as const;

export const FAN_LAYER_VERSION = "0.1.0";
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

export type FanWrite = FanRating | FanReaction | FanPost;

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

// ------------------------------------------------------------------- reads

export interface FeedItem {
  kind: "post" | "rating" | "reaction";
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
  const filtered = opts.team ? items.filter((i) => !i.team || i.team === opts.team) : items;
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
  for (const coll of [SR.posts, SR.ratings, SR.reactions]) {
    for (const r of await store.query<FanWrite>(`FROM ${coll} WHERE fan_id = ${nqlStr(fan_id)}`)) byHash.set(r._hash, r);
  }
  const links: ChainLink[] = [];
  let cur: string | null = tip.data.tip_hash;
  let verified = true;
  const seen = new Set<string>();
  while (cur && links.length < limit) {
    if (seen.has(cur)) { verified = false; break; }
    seen.add(cur);
    const row = byHash.get(cur);
    if (!row) {
      // The current version of a re-rated doc has a new hash; the old hash is history.
      // Fetch it via TRACE from any row that cites it is expensive; mark and stop.
      links.push({ coll: "?", id: "?", hash: cur, prev: null, chain_index: -1, created_at: "", kind: "unknown", ok: false });
      verified = false;
      break;
    }
    links.push({ coll: row._coll, id: row._id, hash: row._hash, prev: row.data.prev, chain_index: row.data.chain_index, created_at: row.data.created_at, kind: row.data.kind, ok: true });
    cur = row.data.prev;
  }
  return { handle: tip.data.handle, length: tip.data.chain_length, verified, links };
}
