/*
 * SPDX-License-Identifier: BUSL-1.1
 * Copyright (c) 2026 Interchained LLC. All rights reserved.
 * CHALK / Sports-Rater — https://sports-rater.com — Licensor: Interchained LLC
 */
// v0.12.7 — a write must be visible to the next read of its own collection even with the NQL read cache on.
// Mark: picks "not persisted on the client … 5 minutes later it just works" — the cache TTL.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import type { Store } from "../src/store/nedb.ts";
import { makeTestStore, STORE_KIND } from "./stores.ts";

const ts = await makeTestStore("raw_test");
const skip: string | false = ts.skip;
const store: Store = ts.store;
if (skip) console.log(`[raw_test] skipping on ${STORE_KIND} store: ${skip}`);
after(() => ts?.stop());

test("read-after-write with the query cache on: the written collection is refreshed, an unrelated cached scan is kept", { skip }, async () => {
  store.cacheTtlMs = 60_000;
  try {
    await store.put("raw_other", "o1", { v: 1 }, { evidence: "test" });
    const other1 = await store.query("FROM raw_other");
    assert.equal(other1.length, 1);
    const before = await store.query("FROM raw_picks");
    assert.equal(before.length, 0);
    await store.put("raw_picks", "p1", { pick: "TB" }, { evidence: "test" });
    const after1 = await store.query("FROM raw_picks");
    assert.equal(after1.length, 1, "the pick is visible immediately, not after the TTL");
    const filtered = await store.query(`FROM raw_picks WHERE pick = "TB"`);
    assert.equal(filtered.length, 1);
    await store.put("raw_picks", "p2", { pick: "MIA" }, { evidence: "test" });
    assert.equal((await store.query(`FROM raw_picks WHERE pick = "TB"`)).length, 1);
    assert.equal((await store.query("FROM raw_picks")).length, 2, "every cached shape over the collection was dropped, not just the exact query");
    let hits = 0; store.onCacheHit = () => { hits++; };
    await store.query("FROM raw_other");
    assert.equal(hits, 1, "an unrelated collection's cached scan survives the writes");
    store.onCacheHit = null;
    assert.equal(store.invalidateCollection("raw_nothing_cached"), 0);
  } finally { store.cacheTtlMs = 0; store.invalidateCache(); }
});
