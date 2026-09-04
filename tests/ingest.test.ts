/**
 * Ingest integration tests against a REAL nedbd (the bundled nedbd-v2 binary,
 * in-memory mode, on an ephemeral port). Skipped with a logged reason when the
 * binary is missing for this platform — never silently.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import type { Store } from "../src/store/nedb.ts";
import { makeTestStore, STORE_KIND } from "./stores.ts";
import { ingest, rawId, diffKeys } from "../src/ingest/ingest.ts";
import { COLL } from "../src/store/collections.ts";
import { hashPayload, canonicalJson } from "../src/store/hash.ts";
import { runThirdDown } from "../src/engine/thirddown.ts";
import { rateThirdDown, invalidateLeagueCache } from "../src/rating/league.ts";
import { THIRD_DOWN_DEFAULT_V1 } from "../src/rating/definitions.ts";
import { pulseTick } from "../src/ingest/pulse.ts";
import { TheSportsDBSource } from "../src/source/pulse.ts";
import type { FootballSource, GameQuery, PlayQuery, SourceMeta, SourceRecord } from "../src/source/types.ts";
import { rawGame, rawPlays, FIXTURE_GAME_ID } from "./fixture.ts";

// Resolved at module load so node:test sees the real skip reason at registration time.
const ts = await makeTestStore("chalk_test");
const skip: string | false = ts.skip;
const store: Store = ts.store;
if (skip) console.log(`[chalk_test] skipping integration tests on ${STORE_KIND} store: ${skip}`);

/** In-memory FootballSource serving the frozen fixture, with a mutable overlay for change tests. */
class FixtureSource implements FootballSource {
  readonly id = "fixture";
  plays_payload = rawPlays();
  game_payload = rawGame();
  async meta(): Promise<SourceMeta> { return { source: this.id, seasons: [2025], teams: [{ abbr: "TB", name: "Tampa Bay Buccaneers" }, { abbr: "CAR", name: "Carolina Panthers" }] }; }
  async *games(_q: GameQuery): AsyncGenerator<SourceRecord[]> { yield [{ source: this.id, endpoint: "/v1/games", recordId: FIXTURE_GAME_ID, payload: this.game_payload, retrievedAt: "2026-09-03T00:00:00Z" }]; }
  async game(id: string): Promise<SourceRecord | null> { return id === FIXTURE_GAME_ID ? { source: this.id, endpoint: "/v1/games/{game_id}", recordId: id, payload: this.game_payload, retrievedAt: "2026-09-03T00:00:00Z" } : null; }
  async *plays(_q: PlayQuery): AsyncGenerator<SourceRecord[]> { yield this.plays_payload.map((p) => ({ source: this.id, endpoint: "/v1/plays", recordId: `${p.game_id}:${p.play_id}`, payload: p, retrievedAt: "2026-09-03T00:00:00Z" })); }
  async *participation(): AsyncGenerator<SourceRecord[]> { yield []; }
  async *charting(): AsyncGenerator<SourceRecord[]> { yield []; }
}

after(() => ts?.stop());


test("canonical hashing: key order irrelevant, -0 normalized, undefined dropped", () => {
  assert.equal(hashPayload({ a: 1, b: [1, { c: 2, d: 3 }] }), hashPayload({ b: [1, { d: 3, c: 2 }], a: 1 }));
  assert.equal(canonicalJson({ z: -0, y: undefined, x: 1 }), '{"x":1,"z":0}');
  assert.notEqual(hashPayload({ a: 1 }), hashPayload({ a: 2 }));
  assert.equal(hashPayload({ a: 1 }).length, 64);
  assert.throws(() => hashPayload({ a: NaN }));
  assert.deepEqual(diffKeys({ a: 1, b: 2 }, { a: 1, b: 3, c: 4 }), ["b", "c"]);
  assert.equal(rawId({ source: "nfldata", endpoint: "/v1/plays", recordId: "g:1" }), "nfldata:/v1/plays:g:1");
});

test("ingest: first run writes, second run is a no-op, changed upstream record is versioned + logged", { skip }, async () => {
  const src = new FixtureSource();
  const log: string[] = [];
  const r1 = await ingest({ store, source: src, scope: { gameId: FIXTURE_GAME_ID }, log: (l) => log.push(l), now: () => "2026-09-03T00:00:00Z" });
  assert.equal(r1.games_fetched, 1);
  assert.equal(r1.plays_fetched, 159);
  assert.equal(r1.raw_written, 160); // 159 plays + 1 game
  assert.equal(r1.normalized_written, 160);
  assert.equal(r1.raw_duplicates, 0);
  assert.equal(r1.errors.length, 0, JSON.stringify(r1.errors));
  assert.ok(r1.nedb_seq > 300);
  assert.ok(r1.event_hash.length === 64);

  const r2 = await ingest({ store, source: src, scope: { gameId: FIXTURE_GAME_ID }, now: () => "2026-09-03T00:01:00Z" });
  assert.equal(r2.raw_written, 0);
  assert.equal(r2.raw_duplicates, 160);
  assert.equal(r2.normalized_written, 0);
  assert.equal(r2.normalized_skipped, 160);
  assert.equal(r2.raw_changed, 0);
  // The only new writes on a no-op run are the ingest event itself.
  assert.equal(r2.nedb_seq, r1.nedb_seq + 1);

  // Upstream corrects one play: yards_gained 11 -> 12 on play 1012.
  const idx = src.plays_payload.findIndex((p) => p.play_id === 1012);
  src.plays_payload[idx] = { ...src.plays_payload[idx], yards_gained: 12 };
  const r3 = await ingest({ store, source: src, scope: { gameId: FIXTURE_GAME_ID }, now: () => "2026-09-03T00:02:00Z" });
  assert.equal(r3.raw_written, 1);
  assert.equal(r3.raw_changed, 1);
  assert.equal(r3.raw_duplicates, 159);
  assert.equal(r3.normalized_written, 1);
  assert.equal(r3.normalized_skipped, 159);
  const raw = await store.get<{ source_version: number; source_payload: { yards_gained: number } }>(COLL.raw_plays, `fixture:/v1/plays:${FIXTURE_GAME_ID}:1012`);
  assert.equal(raw!.data.source_version, 2);
  assert.equal(raw!.data.source_payload.yards_gained, 12);
  const changes = await store.query<{ changed_fields: string[]; previous_source_version: number; new_source_version: number }>(`FROM ${COLL.source_changes}`);
  assert.equal(changes.length, 1);
  assert.deepEqual(changes[0].data.changed_fields, ["yards_gained"]);
  assert.equal(changes[0].data.previous_source_version, 1);
  assert.equal(changes[0].data.new_source_version, 2);
  // Normalized play carries the NEW raw hash and is caused_by both the raw and its own previous version.
  const play = await store.get<{ yards_gained: number; derived_from: string[] }>(COLL.plays, `${FIXTURE_GAME_ID}:1012`);
  assert.equal(play!.data.yards_gained, 12);
  assert.equal(play!.data.derived_from[0], raw!._hash);
  const trace = await store.trace(COLL.plays, `${FIXTURE_GAME_ID}:1012`);
  const colls = trace.map((t) => t._coll);
  assert.ok(colls.includes(COLL.raw_plays));
  assert.ok(trace.length >= 3, `expected play -> raw v2 -> raw v1 (+ previous play) in trace, got ${trace.length}`);
  // History preserved: the previous raw version is still reachable.
  const versions = trace.filter((t) => t._coll === COLL.raw_plays);
  assert.ok(versions.length >= 2);
});

test("analysis persists with caused_by evidence and TRACE reaches raw source rows", { skip }, async () => {
  const r = await runThirdDown(store, { team: "TB", game_id: FIXTURE_GAME_ID });
  assert.equal(r.analysis.metrics.attempts, 15);
  assert.equal(r.cached, false);
  assert.ok(r.stored);
  const again = await runThirdDown(store, { team: "TB", game_id: FIXTURE_GAME_ID });
  assert.equal(again.cached, true);
  assert.equal(again.analysis.id, r.analysis.id);
  const trace = await store.trace(COLL.analyses, r.analysis.id);
  const byColl = trace.reduce<Record<string, number>>((m, t) => ((m[t._coll] = (m[t._coll] ?? 0) + 1), m), {});
  assert.equal(byColl[COLL.analyses], 1);
  // TRACE returns HISTORY: play 1012 was re-derived after the upstream change,
  // so both of its versions appear. 15 distinct plays, 16 play versions.
  const playVersions = trace.filter((t) => t._coll === COLL.plays);
  assert.equal(new Set(playVersions.map((t) => t._id)).size, 15);
  assert.equal(playVersions.length, 16);
  assert.ok(byColl[COLL.raw_plays] >= 16, `raw versions in trace: ${byColl[COLL.raw_plays]}`);
});

test("rating persists over a real (two-team) population and is idempotent", { skip }, async () => {
  invalidateLeagueCache();
  const r = await rateThirdDown(store, "TB", 2025, THIRD_DOWN_DEFAULT_V1);
  assert.ok(r);
  assert.equal(r!.population.length, 2);
  assert.equal(r!.snapshot.score, 75);
  assert.equal(r!.rank, 1);
  assert.equal(r!.cached, false);
  const r2 = await rateThirdDown(store, "TB", 2025, THIRD_DOWN_DEFAULT_V1);
  assert.equal(r2!.cached, true);
  const trace = await store.trace(COLL.ratings, r!.snapshot.id);
  assert.ok(trace.some((t) => t._coll === COLL.rating_definitions));
  assert.ok(trace.some((t) => t._coll === COLL.analyses));
  assert.ok(trace.some((t) => t._coll === COLL.plays));
});

test("pulse: observations land as immutable rows with derived game state (fake provider)", { skip }, async () => {
  const fakeFetch = (async (url: string | URL | Request) => {
    const u = String(url);
    const ev = { idEvent: "999", strHomeTeam: "Tampa Bay Buccaneers", strAwayTeam: "Carolina Panthers", intHomeScore: "16", intAwayScore: "14", strStatus: "Match Finished", strTimestamp: "2026-01-03T18:00:00", strSeason: "2025", intRound: "18" };
    if (u.includes("eventspastleague")) return new Response(JSON.stringify({ events: [ev] }), { status: 200 });
    if (u.includes("eventsnextleague")) return new Response(JSON.stringify({ events: [{ ...ev, idEvent: "1000", intHomeScore: null, intAwayScore: null, strStatus: "Not Started", strTimestamp: "2026-09-13T17:00:00", strSeason: "2026" }] }), { status: 200 });
    return new Response(JSON.stringify({ events: null }), { status: 200 });
  }) as typeof fetch;
  const src = new TheSportsDBSource({ fetchImpl: fakeFetch, key: "3" });
  const games = (await store.query<{ id: string; home_team: string; away_team: string; season: number }>(`FROM ${COLL.games}`)).map((g) => g.data);
  const t1 = await pulseTick({ store, source: src, knownGames: games as never, now: () => "2026-09-03T00:00:00Z" });
  assert.equal(t1.observations, 2);
  assert.equal(t1.raw_written, 2);
  assert.equal(t1.states_written, 2);
  assert.equal(t1.errors.length, 0, JSON.stringify(t1.errors));
  const final = await store.get<{ phase: string; game_id: string | null; home_team: string }>("football_game_state", "thesportsdb:999");
  assert.equal(final!.data.phase, "final");
  assert.equal(final!.data.home_team, "TB");
  assert.equal(final!.data.game_id, FIXTURE_GAME_ID); // matched to the knowledge layer
  const sched = await store.get<{ phase: string }>("football_game_state", "thesportsdb:1000");
  assert.equal(sched!.data.phase, "scheduled");
  const t2 = await pulseTick({ store, source: src, knownGames: games as never, now: () => "2026-09-03T00:02:00Z" });
  assert.equal(t2.raw_written, 0);
  assert.equal(t2.raw_duplicates, 2);
  assert.equal(t2.states_skipped, 2);
});

test("verify: the whole test store is tamper-evident after all writes", { skip }, async () => {
  const v = await store.verify();
  assert.equal(v.ok, true);
  assert.equal(v.tamper_evident, true);
  assert.equal(v.tampered.length, 0);
  assert.ok(v.objects_checked > 0, `objects_checked=${v.objects_checked}`);
  console.log(`verify: objects_checked=${v.objects_checked} seq=${v.seq}`);
});

test("watch loop is deep by default; CHALK_WATCH_DEEP=0 opts out; --deep always wins", async () => {
  const { resolveWatchDeep } = await import("../src/ingest/watch_config.ts");
  assert.equal(resolveWatchDeep(undefined, undefined), true);
  assert.equal(resolveWatchDeep(undefined, ""), true);
  assert.equal(resolveWatchDeep(undefined, "1"), true);
  assert.equal(resolveWatchDeep(undefined, "0"), false);
  assert.equal(resolveWatchDeep(undefined, " false "), false);
  assert.equal(resolveWatchDeep(undefined, "off"), false);
  assert.equal(resolveWatchDeep(true, "0"), true);
});
