/**
 * Moderation — the human in the loop.
 *
 * Some wrong answers carry no programmatic signal: plan ok, model answered,
 * no error, no truncation — and the text is about the wrong unit of the wrong
 * team. An admin can see that in one glance. This module gives them two moves:
 *
 *   HIDE   — a moderation row (`football_moderation`, id `mod:<coll>:<id>`),
 *            caused_by the target's current hash, carrying a reason. Hidden
 *            items drop out of the Feed, the Record strip, the fan feed, AND
 *            serve-from-record (a hidden answer must never be handed to the
 *            next fan just because its inputs match). Reversible: UNHIDE writes
 *            a new version with hidden:false. Nothing is ever deleted — the
 *            chain stays intact, the store keeps the evidence of what was said
 *            and why it was pulled.
 *   REGENERATE — re-plan, re-execute, re-explain the stored question live,
 *            store the new observation beside the old, hide the old with
 *            reason "regenerated → <new id>". Lives in app.ts (needs the LLM
 *            and planner context); this module holds the bookkeeping.
 */
import { COLL } from "../store/collections.ts";
import { nqlStr, type NedbRow } from "../store/nedb.ts";
import type { Store } from "../store/nedb.ts";

export const MODERATION = "football_moderation";
// Literal sr_* names on purpose: fans.ts imports hiddenSet from here, so importing SR
// back would form an ESM cycle and leave SR undefined at module evaluation.
export const MODERATABLE = new Set<string>([COLL.observations, "sr_posts", "sr_ratings"]);

export interface ModerationDoc {
  coll: string;
  id: string;
  hidden: boolean;
  reason: string;
  /** Hash of the target at the moment of the decision (also the caused_by edge). */
  target_hash: string | null;
  by: string;
  created_at: string;
}

export const modId = (coll: string, id: string): string => `mod:${coll}:${id}`;

export function validateModeration(input: unknown): { ok: boolean; value?: { coll: string; id: string; reason: string }; errors: string[] } {
  if (!input || typeof input !== "object") return { ok: false, errors: ["object required"] };
  const o = input as Record<string, unknown>;
  const errors: string[] = [];
  const coll = typeof o.coll === "string" ? o.coll : "";
  if (!MODERATABLE.has(coll)) errors.push(`coll: one of ${[...MODERATABLE].join("|")}`);
  const id = typeof o.id === "string" && o.id.length > 0 && o.id.length <= 200 ? o.id : "";
  if (!id) errors.push("id: required");
  const reason = typeof o.reason === "string" ? o.reason.trim().slice(0, 500) : "";
  if (errors.length) return { ok: false, errors };
  return { ok: true, value: { coll, id, reason }, errors: [] };
}

export async function setHidden(store: Store, coll: string, id: string, hidden: boolean, reason: string, by = "admin", now = new Date().toISOString()): Promise<NedbRow<ModerationDoc>> {
  const target = await store.get(coll, id);
  if (!target) throw new Error(`${coll}/${id} not found`);
  const doc: ModerationDoc = { coll, id, hidden, reason: reason || (hidden ? "hidden by admin" : "restored by admin"), target_hash: target._hash, by, created_at: now };
  const row = await store.put(MODERATION, modId(coll, id), doc as unknown as Record<string, unknown>, { causedBy: [target._hash], evidence: hidden ? `moderation: hide — ${doc.reason}` : "moderation: unhide" });
  return row as unknown as NedbRow<ModerationDoc>;
}

/** Current hidden set as "coll:id" keys — latest version of each moderation row wins. */
export async function hiddenSet(store: Store): Promise<Set<string>> {
  const rows = await store.query<ModerationDoc>(`FROM ${MODERATION}`).catch(() => [] as NedbRow<ModerationDoc>[]);
  const out = new Set<string>();
  for (const r of rows) if (r.data.hidden) out.add(`${r.data.coll}:${r.data.id}`);
  return out;
}

export async function isHidden(store: Store, coll: string, id: string): Promise<boolean> {
  const row = await store.get<ModerationDoc>(MODERATION, modId(coll, id));
  return Boolean(row?.data.hidden);
}

export async function listModeration(store: Store, limit = 100): Promise<Array<ModerationDoc & { hash: string; seq: number }>> {
  const rows = await store.query<ModerationDoc>(`FROM ${MODERATION}`).catch(() => [] as NedbRow<ModerationDoc>[]);
  return rows.map((r) => ({ ...r.data, hash: r._hash, seq: r._seq })).sort((a, b) => b.seq - a.seq).slice(0, limit);
}

/** NQL-safe helper for callers that query one collection and want to drop hidden ids. */
export function notHidden<T extends { _id: string }>(rows: T[], coll: string, hidden: Set<string>): T[] {
  return rows.filter((r) => !hidden.has(`${coll}:${r._id}`));
}

export const modWhere = (coll: string) => `WHERE coll = ${nqlStr(coll)}`;
