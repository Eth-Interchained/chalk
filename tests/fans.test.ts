/*
 * SPDX-License-Identifier: BUSL-1.1
 * Copyright (c) 2026 Interchained LLC. All rights reserved.
 * CHALK / Sports-Rater — https://sports-rater.com — Licensor: Interchained LLC
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import type { Store } from "../src/store/nedb.ts";
import { makeTestStore, STORE_KIND } from "./stores.ts";
import { deriveFanId, handleFor, verifyIdentity, identiconSvg, RateLimiter } from "../src/fans/identity.ts";
import { rate, react, post, feed, consensus, fanChain, validateRate, validateReaction, validatePost, SR, validateFavorite, favorite, favoriteOf, validatePick, pickLockReason, pick, settlePick, tallyPicks, fanPicks, pickLeaderboard, picksForGame, validateHype, hype, hypeFor, aggregateHype, reactionCounts } from "../src/fans/fans.ts";
import { COLL } from "../src/store/collections.ts";

// Resolved at module load so node:test sees the real skip reason at registration time.
const ts = await makeTestStore("sr_test");
const skip: string | false = ts.skip;
const store: Store = ts.store;
if (skip) console.log(`[sr_test] skipping integration tests on ${STORE_KIND} store: ${skip}`);

after(() => ts?.stop());

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

  // Chain walk verifies link by link. Dad's rating was re-put, so the chain's first link (rating v1)
  // is a superseded version: since v0.12.1 the walker resolves it through TRACE history and verifies.
  const chain = await fanChain(store, dad.fan_id);
  assert.equal(chain.handle, dad.handle);
  assert.equal(chain.length, 3);
  assert.equal(chain.links[0].kind, "rating"); // tip = rating v2
  assert.equal(chain.links[1].kind, "post");
  assert.equal(chain.links[2].kind, "rating"); // rating v1, resolved from history
  assert.equal(chain.links[2].ok, true);
  assert.equal(chain.verified, true);
  const sChain = await fanChain(store, sarah.fan_id);
  assert.equal(sChain.verified, true);
  assert.equal(sChain.links.length, 2);
  const nobody = await fanChain(store, deriveFanId("ghost", "x"));
  assert.equal(nobody.length, 0);

  await assert.rejects(() => react(store, dad, { target_coll: COLL.analyses, target_id: "nope", reaction: "like" }), /not found/);
});

test("fan knobs that are not facts: pick lock rule, settlement, tally, hype aggregate (pure)", () => {
  const g = { id: "2025_03_TB_ATL", season: 2025, week: 3, gameday: "2025-09-21", home_team: "ATL", away_team: "TB", home_score: null, away_score: null, winner: null };
  assert.equal(pickLockReason(g, "TB", "2025-09-20"), null);
  assert.equal(pickLockReason(g, "TB", "2025-09-21"), null, "same-day picks allowed (kickoff time unknown to the schedule row)");
  assert.match(pickLockReason(g, "TB", "2025-09-22")!, /locked at kickoff/);
  assert.match(pickLockReason(g, "KC", "2025-09-20")!, /pick must be TB or ATL/);
  assert.match(pickLockReason({ ...g, home_score: 20, away_score: 17, winner: "ATL" }, "TB", "2025-09-20")!, /already has a score/);
  assert.equal(settlePick({ pick: "TB" }, g), "pending");
  assert.equal(settlePick({ pick: "TB" }, { ...g, home_score: 20, away_score: 17, winner: "ATL" }), "lost");
  assert.equal(settlePick({ pick: "ATL" }, { ...g, home_score: 20, away_score: 17, winner: "ATL" }), "won");
  assert.equal(settlePick({ pick: "TB" }, { ...g, home_score: 20, away_score: 20, winner: null }), "push");
  assert.equal(settlePick({ pick: "TB" }, null), "pending");
  assert.deepEqual(tallyPicks(["won", "won", "lost", "push", "pending"]), { wins: 2, losses: 1, pushes: 1, pending: 1, pct: 66.7 });
  assert.equal(tallyPicks(["pending"]).pct, null);
  const h = aggregateHype([5, 4, 4, 2], "TB", 2025, 3);
  assert.deepEqual(h.dist, [0, 1, 0, 2, 1]); assert.equal(h.mean, 3.8); assert.equal(h.label, "believing"); assert.equal(h.n, 4);
  assert.equal(aggregateHype([], "TB", 2025, 3).label, null);
  assert.equal(validateFavorite({ team: "tb" }).value!.team, "TB"); assert.equal(validateFavorite({ team: "tampa" }).ok, false);
  assert.equal(validatePick({ game_id: "2025_03_TB_ATL", pick: "tb" }).value!.pick, "TB"); assert.equal(validatePick({ game_id: "bad", pick: "TB" }).ok, false);
  assert.equal(validateHype({ team: "TB", season: 2025, week: 3, value: 5 }).ok, true); assert.equal(validateHype({ team: "TB", season: 2025, week: 3, value: 6 }).ok, false);
});

test("fan knobs on the chain: favorite replaces, pick settles against the game row, leaderboard + crowd split, hype aggregate, chain verifies", { skip }, async () => {
  const fid = deriveFanId("picker", "salt-p"); const who = { fan_id: fid, handle: handleFor("picker", fid), nickname: "picker" };
  const fid2 = deriveFanId("rival", "salt-r"); const who2 = { fan_id: fid2, handle: handleFor("rival", fid2), nickname: "rival" };
  await store.put(COLL.games, "2025_09_TB_DET", { id: "2025_09_TB_DET", season: 2025, week: 9, gameday: "2099-01-01", home_team: "DET", away_team: "TB", home_score: null, away_score: null, winner: null, margin: null }, { evidence: "test schedule" });
  await store.put(COLL.games, "2025_08_TB_NO", { id: "2025_08_TB_NO", season: 2025, week: 8, gameday: "2025-10-26", home_team: "TB", away_team: "NO", home_score: 31, away_score: 21, winner: "TB", margin: 10 }, { evidence: "test final" });
  const f1 = await favorite(store, who, { team: "TB" }); assert.equal(f1.replaced, false);
  const f2 = await favorite(store, who, { team: "DET" }); assert.equal(f2.replaced, true);
  assert.equal(await favoriteOf(store, fid), "DET"); assert.equal(await favoriteOf(store, fid2), null);
  const pk = await pick(store, who, { game_id: "2025_09_TB_DET", pick: "TB" }); assert.equal(pk.row.data.target_hash !== null, true, "pick cites the schedule row");
  await assert.rejects(() => pick(store, who, { game_id: "2025_08_TB_NO", pick: "TB" }), /already has a score/);
  await assert.rejects(() => pick(store, who, { game_id: "2025_09_TB_DET", pick: "KC" }), /pick must be/);
  await assert.rejects(() => pick(store, who, { game_id: "2025_99_XX_YY", pick: "XX" }), /not found/);
  const re = await pick(store, who, { game_id: "2025_09_TB_DET", pick: "DET" }); assert.equal(re.replaced, true, "re-pick before kickoff replaces");
  await pick(store, who2, { game_id: "2025_09_TB_DET", pick: "TB" });
  const crowd = await picksForGame(store, "2025_09_TB_DET"); assert.equal(crowd.total, 2); assert.deepEqual(crowd.by_team, { DET: 1, TB: 1 });
  const mine = await fanPicks(store, fid, 2025); assert.equal(mine.picks.length, 1); assert.equal(mine.picks[0].status, "pending"); assert.equal(mine.record.pending, 1);
  // the facts settle it
  await store.put(COLL.games, "2025_09_TB_DET", { id: "2025_09_TB_DET", season: 2025, week: 9, gameday: "2099-01-01", home_team: "DET", away_team: "TB", home_score: 27, away_score: 24, winner: "DET", margin: 3 }, { evidence: "test final" });
  const settled = await fanPicks(store, fid, 2025); assert.equal(settled.picks[0].status, "won"); assert.deepEqual(settled.record, { wins: 1, losses: 0, pushes: 0, pending: 0, pct: 100 });
  const lb = await pickLeaderboard(store, 2025); assert.equal(lb[0].fan_id, fid); assert.equal(lb[1].record.losses, 1);
  await hype(store, who, { team: "TB", season: 2025, week: 9, value: 5 }); await hype(store, who2, { team: "TB", season: 2025, week: 9, value: 2 });
  const hr = await hype(store, who, { team: "TB", season: 2025, week: 9, value: 4 }); assert.equal(hr.replaced, true);
  const agg = await hypeFor(store, "TB", 2025, 9); assert.equal(agg.n, 2); assert.equal(agg.mean, 3); assert.equal(agg.label, "steady");
  // v0.12.1: replaced writes resolve through TRACE history — the chain verifies end to end.
  const chain = await fanChain(store, fid); assert.equal(chain.length, 6, "favorite x2, pick x2, hype x2");
  assert.equal(chain.verified, true, `chain must verify across replaced writes: ${JSON.stringify(chain.links.map((l) => [l.kind, l.ok, l.chain_index]))}`);
  assert.deepEqual(chain.links.map((l) => l.chain_index), [6, 5, 4, 3, 2, 1]);
  assert.ok(chain.links.every((l) => l.ok));
  const fd = await feed(store, { team: "TB", include: ["pick"] }); assert.ok(fd.items.every((i) => i.kind === "pick") && fd.items.length >= 2, "picks on either side of a TB game show on the TB page");
  const rc = await reactionCounts(store, "sr_posts", ["nope"]); assert.equal(rc.size, 0);
});
