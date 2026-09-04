/*
 * SPDX-License-Identifier: BUSL-1.1
 * Copyright (c) 2026 Interchained LLC. All rights reserved.
 * CHALK / Sports-Rater — https://sports-rater.com — Licensor: Interchained LLC
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { validatePlan, rulePlan, ratingSubjectFor, normalizeRatingSubject, resolveTeam, planQuestion, type PlanContext } from "../src/llm/planner.ts";
import { buildMessages, evidenceBytes, deterministicFallback, type EvidencePackage } from "../src/llm/explain.ts";
import type { LlmConfig } from "../src/llm/client.ts";

const ctx: PlanContext = { default_team: "TB", default_season: 2025, teams: ["TB", "CAR", "ATL", "NO", "KC", "PHI", "DET"] };

test("validatePlan: accepts a well-formed model plan and fills defaults", () => {
  const v = validatePlan({ intent: "tendency", filters: { down: 3, distance_min: 4, distance_max: 6 }, metrics: ["pass_rate"] }, ctx);
  assert.ok(v.ok, v.errors.join(";"));
  assert.equal(v.plan!.filter!.team, "TB");
  assert.equal(v.plan!.filter!.season, 2025);
  assert.deepEqual(v.plan!.filter!.down, [3]);
});

test("validatePlan: rejects unknown intent, unknown filter keys, bad teams", () => {
  assert.equal(validatePlan({ intent: "make_up_stats" }, ctx).ok, false);
  const unk = validatePlan({ intent: "tendency", filters: { coverage: "cover 2" } }, ctx);
  assert.equal(unk.ok, false);
  assert.ok(unk.errors.some((e) => e.includes("unknown keys")));
  const team = validatePlan({ intent: "third_down", filters: { team: "ZZZ" } }, ctx);
  assert.equal(team.ok, false);
  assert.ok(team.errors.some((e) => e.includes("not a known team")));
  assert.equal(validatePlan(null, ctx).ok, false);
  assert.equal(validatePlan({ intent: "play_explain", filters: { play_id: "garbage" } }, ctx).ok, false);
  assert.equal(validatePlan({ intent: "play_explain", filters: { play_id: "2025_18_CAR_TB:1012" } }, ctx).ok, true);
  assert.equal(validatePlan({ intent: "game_summary", filters: {} }, ctx).ok, false);
  assert.equal(validatePlan({ intent: "game_summary", filters: { game_id: "2025_18_CAR_TB" } }, ctx).ok, true);
  const cmp = validatePlan({ intent: "comparison", a: { half: [1] }, b: { half: [2] } }, ctx);
  assert.ok(cmp.ok);
  assert.equal(cmp.plan!.a!.team, "TB");
  const unsupported = validatePlan({ intent: "unsupported", reason: "no coverage data" }, ctx);
  assert.ok(unsupported.ok);
  assert.equal(unsupported.plan!.reason, "no coverage data");
});

test("resolveTeam: names, nicknames, abbreviations, longest match wins", () => {
  assert.equal(resolveTeam("why did tampa lose", ctx.teams), "TB");
  assert.equal(resolveTeam("Tampa Bay vs the Falcons", ctx.teams), "TB");
  assert.equal(resolveTeam("how are the Chiefs", ctx.teams), "KC");
  assert.equal(resolveTeam("show CAR third downs", ctx.teams), "CAR");
  assert.equal(resolveTeam("nothing here", ctx.teams), null);
});

test("rulePlan: covers the seeded question shapes with valid plans", () => {
  const cases: Array<[string, string]> = [
    ["Why is Tampa struggling on third down?", "third_down"],
    ["Show Tampa's third-down performance", "third_down"],
    ["What does Tampa do on 3rd and medium?", "tendency"],
    ["How often does Tampa pass on third and long?", "tendency"],
    ["What situations are hurting Tampa the most?", "situation_scan"],
    ["Compare Tampa this season with last season", "comparison"],
    ["Tampa first half vs second half", "comparison"],
    ["Tampa at home vs away", "comparison"],
    ["How does Tampa's third-down rating break down?", "rating"],
    ["Tampa when trailing", "tendency"],
    ["Tampa in the red zone", "tendency"],
    ["Show Tampa's third-down performance in 2025_18_CAR_TB", "third_down"],
    ["Explain play 2025_18_CAR_TB:1012", "play_explain"],
    ["Why did Tampa lose 2025_18_CAR_TB", "game_summary"],
  ];
  for (const [q, intent] of cases) {
    const p = rulePlan(q, ctx);
    assert.ok(p, `no plan for: ${q}`);
    assert.equal(p!.intent, intent, q);
    assert.equal(p!.source, "rules");
  }
  const medium = rulePlan("What does Tampa do on 3rd and medium?", ctx)!;
  assert.equal(medium.filter!.distance_min, 4);
  assert.equal(medium.filter!.distance_max, 6);
  const long = rulePlan("How often does Tampa pass on third and long?", ctx)!;
  assert.equal(long.filter!.distance_min, 7);
  const cmp = rulePlan("Compare Tampa this season with last season", ctx)!;
  assert.equal(cmp.a!.season, 2024);
  assert.equal(cmp.b!.season, 2025);
  const game = rulePlan("Show Tampa's third-down performance in 2025_18_CAR_TB", ctx)!;
  assert.equal(game.filter!.game_id, "2025_18_CAR_TB");
  const garbage = rulePlan("Tampa third down without garbage time", ctx)!;
  assert.equal(garbage.filter!.exclude_garbage_time, true);
  assert.equal(rulePlan("what is the meaning of life", ctx), null);
});

test("planQuestion: uses the model plan when it validates, falls back to rules otherwise, never throws", async () => {
  const fake = (content: string): LlmConfig => ({
    url: "http://fake", key: "k", model: "fake", provider: "", maxTokens: 100, temperature: 0, inactivityMs: 1000, firstByteMs: 1000,
    fetchImpl: (async () => new Response(JSON.stringify({ model: "fake", choices: [{ finish_reason: "stop", message: { content } }] }), { status: 200 })) as typeof fetch,
  });
  const good = await planQuestion("third down", ctx, fake('<<<PLAN>>>{"intent":"third_down","filters":{"team":"CAR"},"metrics":[]}<<<END>>>'), null);
  assert.ok(good.ok);
  assert.equal(good.plan!.source, "model");
  assert.equal(good.plan!.filter!.team, "CAR");
  assert.equal(good.fallback_used, false);

  const invalid = await planQuestion("Show Tampa's third-down performance", ctx, fake('<<<PLAN>>>{"intent":"invent_stats"}<<<END>>>'), null);
  assert.ok(invalid.ok);
  assert.equal(invalid.plan!.source, "rules");
  assert.equal(invalid.fallback_used, true);
  assert.ok(invalid.errors.length > 0);

  const noBlock = await planQuestion("Show Tampa's third-down performance", ctx, fake("I think third down is important."), null);
  assert.ok(noBlock.ok);
  assert.equal(noBlock.fallback_used, true);
  assert.ok(noBlock.errors[0].includes("no closed <<<PLAN>>> block"));

  const truncated: LlmConfig = { ...fake("x"), fetchImpl: (async () => new Response(JSON.stringify({ choices: [{ finish_reason: "length", message: { content: '<<<PLAN>>>{"intent":"third_down"' } }] }), { status: 200 })) as typeof fetch };
  const tr = await planQuestion("Show Tampa's third-down performance", ctx, truncated, null);
  assert.ok(tr.fallback_used);
  assert.ok(tr.errors[0].includes("truncated"));

  const down: LlmConfig = { ...fake("x"), fetchImpl: (async () => new Response("upstream exploded", { status: 503 })) as typeof fetch };
  const dn = await planQuestion("Show Tampa's third-down performance", ctx, down, null);
  assert.ok(dn.ok);
  assert.ok(dn.fallback_used);
  assert.ok(dn.errors[0].includes("503"));

  const nonsense = await planQuestion("what is the meaning of life", ctx, down, null);
  assert.equal(nonsense.ok, false);
  assert.ok(nonsense.errors.length >= 2);
});

test("explain: evidence prompt stays compact and the fallback is never blank", () => {
  const pkg: EvidencePackage = { kind: "third_down", summary: { attempts: 15, conversions: 8, conversion_pct: 53.3, by_distance: [1, 2, 3, 4].map((i) => ({ distance: `${i}`, attempts: i, conversions: 1, conversion_pct: 10 })) }, calculation_ids: ["tdn_x"], calculation_hashes: ["h"], evidence_ids: Array.from({ length: 230 }, (_, i) => `g:${i}`), deterministic_statements: ["TB converted 8 of 15."] };
  const bytes = evidenceBytes("Why?", pkg, { team: "TB", season: 2025 });
  assert.ok(bytes < 6000, `evidence prompt is ${bytes} bytes`);
  const msgs = buildMessages("Why?", pkg, { team: "TB", season: 2025 });
  assert.equal(msgs.length, 2);
  assert.ok(msgs[1].content.includes('"evidence_play_count":230'));
  assert.ok(!msgs[1].content.includes("g:229")); // play ids are not sent
  assert.equal(deterministicFallback(pkg), "TB converted 8 of 15.");
  assert.ok(deterministicFallback({ ...pkg, deterministic_statements: [] }).length > 20);
});

test("opponent_report: 'the CIN defense' scouts CIN's DEFENSE; model plan with team=CIN and no opponent is repaired, not rejected", () => {
  const ctx = { default_team: "TB", default_season: 2025, teams: ["TB", "CIN", "KC", "CAR"], next_opponent: "CIN" };
  const d = rulePlan("What should I know about the CIN defense?", ctx)!;
  assert.equal(d.intent, "opponent_report");
  assert.deepEqual([d.filters.team, d.filters.opponent, d.filters.side], ["TB", "CIN", "defense"]);
  const o = rulePlan("What should I know about the CIN offense?", ctx)!;
  assert.equal(o.filters.side, "offense");
  const t = rulePlan("How do we attack their defensive front this week?", ctx)!;
  assert.deepEqual([t.filters.opponent, t.filters.side], ["CIN", "defense"]);
  const n = rulePlan("What should I know about this week's opponent?", ctx)!;
  assert.deepEqual([n.filters.opponent, n.filters.side], ["CIN", "offense"]);
  // Model wrote the scouted team into `team` and omitted `opponent` (the exact rejection Mark saw in the logs).
  const v = validatePlan({ intent: "opponent_report", filters: { team: "CIN", season: 2025, side: "defense" } }, ctx);
  assert.ok(v.ok, v.errors.join(";"));
  assert.deepEqual([v.plan!.filters.team, v.plan!.filters.opponent, v.plan!.filters.side], ["TB", "CIN", "defense"]);
  // No team, no opponent -> schedule; and without a schedule it is a clear error.
  assert.equal(validatePlan({ intent: "opponent_report", filters: { season: 2025 } }, ctx).plan!.filters.opponent, "CIN");
  assert.match(validatePlan({ intent: "opponent_report", filters: { season: 2025 } }, { ...ctx, next_opponent: undefined }).errors[0], /no team named and no next opponent/);
  assert.match(validatePlan({ intent: "opponent_report", filters: { team: "TB", opponent: "TB" } }, ctx).errors[0], /same as team/);
});

test("badge questions always plan: metric words and badge names map to a rating subject; model subject aliases are repaired; rules never throw", () => {
  const ctx = { default_team: "TB", default_season: 2025, teams: ["TB", "CIN", "KC", "CAR"] };
  const h = rulePlan("Why does Tampa Bay have the achilles heel · success rate badge?", ctx)!;
  assert.equal(h.intent, "rating"); assert.equal(h.filters.subject, "offense");
  assert.equal(rulePlan("Why does Tampa have the protects the ball badge?", ctx)!.filters.subject, "ball_security");
  assert.equal(rulePlan("Why does Tampa have the converts badge?", ctx)!.filters.subject, "third_down");
  assert.equal(rulePlan("Why does Tampa have the big play threat badge?", ctx)!.filters.subject, "explosiveness");
  assert.equal(rulePlan("Why does Tampa have the signature · ball security badge?", ctx)!.filters.subject, "ball_security");
  assert.equal(rulePlan("Why does Tampa have the mystery badge?", ctx)!.filters.subject, "offense"); // unknown badge word -> offense, never a failure
  assert.equal(normalizeRatingSubject("success"), "offense");
  assert.equal(normalizeRatingSubject("Success Rate"), "offense");
  assert.equal(normalizeRatingSubject("turnovers"), "ball_security");
  assert.equal(normalizeRatingSubject("third-down"), "third_down");
  assert.equal(normalizeRatingSubject("vibes"), null);
  assert.equal(ratingSubjectFor("epa per play"), "offense");
  const v = validatePlan({ intent: "rating", filters: { team: "TB", season: 2025, subject: "success" } }, ctx);
  assert.ok(v.ok, v.errors.join(";")); assert.equal(v.plan!.filters.subject, "offense");
  assert.match(validatePlan({ intent: "rating", filters: { team: "TB", season: 2025, subject: "vibes" } }, ctx).errors[0], /unknown "vibes" \(one of/);
});
