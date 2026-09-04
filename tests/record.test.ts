/*
 * SPDX-License-Identifier: BUSL-1.1
 * Copyright (c) 2026 Interchained LLC. All rights reserved.
 * CHALK / Sports-Rater — https://sports-rater.com — Licensor: Interchained LLC
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import type { Store } from "../src/store/nedb.ts";
import { makeTestStore, STORE_KIND } from "./stores.ts";
import { evidenceKey, findObservation, listRecord } from "../src/llm/record.ts";
import type { EvidencePackage, ObservationRecord } from "../src/llm/explain.ts";
import { COLL } from "../src/store/collections.ts";
import { deriveFanId, handleFor } from "../src/fans/identity.ts";
import { react, reactionCounts } from "../src/fans/fans.ts";

const ts = await makeTestStore("record_test");
const skip: string | false = ts.skip;
const store: Store = ts.store;
if (skip) console.log(`[record_test] skipping integration tests on ${STORE_KIND} store: ${skip}`);
after(() => ts?.stop());

const pkg = (summary: unknown, hashes = ["h1"]): EvidencePackage => ({ kind: "rating", summary, calculation_ids: ["c1"], calculation_hashes: hashes, evidence_ids: ["g:1", "g:2"], deterministic_statements: ["TB Offense Rating: 48/100"] });
const plan = { intent: "rating" as const, filters: { team: "TB", season: 2025, subject: "offense" } };

test("evidenceKey: same inputs -> same key; question wording and plan id irrelevant; any input change -> different key", () => {
  const k = evidenceKey(plan, pkg({ score: 48 }));
  assert.equal(k, evidenceKey({ ...plan }, pkg({ score: 48 })));
  assert.equal(k.length, 64);
  assert.notEqual(k, evidenceKey(plan, pkg({ score: 49 })));                 // summary changed
  assert.notEqual(k, evidenceKey(plan, pkg({ score: 48 }, ["h2"])));         // data changed -> calc hash changed
  assert.notEqual(k, evidenceKey({ ...plan, filters: { ...plan.filters, subject: "defense" } }, pkg({ score: 48 })));
  assert.notEqual(k, evidenceKey(plan, pkg({ score: 48 }), "9.9.9"));        // prompt version bump invalidates
});

test("record: findObservation returns the latest complete answer for a key; listRecord is per team, newest first, with reaction tallies", { skip }, async () => {
  const key = evidenceKey(plan, pkg({ score: 48 }));
  const mk = (id: string, extra: Partial<ObservationRecord>): ObservationRecord => ({
    id, question: "How is the TB offense rated?", intent: "rating", team: "TB", season: 2025, evidence_key: key, statements: ["TB Offense Rating: 48/100"],
    query_plan: { id: "p", intent: "rating", filters: plan.filters, source: "rules" }, model: "GLM-4-32B", model_revision: null, prompt_version: "0.4.0",
    evidence_ids: [], evidence_count: 1065, calculation_ids: ["c1"], answer: "Middle of the pack.", answer_truncated: false, raw_output: "", finish_reason: "stop", latency_ms: 1200, error: null, created_at: "2026-09-04T00:00:00Z", ...extra,
  });
  assert.equal(await findObservation(store, key), null);
  await store.put(COLL.observations, "obs_a", mk("obs_a", {}) as unknown as Record<string, unknown>);
  await store.put(COLL.observations, "obs_bad", mk("obs_bad", { answer: null, error: "stream error" }) as unknown as Record<string, unknown>);
  await store.put(COLL.observations, "obs_trunc", mk("obs_trunc", { answer_truncated: true }) as unknown as Record<string, unknown>);
  await store.put(COLL.observations, "obs_b", mk("obs_b", { answer: "Still middle of the pack, sharper now.", created_at: "2026-09-04T01:00:00Z" }) as unknown as Record<string, unknown>);
  await store.put(COLL.observations, "obs_cin", mk("obs_cin", { team: "CIN", evidence_key: "other", question: "CIN?" }) as unknown as Record<string, unknown>);
  // Legacy row (pre-v0.7.0): no team/season fields, derived from the stored plan.
  await store.put(COLL.observations, "obs_legacy", { ...mk("obs_legacy", { evidence_key: undefined, statements: undefined, created_at: "2026-09-03T00:00:00Z" }), team: undefined, season: undefined } as unknown as Record<string, unknown>);
  const found = await findObservation(store, key);
  assert.equal(found?._id, "obs_b"); // latest complete; failed + truncated skipped
  assert.equal(await findObservation(store, "nope"), null);

  const sarah = { fan_id: deriveFanId("sarah", "r1"), handle: handleFor("sarah", deriveFanId("sarah", "r1")), nickname: "sarah" };
  await react(store, sarah, { target_coll: COLL.observations, target_id: "obs_b", reaction: "agree" });
  const tb = await listRecord(store, { team: "TB", season: 2025 });
  assert.deepEqual(tb.items.map((i) => i.id), ["obs_legacy", "obs_b", "obs_a"]); // newest first by seq; failed/truncated skipped; legacy row included via plan filters
  assert.equal(tb.items[0].team, "TB"); assert.equal(tb.items[0].season, 2025); assert.deepEqual(tb.items[0].statements, []);
  const b = tb.items.find((i) => i.id === "obs_b")!;
  // Fact wall (v0.11.0): the record never reads fan data; the route decorates with reactionCounts.
  assert.equal(b.reactions, undefined);
  assert.deepEqual((await reactionCounts(store, COLL.observations, [b.id])).get(b.id), { like: 0, agree: 1, disagree: 0 });
  assert.equal(b.statements[0], "TB Offense Rating: 48/100");
  assert.equal((await listRecord(store, { team: "CIN" })).items.length, 1);
  assert.equal((await listRecord(store, { team: "TB", season: 1999 })).items.length, 0);
  assert.ok((await listRecord(store, {})).items.length >= 3);
  // Pagination by seq cursor: page of 2, then the rest, then exhausted.
  const p1 = await listRecord(store, { team: "TB", season: 2025, limit: 2 });
  assert.equal(p1.items.length, 2); assert.equal(p1.total, 3); assert.equal(p1.next_before, p1.items[1].seq);
  const p2 = await listRecord(store, { team: "TB", season: 2025, limit: 2, beforeSeq: p1.next_before! });
  assert.equal(p2.items.length, 1); assert.equal(p2.next_before, null);
  assert.deepEqual([...p1.items, ...p2.items].map((i) => i.id), ["obs_legacy", "obs_b", "obs_a"]);
  assert.ok(p1.items[0].seq > p1.items[1].seq && p1.items[1].seq > p2.items[0].seq);
});
