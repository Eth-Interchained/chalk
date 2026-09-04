/*
 * SPDX-License-Identifier: BUSL-1.1
 * Copyright (c) 2026 Interchained LLC. All rights reserved.
 * CHALK / Sports-Rater — https://sports-rater.com — Licensor: Interchained LLC
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { explainerSystem, EXPLAINER_SYSTEM, EXPLAINER_SYSTEM_COACH, PROMPT_VERSION } from "../src/llm/prompts.ts";
import { buildMessages } from "../src/llm/explain.ts";
import { evidenceKey } from "../src/llm/record.ts";

const pkg = { kind: "rating", summary: { score: 48 }, calculation_ids: ["c"], calculation_hashes: ["h"], evidence_ids: [], deterministic_statements: ["x"] };
const plan = { intent: "rating" as const, filters: { team: "TB", season: 2025, subject: "offense" } };

test("coach register: a distinct system prompt with the same hard rules; fan is the default", () => {
  assert.equal(explainerSystem(), EXPLAINER_SYSTEM);
  assert.equal(explainerSystem("coach"), EXPLAINER_SYSTEM_COACH);
  assert.notEqual(EXPLAINER_SYSTEM, EXPLAINER_SYSTEM_COACH);
  for (const p of [EXPLAINER_SYSTEM, EXPLAINER_SYSTEM_COACH]) { assert.match(p, /Every number you state must appear in the EVIDENCE JSON/); assert.match(p, /<<<ANSWER>>>/); }
  assert.match(EXPLAINER_SYSTEM_COACH, /COACH mode/); assert.match(EXPLAINER_SYSTEM_COACH, /what to attack or what to fix/);
  assert.equal(buildMessages("q", pkg, { team: "TB", season: 2025 })[0].content, EXPLAINER_SYSTEM);
  assert.equal(buildMessages("q", pkg, { team: "TB", season: 2025, register: "coach" })[0].content, EXPLAINER_SYSTEM_COACH);
  assert.equal(PROMPT_VERSION, "0.5.0");
});

test("evidence key separates registers: a fan answer is never served to a coach, and vice versa", () => {
  const fan = evidenceKey(plan, pkg), fan2 = evidenceKey(plan, pkg, undefined, "fan"), coach = evidenceKey(plan, pkg, undefined, "coach");
  assert.equal(fan, fan2);
  assert.notEqual(fan, coach);
});
