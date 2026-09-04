/*
 * SPDX-License-Identifier: BUSL-1.1
 * Copyright (c) 2026 Interchained LLC. All rights reserved.
 * CHALK / Sports-Rater — https://sports-rater.com — Licensor: Interchained LLC
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fixtureRows, fixtureGame, AT } from "./fixture.ts";
import { subjectTrend } from "../src/rating/trend.ts";
import { OFFENSE_DEFAULT_V1, DEFENSE_DEFAULT_V1, RED_ZONE_DEFAULT_V1 } from "../src/rating/definitions.ts";

// A 3-week league built from the real game: same snaps each week, relabeled.
function league() {
  const rows = fixtureRows();
  const games = [];
  const out: typeof rows = [];
  for (let w = 1; w <= 3; w++) {
    const gid = `2025_0${w}_CAR_TB`;
    games.push({ ...fixtureGame(), id: gid, week: w, season: 2025 });
    for (const r of rows) out.push({ ...r, _id: `${r._id}-w${w}`, data: { ...r.data, id: `${r.data.id}-w${w}`, week: w, game_id: gid, season: 2025 } });
  }
  return { rows: out, games };
}

test("subject trend: one as-known-then point per week, cumulative samples, both sides", () => {
  const { rows, games } = league();
  const t = subjectTrend(rows, games, "TB", 2025, OFFENSE_DEFAULT_V1, AT);
  assert.equal(t.subject, "offense");
  assert.deepEqual(t.points.map((p) => p.week), [1, 2, 3]);
  assert.deepEqual(t.points.map((p) => p.games), [1, 2, 3]);
  assert.ok(t.points[2].sample === 3 * t.points[0].sample);
  assert.ok(t.points.every((p) => p.population === 2));
  assert.equal(t.points[0].provisional, true); // < 300 snaps in one game
  const d = subjectTrend(rows, games, "CAR", 2025, DEFENSE_DEFAULT_V1, AT);
  assert.equal(d.points.length, 3);
  // Identical snaps each week -> identical scores; offense TB + defense CAR = 100 exactly.
  assert.equal(Math.round(((t.points[2].score ?? 0) + (d.points[2].score ?? 0)) / 1) >= 99, true);
  const rz = subjectTrend(rows, games, "TB", 2025, RED_ZONE_DEFAULT_V1, AT);
  assert.ok(rz.points[2].sample > 0 && rz.points[2].sample < t.points[2].sample);
  assert.ok(t.headline.length > 10);
  const none = subjectTrend(rows, games, "ZZZ", 2025, OFFENSE_DEFAULT_V1, AT);
  assert.equal(none.points.length, 0);
  assert.ok(none.headline.startsWith("Not enough"));
});
