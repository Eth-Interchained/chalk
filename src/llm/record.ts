/*
 * SPDX-License-Identifier: BUSL-1.1
 * Copyright (c) 2026 Interchained LLC. All rights reserved.
 * CHALK / Sports-Rater — https://sports-rater.com — Licensor: Interchained LLC
 */
/**
 * The Record — every model answer CHALK has ever given, served back when its
 * inputs have not changed, and browsable per team.
 *
 * Caching by PROVENANCE, not by text: an observation is reusable for a new
 * question when the plan's intent + filters, the calculation hashes it was
 * explained from, the evidence summary and the prompt version are all
 * identical. Same inputs => the interpretation's inputs are byte-identical, so
 * serving the stored answer is correct by construction. Any data change alters
 * the calculation hashes, the key changes, and the next ask streams live.
 *
 * Nothing here ever deletes: a live re-ask stores a NEW observation beside the
 * old one. The record is append-only, like everything else in the store.
 */
import { COLL } from "../store/collections.ts";
import { hashPayload } from "../store/hash.ts";
import { nqlStr, type NedbRow } from "../store/nedb.ts";
import type { Store } from "../store/nedb.ts";
import type { EvidencePackage, ObservationRecord } from "./explain.ts";
import type { QueryPlan } from "./planner.ts";
import { PROMPT_VERSION } from "./prompts.ts";
import { SR, type FanReaction, type ReactionKind } from "../fans/fans.ts";
import { hiddenSet } from "../server/moderation.ts";

export const RECORD_VERSION = "1";

/** Deterministic key of everything the explainer saw. Independent of question wording and plan id. */
export function evidenceKey(plan: Pick<QueryPlan, "intent" | "filters">, pkg: EvidencePackage, promptVersion = PROMPT_VERSION, register: "fan" | "coach" = "fan"): string {
  return hashPayload({
    v: RECORD_VERSION,
    register,
    intent: plan.intent,
    filters: plan.filters,
    kind: pkg.kind,
    calculation_hashes: pkg.calculation_hashes,
    evidence_count: pkg.evidence_ids.length,
    summary: pkg.summary,
    prompt_version: promptVersion,
  });
}

/** Latest stored, complete answer for this key (null if none, or only failed/truncated ones exist). */
export async function findObservation(store: Store, key: string): Promise<NedbRow<ObservationRecord> | null> {
  const [rows, hidden] = await Promise.all([store.query<ObservationRecord>(`FROM ${COLL.observations} WHERE evidence_key = ${nqlStr(key)}`), hiddenSet(store)]);
  // A hidden answer is never served from the record — an admin pulled it for a reason no metric could see.
  const good = rows.filter((r) => r.data.answer && !r.data.error && !r.data.answer_truncated && !hidden.has(`${COLL.observations}:${r._id}`)).sort((a, b) => b._seq - a._seq);
  return good[0] ?? null;
}

export interface RecordItem {
  id: string;
  hash: string;
  seq: number;
  team: string | null;
  season: number | null;
  question: string;
  intent: string;
  statements: string[];
  answer: string | null;
  model: string;
  created_at: string;
  latency_ms: number;
  evidence_count: number;
  evidence_key: string | null;
  register: "fan" | "coach";
  reactions: Record<ReactionKind, number>;
}

/** A team's record, newest first, with fan reaction tallies joined. */
/**
 * Paginated by NEDB seq (stable, monotone): pass `beforeSeq` = the smallest seq
 * of the previous page to get the next older page. `next_before` is null when
 * the history is exhausted.
 */
export async function listRecord(store: Store, opts: { team?: string; season?: number; limit?: number; beforeSeq?: number } = {}): Promise<{ items: RecordItem[]; seq: number; head: string; total: number; next_before: number | null }> {
  // Observations stored before v0.7.0 carry no team/season fields; derive them
  // from the stored query plan so the record is complete from day one.
  const teamOf = (o: ObservationRecord): string | null => o.team ?? (typeof (o.query_plan?.filters as { team?: unknown })?.team === "string" ? String((o.query_plan.filters as { team: string }).team).toUpperCase() : null);
  const seasonOf = (o: ObservationRecord): number | null => o.season ?? (typeof (o.query_plan?.filters as { season?: unknown })?.season === "number" ? (o.query_plan.filters as { season: number }).season : null);
  const [r, hidden] = await Promise.all([store.queryAt<ObservationRecord>(`FROM ${COLL.observations}`), hiddenSet(store)]);
  let rows = r.rows.filter((x) => x.data.answer && !x.data.error && !x.data.answer_truncated && !hidden.has(`${COLL.observations}:${x._id}`));
  if (opts.team) rows = rows.filter((x) => teamOf(x.data) === opts.team);
  if (opts.season !== undefined) rows = rows.filter((x) => seasonOf(x.data) === opts.season);
  const total = rows.length;
  if (opts.beforeSeq !== undefined) rows = rows.filter((x) => x._seq < opts.beforeSeq!);
  rows.sort((a, b) => b._seq - a._seq);
  const limit = opts.limit ?? 30;
  const hasMore = rows.length > limit;
  rows = rows.slice(0, limit);
  const next_before = hasMore && rows.length ? rows[rows.length - 1]._seq : null;
  const counts = new Map<string, Record<ReactionKind, number>>();
  if (rows.length) {
    const rx = await store.query<FanReaction>(`FROM ${SR.reactions} WHERE target_coll = ${nqlStr(COLL.observations)}`);
    for (const x of rx) {
      const c = counts.get(x.data.target_id!) ?? { like: 0, agree: 0, disagree: 0 };
      c[x.data.reaction]++;
      counts.set(x.data.target_id!, c);
    }
  }
  return {
    items: rows.map((x) => ({
      id: x._id, hash: x._hash, seq: x._seq,
      team: teamOf(x.data), season: seasonOf(x.data),
      question: x.data.question, intent: x.data.intent,
      statements: x.data.statements ?? [],
      answer: x.data.answer, model: x.data.model, created_at: x.data.created_at, latency_ms: x.data.latency_ms,
      evidence_count: x.data.evidence_count, evidence_key: x.data.evidence_key ?? null, register: x.data.register ?? "fan",
      reactions: counts.get(x._id) ?? { like: 0, agree: 0, disagree: 0 },
    })),
    seq: r.seq, head: r.head, total, next_before,
  };
}
