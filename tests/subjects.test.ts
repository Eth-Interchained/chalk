/*
 * SPDX-License-Identifier: BUSL-1.1
 * Copyright (c) 2026 Interchained LLC. All rights reserved.
 * CHALK / Sports-Rater — https://sports-rater.com — Licensor: Interchained LLC
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fixtureRows, fixtureGame } from "./fixture.ts";
import { leagueProfiles, profileMembers } from "../src/rating/subjects.ts";
import { computeRating } from "../src/rating/rating.ts";
import { BALL_SECURITY_V1, BUILTIN_DEFINITIONS, CARD_SUBJECTS, DEFENSE_DEFAULT_V1, EXPLOSIVENESS_V1, OFFENSE_DEFAULT_V1, RATEABLE_METRICS, RED_ZONE_DEFAULT_V1, validateDefinition } from "../src/rating/definitions.ts";
import { rulePlan, validatePlan } from "../src/llm/planner.ts";

const rows = fixtureRows();
const game = fixtureGame();

test("league profiles: one per team, offense and defense mirror each other on the same game", () => {
  const off = leagueProfiles(rows, 2025, "offense", [game]);
  const def = leagueProfiles(rows, 2025, "defense", [game]);
  assert.deepEqual([...off.keys()].sort(), ["CAR", "TB"]);
  const tbO = off.get("TB")!, carD = def.get("CAR")!;
  // TB's offense snaps ARE CAR's defense snaps.
  assert.equal(tbO.attempts, carD.attempts);
  assert.equal(tbO.epa_per_play, carD.epa_per_play);
  assert.equal(tbO.third_down_attempts, 15);
  assert.equal(tbO.third_down_conversion_rate, 8 / 15);
  assert.equal(carD.third_down_attempts, 15);
  assert.ok(tbO.red_zone_attempts > 0);
  assert.equal(tbO.games, 1);
  assert.equal(tbO.points_per_game, 16);
  assert.equal(carD.points_per_game, 16); // points allowed by CAR = TB's 16
  assert.equal(off.get("CAR")!.points_per_game, 14);
});

test("offense/defense/red-zone/explosiveness/ball-security ratings compute over profiles", () => {
  const off = leagueProfiles(rows, 2025, "offense", [game]);
  const members = profileMembers(off, (p) => p.attempts);
  const tb = members.find((m) => m.key === "TB")!;
  for (const def of [OFFENSE_DEFAULT_V1, RED_ZONE_DEFAULT_V1, EXPLOSIVENESS_V1, BALL_SECURITY_V1]) {
    const s = computeRating(def, tb, members, { season: 2025, description: "t" });
    assert.ok(s.score !== null, def.id);
    assert.equal(s.components.length, def.components.length);
    assert.ok(s.components.every((c) => c.population_n === 2));
  }
  const defP = leagueProfiles(rows, 2025, "defense", [game]);
  const dm = profileMembers(defP, (p) => p.attempts);
  const carD = computeRating(DEFENSE_DEFAULT_V1, dm.find((m) => m.key === "CAR")!, dm, { season: 2025, description: "t" });
  const tbO = computeRating(OFFENSE_DEFAULT_V1, tb, members, { season: 2025, description: "t" });
  // Two-team league: TB offense vs CAR defense see the same snaps; a strong TB offense means a weak CAR defense.
  assert.equal(Math.round((tbO.score_exact! + carD.score_exact!) * 1000) / 1000, 100); // exact; rounded scores can sum to 101
});

test("definitions: every built-in names metrics available on its subject; card covers each subject once", () => {
  for (const d of BUILTIN_DEFINITIONS) {
    for (const c of d.components) {
      assert.ok(c.metric in RATEABLE_METRICS, `${d.id}.${c.metric}`);
      assert.ok(RATEABLE_METRICS[c.metric].subjects.includes(d.subject), `${d.id}.${c.metric} not rateable on ${d.subject}`);
    }
    assert.ok(Math.abs(d.components.reduce((s, c) => s + c.weight, 0) - 1) < 1e-9, d.id);
  }
  assert.equal(new Set(CARD_SUBJECTS.map((c) => c.subject)).size, CARD_SUBJECTS.length);
  const v = validateDefinition({ name: "Dad Offense", subject: "offense", components: [{ metric: "turnover_rate", weight: 40 }, { metric: "epa_per_play", weight: 60 }] });
  assert.ok(v.ok, v.errors.join(";"));
  assert.equal(v.definition!.subject, "offense");
  assert.equal(v.definition!.min_sample, 300);
  const bad = validateDefinition({ name: "x", subject: "red_zone", components: [{ metric: "conversion_rate", weight: 1 }] });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors[0].includes("not available on subject"));
  assert.equal(validateDefinition({ name: "x", subject: "vibes", components: [{ metric: "epa_per_play", weight: 1 }] }).ok, false);
});

test("planner: rating subjects route from plain questions and validate", () => {
  const ctx = { default_team: "TB", default_season: 2025, teams: ["TB", "CAR"] };
  assert.equal(rulePlan("What is Tampa's red zone rating?", ctx)!.filters.subject, "red_zone");
  assert.equal(rulePlan("How is the Tampa offense rated overall", ctx)!.filters.subject, "offense");
  assert.equal(rulePlan("Grade the Bucs defense", ctx)!.filters.subject, "defense");
  assert.equal(rulePlan("Why does Tampa have the ball security badge?", ctx)!.filters.subject, "ball_security");
  assert.equal(rulePlan("How does Tampa's third-down rating break down?", ctx)!.filters.subject, "third_down");
  assert.ok(validatePlan({ intent: "rating", filters: { subject: "explosiveness" } }, ctx).ok);
  assert.equal(validatePlan({ intent: "rating", filters: { subject: "vibes" } }, ctx).ok, false);
});
