import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { ChalkStore, resolveNedbdBinary } from "../src/store/nedb.ts";
import { deriveFanId, handleFor, verifyIdentity, identiconSvg, RateLimiter } from "../src/fans/identity.ts";
import { rate, react, post, feed, consensus, fanChain, validateRate, validateReaction, validatePost, SR } from "../src/fans/fans.ts";
import { COLL } from "../src/store/collections.ts";

const bin = resolveNedbdBinary();
const port = 18000 + Math.floor(Math.random() * 1000);
let child: ChildProcess | null = null;
let store: ChalkStore;
const skip = bin ? false : `nedbd-v2 binary not available for ${process.platform}/${process.arch}`;

before(async () => {
  if (!bin) return;
  child = spawn(bin, ["--memory", "--host", "127.0.0.1", "--port", String(port)], { stdio: ["ignore", "pipe", "pipe"] });
  store = new ChalkStore({ url: `http://127.0.0.1:${port}`, db: "sr_test" });
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { if (await store.ping()) return; await new Promise((r) => setTimeout(r, 150)); }
  throw new Error("nedbd did not start");
});
after(() => child?.kill("SIGTERM"));

test("identity: derivation, handle, verification, identicon determinism", () => {
  const id = deriveFanId("dad", "s3cret-salt");
  assert.equal(id.length, 64);
  assert.equal(deriveFanId("dad", "s3cret-salt"), id);
  assert.notEqual(deriveFanId("dad", "other"), id);
  const handle = handleFor("dad", id);
  assert.equal(handle, `dad#${id.slice(0, 6)}`);
  const ok = verifyIdentity({ fan_id: id, handle });
  assert.ok(ok.ok, ok.errors.join(";"));
  assert.equal(ok.identity!.nickname, "dad");
  assert.equal(verifyIdentity({ fan_id: id, handle: "dad#000000" }).ok, false);
  assert.equal(verifyIdentity({ fan_id: "zz", handle }).ok, false);
  assert.equal(verifyIdentity({ fan_id: id, handle: "<script>#" + id.slice(0, 6) }).ok, false);
  assert.equal(verifyIdentity({ fan_id: id, handle: "a really long nickname that goes on#" + id.slice(0, 6) }).ok, false);
  const svg = identiconSvg(id);
  assert.equal(svg, identiconSvg(id));
  assert.ok(svg.startsWith("<svg"));
  assert.notEqual(svg, identiconSvg(deriveFanId("sarah", "x")));
});

test("rate limiter: capacity then refill", () => {
  const rl = new RateLimiter(3, 1 / 1000); // 3 burst, 1 per second
  const t = 1_000_000;
  assert.ok(rl.take("a", t).ok); assert.ok(rl.take("a", t).ok); assert.ok(rl.take("a", t).ok);
  const denied = rl.take("a", t);
  assert.equal(denied.ok, false);
  assert.ok(denied.retry_after_ms > 0 && denied.retry_after_ms <= 1000);
  assert.ok(rl.take("a", t + 1000).ok);
  assert.ok(rl.take("b", t).ok);
  rl.sweep(t + 10_000_000);
});

test("validators reject garbage precisely", () => {
  assert.equal(validateRate({ team: "TB", season: 2025, subject: "offense", score: 101 }).ok, false);
  assert.equal(validateRate({ team: "TB", season: 2025, subject: "offense", score: 58 }).ok, true);
  assert.equal(validateReaction({ target_coll: "users", target_id: "x", reaction: "like" }).ok, false);
  assert.equal(validateReaction({ target_coll: "football_observations", target_id: "obs_1", reaction: "hate" }).ok, false);
  assert.equal(validatePost({ text: "check http://spam.example" }).ok, false);
  assert.equal(validatePost({ text: "x".repeat(281) }).ok, false);
  assert.equal(validatePost({ text: "   Bucs   need a tackle  " }).value!.text, "Bucs need a tackle");
  assert.equal(validatePost({ text: "hi", target_coll: "football_analyses" }).ok, false);
});

test("fan writes: chained per fan, caused_by the CHALK record, re-rating replaces, feed newest-first, consensus", { skip }, async () => {
  // A CHALK record to react to.
  const snap = await store.put(COLL.ratings, "rating_test1", { subject_key: "TB", score: 48, definition_id: "offense_default@1.0.0" });
  const dad = { fan_id: deriveFanId("dad", "s1"), handle: handleFor("dad", deriveFanId("dad", "s1")), nickname: "dad" };
  const sarah = { fan_id: deriveFanId("sarah", "s2"), handle: handleFor("sarah", deriveFanId("sarah", "s2")), nickname: "sarah" };

  const r1 = await rate(store, dad, { team: "TB", season: 2025, subject: "offense", score: 70, snapshot_id: "rating_test1", chalk_score: 48 }, "2026-09-04T00:00:00Z");
  assert.equal(r1.replaced, false);
  assert.equal(r1.row.data.prev, null);
  assert.equal(r1.row.data.chain_index, 1);
  assert.equal(r1.row.data.target_hash, snap._hash);

  const p1 = await post(store, dad, { text: "This offense is better than 48. Watch the second half.", team: "TB", game_id: null, target_coll: COLL.ratings, target_id: "rating_test1" }, "2026-09-04T00:01:00Z");
  assert.equal(p1.data.prev, r1.row._hash);
  assert.equal(p1.data.chain_index, 2);

  const x1 = await react(store, sarah, { target_coll: SR.posts, target_id: p1._id, reaction: "disagree" }, "2026-09-04T00:02:00Z");
  assert.equal(x1.row.data.prev, null);
  assert.equal(x1.row.data.target_hash, p1._hash);
  await rate(store, sarah, { team: "TB", season: 2025, subject: "offense", score: 40, snapshot_id: "rating_test1", chalk_score: 48 }, "2026-09-04T00:03:00Z");

  // Re-rating replaces (same id, new version), chain grows.
  const r2 = await rate(store, dad, { team: "TB", season: 2025, subject: "offense", score: 66, snapshot_id: "rating_test1", chalk_score: 48 }, "2026-09-04T00:04:00Z");
  assert.equal(r2.replaced, true);
  assert.equal(r2.row._id, r1.row._id);
  assert.equal(r2.row.data.chain_index, 3);
  assert.equal(r2.row.data.prev, p1._hash);

  const c = await consensus(store, "TB", 2025, "offense", 48);
  assert.equal(c.fans, 2);
  assert.equal(c.mean, 53); // (66 + 40) / 2 — latest rating per fan only
  assert.equal(c.delta, 5);
  assert.equal(c.distribution.find((b) => b.bucket === "60-79")!.n, 1);

  const f = await feed(store, { team: "TB" });
  assert.ok(f.items.length >= 3);
  for (let i = 1; i < f.items.length; i++) assert.ok(f.items[i - 1].seq >= f.items[i].seq, "newest first");
  const postItem = f.items.find((i) => i.kind === "post")!;
  assert.deepEqual(postItem.reactions, { like: 0, agree: 0, disagree: 1 });

  // TRACE from dad's take reaches the CHALK rating record.
  const trace = await store.trace(SR.posts, p1._id);
  assert.ok(trace.some((t) => t._coll === COLL.ratings && t._id === "rating_test1"));
  assert.ok(trace.some((t) => t._coll === SR.ratings)); // prev link

  // Chain walk verifies link by link. Dad's rating was re-put, so the chain's
  // middle link (rating v1) is history: the walk reports exactly that.
  const chain = await fanChain(store, dad.fan_id);
  assert.equal(chain.handle, dad.handle);
  assert.equal(chain.length, 3);
  assert.equal(chain.links[0].kind, "rating"); // tip = rating v2
  assert.equal(chain.links[1].kind, "post");
  assert.equal(chain.links[2].ok, false); // rating v1's hash is a prior version -> not current
  const sChain = await fanChain(store, sarah.fan_id);
  assert.equal(sChain.verified, true);
  assert.equal(sChain.links.length, 2);
  const nobody = await fanChain(store, deriveFanId("ghost", "x"));
  assert.equal(nobody.length, 0);

  await assert.rejects(() => react(store, dad, { target_coll: COLL.analyses, target_id: "nope", reaction: "like" }), /not found/);
});
