import { test, after } from "node:test";
import assert from "node:assert/strict";
import type { Store } from "../src/store/nedb.ts";
import { makeTestStore, STORE_KIND } from "./stores.ts";
import { homeServeDecision, homeSnapshotId, loadHomeSnapshot, persistHomeSnapshot, HOME_SNAPSHOT_VERSION, type HomePayload, type HomeSnapshotDoc } from "../src/server/home.ts";
import { COLL } from "../src/store/collections.ts";

const ts = await makeTestStore("home_snap_test");
const skip: string | false = ts.skip;
const store: Store = ts.store;
if (skip) console.log(`[home_snap_test] skipping integration tests on ${STORE_KIND} store: ${skip}`);
after(() => ts?.stop());

const payload = { team: "TB", season: 2025, rating: null, rating_snapshot_id: null, trend: null, badges: [], form: null, last_game: null, next_game: null, weakest: [], strongest: [], ratings: [], scout: null, context_coverage: null, computed_at: { seq: 7, head: "h" } } as unknown as HomePayload;
const doc = (stamp: string): HomeSnapshotDoc => ({ team: "TB", season: 2025, definition_id: "d", data_stamp: stamp, snapshot_version: HOME_SNAPSHOT_VERSION, built_ms: 1, created_at: "t", payload });

test("homeServeDecision: no snapshot computes; equal stamp is fresh; different or unknown stamp is stale", () => {
  assert.equal(homeServeDecision(null, "5"), "compute");
  assert.equal(homeServeDecision(doc("5"), "5"), "fresh_snapshot");
  assert.equal(homeServeDecision(doc("4"), "5"), "stale_snapshot");
  assert.equal(homeServeDecision(doc("5"), null), "stale_snapshot"); // stamp unknown before first tick: serve, but refresh
  assert.equal(homeSnapshotId("TB", 2025, "third_down_default@1.0.0"), "home:TB:2025:third_down_default@1.0.0");
});

test("persist + load roundtrip; re-persist replaces (new version, same id); version mismatch reads as absent", { skip }, async () => {
  assert.equal(await loadHomeSnapshot(store, "TB", 2025, "d"), null);
  const r1 = await persistHomeSnapshot(store, payload, "d", "10", 1234, "2026-09-04T00:00:00Z");
  assert.equal(r1._id, homeSnapshotId("TB", 2025, "d"));
  const got = await loadHomeSnapshot(store, "TB", 2025, "d");
  assert.ok(got);
  assert.equal(got!.data.data_stamp, "10");
  assert.equal(got!.data.built_ms, 1234);
  assert.equal(got!.data.payload.computed_at.seq, 7);
  assert.equal(homeServeDecision(got!.data, "10"), "fresh_snapshot");
  const r2 = await persistHomeSnapshot(store, payload, "d", "11", 99, "2026-09-04T00:01:00Z");
  assert.equal(r2._id, r1._id);
  assert.notEqual(r2._hash, r1._hash);
  assert.equal((await loadHomeSnapshot(store, "TB", 2025, "d"))!.data.data_stamp, "11");
  await store.put(COLL.home_snapshots, homeSnapshotId("TB", 2025, "old"), { ...doc("1"), snapshot_version: "0" } as unknown as Record<string, unknown>);
  assert.equal(await loadHomeSnapshot(store, "TB", 2025, "old"), null);
});
