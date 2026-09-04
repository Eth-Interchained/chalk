import { test, after } from "node:test";
import assert from "node:assert/strict";
import { WorkerStore } from "../src/store/worker_store.ts";
import { COLL } from "../src/store/collections.ts";

let ws: WorkerStore | null = null;
try { ws = await WorkerStore.memory("worker_test"); } catch (e) { console.log(`[worker_store] skipping: ${(e as Error).message}`); }
const skip: string | false = ws ? false : "napi engine unavailable on this platform";
after(async () => { await ws?.close(); });

test("worker store: full Store surface over the thread boundary — put/get/query/queryAt/batchPut/head/seq/verify/trace/client", { skip }, async () => {
  const s = ws!;
  assert.match(s.url, /^embedded:memory/);
  const a = await s.put(COLL.analyses, "a1", { kind: "t", n: 1 }, { evidence: "x" });
  assert.equal(a._id, "a1"); assert.equal(a._hash.length, 64);
  const b = await s.put(COLL.analyses, "b1", { kind: "t", n: 2 }, { causedBy: [a._hash] });
  assert.deepEqual(b._caused_by, [a._hash]);
  assert.equal((await s.get(COLL.analyses, "a1"))?.data.n, 1);
  assert.equal(await s.get(COLL.analyses, "nope"), null);
  const q = await s.queryAt(`FROM ${COLL.analyses}`);
  assert.equal(q.rows.length, 2); assert.ok(q.seq >= 2); assert.equal(q.head.length, 64);
  const bp = await s.batchPut([{ coll: COLL.analyses, id: "c1", doc: { n: 3 } }, { coll: COLL.analyses, id: "d1", doc: { n: 4 } }]);
  assert.equal(bp.written, 2); assert.ok(bp.hashes instanceof Map); assert.equal(bp.hashes.size, 2);
  assert.equal(await s.seq(), q.seq + 2);
  assert.equal((await s.head()).length, 64);
  const v = await s.verify(); assert.equal(v.ok, true);
  const tr = await s.trace(COLL.analyses, "b1"); assert.ok(tr.some((r) => r._id === "a1"));
  assert.deepEqual(await s.client.listDatabases(), ["worker_test"]);
  assert.deepEqual(await s.client.createIndex(COLL.analyses, "n", "eq"), { ok: true });
  assert.equal((await s.client.queryFull(`FROM ${COLL.analyses} WHERE n = 3`)).count, 1);
  assert.equal((await s.health()).embedded, true);
  assert.equal(await s.ping(), true);
  await assert.rejects(() => s.query("THIS IS NOT NQL"), /query/);
  // Cache TTL forwards; cache hits report back across the boundary.
  s.cacheTtlMs = 60_000; let hits = 0; s.onCacheHit = () => hits++;
  await s.query(`FROM ${COLL.analyses}`); await s.query(`FROM ${COLL.analyses}`);
  assert.equal(hits, 1);
  s.invalidateCache(); await new Promise((r) => setTimeout(r, 20));
  await s.query(`FROM ${COLL.analyses}`); assert.equal(hits, 1);
});

test("worker store: long engine scans do not block the main thread's event loop", { skip }, async () => {
  const s = ws!;
  // 3,000 docs, then 40 un-indexed point queries: each is a full scan on the worker returning ~1 row,
  // so wall time is engine work, not structured-clone cost on this thread.
  const ops = Array.from({ length: 3000 }, (_, i) => ({ coll: "football_plays", id: `p${i}`, doc: { season: 2025, game_id: `g${i % 20}`, posteam: "TB", down: (i % 4) + 1, n: i, pad: "x".repeat(200) } }));
  for (let i = 0; i < ops.length; i += 500) await s.batchPut(ops.slice(i, i + 500));
  let ticks = 0; const t = setInterval(() => ticks++, 5);
  const t0 = Date.now();
  await Promise.all(Array.from({ length: 40 }, (_, i) => s.query(`FROM football_plays WHERE n = ${i * 71}`)));
  clearInterval(t);
  const ms = Date.now() - t0;
  // If the engine blocked this thread, the 5 ms interval could not have fired while the scans ran.
  assert.ok(ms > 20, `scans finished suspiciously fast (${ms}ms) — test would not be meaningful`);
  assert.ok(ticks >= Math.max(1, Math.floor(ms / 50)), `main thread starved: ${ticks} ticks in ${ms}ms`);
});

test("worker store: closed store rejects cleanly", async () => {
  const w = await WorkerStore.memory("worker_close").catch(() => null);
  if (!w) return;
  await w.put(COLL.analyses, "z", { n: 0 });
  await w.close();
  assert.equal(await w.ping(), false);
  await assert.rejects(() => w.get(COLL.analyses, "z"), /closed/);
});
