import { test, after } from "node:test";
import assert from "node:assert/strict";
import type { Store } from "../src/store/nedb.ts";
import { makeTestStore, STORE_KIND } from "./stores.ts";
import { adminOverview, adminAuthorized, validateTelemetry, telemetryDoc, TELEMETRY } from "../src/server/admin.ts";
import { setHidden, hiddenSet, isHidden, listModeration, validateModeration } from "../src/server/moderation.ts";
import { findObservation, listRecord, evidenceKey } from "../src/llm/record.ts";
import { feed, post, SR } from "../src/fans/fans.ts";
import { COLL } from "../src/store/collections.ts";
import { deriveFanId, handleFor } from "../src/fans/identity.ts";
import { rate, react } from "../src/fans/fans.ts";

const ts = await makeTestStore("admin_test");
const skip: string | false = ts.skip;
const store: Store = ts.store;
if (skip) console.log(`[admin_test] skipping integration tests on ${STORE_KIND} store: ${skip}`);
after(() => ts?.stop());

test("adminAuthorized: bearer must match exactly; short/unset tokens never authorize", () => {
  const tok = "0123456789abcdef0123456789abcdef";
  assert.equal(adminAuthorized(`Bearer ${tok}`, tok), true);
  assert.equal(adminAuthorized(`bearer ${tok}`, tok), true);
  assert.equal(adminAuthorized(`Bearer ${tok}x`, tok), false);
  assert.equal(adminAuthorized(`Bearer ${tok.slice(0, -1)}Z`, tok), false);
  assert.equal(adminAuthorized(tok, tok), false);
  assert.equal(adminAuthorized(undefined, tok), false);
  assert.equal(adminAuthorized("Bearer short", "short"), false); // < 16 chars: refuse to be configured weakly
  assert.equal(adminAuthorized(`Bearer ${tok}`, undefined), false);
});

test("telemetry: validation keeps only anonymous, bounded fields; doc adds day/hour buckets", () => {
  const ok = validateTelemetry({ event: "view", team: "tb", season: 2025, mode: "coach", view: "feed", viewport: "md", handle: "dad#abc123", ip: "1.2.3.4", ua: "Mozilla" });
  assert.ok(ok.ok, ok.errors.join(";"));
  assert.deepEqual(ok.value, { event: "view", team: "TB", season: 2025, mode: "coach", view: "feed", viewport: "md", handle: "dad#abc123" }); // ip/ua dropped
  assert.equal(validateTelemetry({ event: "hack" }).ok, false);
  assert.equal(validateTelemetry({ event: "view", handle: "<script>#abc123" }).value!.handle, null);
  assert.equal(validateTelemetry({ event: "view", team: "TAMPA" }).value!.team, null);
  const d = telemetryDoc(ok.value!, new Date("2026-09-04T16:30:00Z"));
  assert.equal(d.day, "2026-09-04"); assert.equal(d.hour, 16); assert.equal(d.v, "1");
});

test("adminOverview: aggregates asks, answers, fans, telemetry and health from the store", { skip }, async () => {
  const now = new Date().toISOString();
  const qe = (question: string, extra: Record<string, unknown>) => ({ question, context: { team: "TB", season: 2025 }, created_at: now, plan_ok: true, intent: "rating", latency_ms: 900, llm_ms: 700, exec_ms: 50, ...extra });
  await store.put(COLL.query_events, "q1", qe("How is the TB offense rated?", { from_record: false }));
  await store.put(COLL.query_events, "q2", qe("How is the TB offense rated?", { from_record: true, llm_ms: undefined }));
  await store.put(COLL.query_events, "q3", qe("best game tampa 2025", { intent: "game_rank", plan_fallback: true, plan_errors: ["model proposed unsupported"] }));
  await store.put(COLL.query_events, "q4", qe("what is the meaning of life", { plan_ok: false, plan_errors: ["rule planner could not interpret the question"], intent: undefined }));
  await store.put(COLL.query_events, "q5", qe("tell me about injuries", { intent: "unsupported" }));
  await store.put(COLL.query_events, "q6", qe("old one", { created_at: "2020-01-01T00:00:00Z" }));
  await store.put(COLL.observations, "obs1", { question: "How is the TB offense rated?", intent: "rating", team: "TB", season: 2025, model: "GLM-4-32B", answer: "ok", answer_truncated: false, error: null, created_at: now, query_plan: { id: "p", intent: "rating", filters: {}, source: "model" }, evidence_ids: [], evidence_count: 1, calculation_ids: [], raw_output: "", finish_reason: "stop", latency_ms: 700, model_revision: null, prompt_version: "0.4.1" });
  const dad = { fan_id: deriveFanId("dad", "a1"), handle: handleFor("dad", deriveFanId("dad", "a1")), nickname: "dad" };
  await rate(store, dad, { team: "TB", season: 2025, subject: "offense", score: 70 });
  await react(store, dad, { target_coll: COLL.observations, target_id: "obs1", reaction: "agree" });
  await store.put(TELEMETRY, "t1", telemetryDoc(validateTelemetry({ event: "view", team: "TB", season: 2025, mode: "fan", view: "home", viewport: "lg", handle: dad.handle }).value!) as unknown as Record<string, unknown>);
  await store.put(TELEMETRY, "t2", telemetryDoc(validateTelemetry({ event: "tab", team: "TB", season: 2025, mode: "coach", view: "feed", viewport: "sm" }).value!) as unknown as Record<string, unknown>);

  const o = await adminOverview(store, { season: 2025, windowDays: 30 });
  assert.equal(o.asks.total, 6); assert.equal(o.asks.in_window, 5);
  assert.equal(o.asks.from_record, 1); assert.equal(o.asks.from_record_rate, 20);
  assert.equal(o.asks.plan_fallback, 1); assert.equal(o.asks.plan_failed, 1);
  assert.equal(o.asks.intents.find((i) => i.key === "rating")!.n, 2);
  assert.equal(o.asks.teams[0].key, "TB");
  assert.ok(o.asks.team_intent.some((x) => x.team === "TB" && x.intent === "game_rank" && x.n === 1));
  assert.equal(o.asks.latency_ms.p50, 900); assert.equal(o.asks.latency_ms.llm_p50, 700);
  assert.ok(o.asks.heat.length >= 1 && o.asks.per_day.length === 1);
  assert.equal(o.questions.top[0].key, "how is the tb offense rated"); assert.equal(o.questions.top[0].n, 2);
  assert.deepEqual(o.questions.unanswered.map((u) => u.question).sort(), ["tell me about injuries", "what is the meaning of life"]);
  assert.equal(o.questions.fallbacks[0].question, "best game tampa 2025");
  assert.equal(o.answers.complete, 1); assert.deepEqual(o.answers.reactions, { like: 0, agree: 1, disagree: 0 });
  assert.equal(o.answers.most_reacted[0].id, "obs1");
  assert.equal(o.fans.total, 1); assert.equal(o.fans.active_7d, 1); assert.equal(o.fans.ratings, 1); assert.equal(o.fans.reactions, 1);
  assert.equal(o.fans.consensus.find((c) => c.subject === "offense")!.mean, 70);
  assert.equal(o.fans.top_handles[0].handle, dad.handle);
  assert.equal(o.preferences.views, 1); assert.equal(o.preferences.returning_handles, 1);
  assert.equal(o.preferences.modes[0].key, "fan");
  assert.equal(o.preferences.tabs.length, 2);
  assert.equal(o.preferences.viewports[0].key, "lg");
  assert.ok(o.health.seq > 0 && o.health.head.length > 10);
  assert.ok(o.health.audit && o.health.audit.season === 2025);
});

test("moderation: hide drops an answer from the record, the feed and serve-from-record; unhide restores; every decision is a provenance row", { skip }, async () => {
  assert.equal(validateModeration({ coll: "users", id: "x" }).ok, false);
  assert.equal(validateModeration({ coll: "football_observations", id: "obs1", reason: "wrong unit" }).ok, true);
  const key = evidenceKey({ intent: "opponent_report", filters: { team: "TB", opponent: "CIN", side: "defense" } }, { kind: "opponent_report", summary: { x: 1 }, calculation_ids: ["c"], calculation_hashes: ["h"], evidence_ids: [] });
  await store.put(COLL.observations, "obs_wrong", { question: "What should I know about the CIN defense?", intent: "opponent_report", team: "TB", season: 2025, evidence_key: key, statements: ["CIN offense, 2025 season: 1049 snaps"], model: "GLM-4-32B", answer: "The CIN offense ...", answer_truncated: false, error: null, created_at: new Date().toISOString(), query_plan: { id: "p", intent: "opponent_report", filters: { team: "TB", opponent: "CIN" }, source: "rules" }, evidence_ids: [], evidence_count: 1049, calculation_ids: ["c"], raw_output: "", finish_reason: "stop", latency_ms: 7000, model_revision: null, prompt_version: "0.4.1" });
  assert.equal((await findObservation(store, key))?._id, "obs_wrong");
  assert.ok((await listRecord(store, { team: "TB", season: 2025 })).items.some((i) => i.id === "obs_wrong"));

  const row = await setHidden(store, COLL.observations, "obs_wrong", true, "described the offense, question was about the defense");
  assert.equal(row.data.hidden, true); assert.equal(row.data.target_hash?.length, 64);
  assert.equal(await isHidden(store, COLL.observations, "obs_wrong"), true);
  assert.ok((await hiddenSet(store)).has(`${COLL.observations}:obs_wrong`));
  assert.equal(await findObservation(store, key), null); // never served from the record again
  assert.ok(!(await listRecord(store, { team: "TB", season: 2025 })).items.some((i) => i.id === "obs_wrong"));
  const log = await listModeration(store);
  assert.equal(log[0].id, "obs_wrong"); assert.match(log[0].reason, /offense/);

  await setHidden(store, COLL.observations, "obs_wrong", false, "");
  assert.equal(await isHidden(store, COLL.observations, "obs_wrong"), false);
  assert.equal((await findObservation(store, key))?._id, "obs_wrong");
  assert.equal((await listModeration(store)).length, 1); // same id, new version — one row, two versions

  const dad = { fan_id: deriveFanId("dad", "m1"), handle: handleFor("dad", deriveFanId("dad", "m1")), nickname: "dad" };
  const p1 = await post(store, dad, { text: "This take gets pulled.", team: "TB", game_id: null, target_coll: null, target_id: null });
  assert.ok((await feed(store, { team: "TB" })).items.some((i) => i.id === p1._id));
  await setHidden(store, SR.posts, p1._id, true, "spam");
  assert.ok(!(await feed(store, { team: "TB" })).items.some((i) => i.id === p1._id));
  await assert.rejects(() => setHidden(store, COLL.observations, "nope", true, ""), /not found/);
});
