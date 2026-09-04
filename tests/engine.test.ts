/*
 * SPDX-License-Identifier: BUSL-1.1
 * Copyright (c) 2026 Interchained LLC. All rights reserved.
 * CHALK / Sports-Rater — https://sports-rater.com — Licensor: Interchained LLC
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fixtureRows, fixtureGame, rawPlays, AT, FIXTURE_GAME_ID } from "./fixture.ts";
import { analyzeThirdDown, thirdDownFilter, summarizeThirdDown } from "../src/engine/thirddown.ts";
import { applyFilter, compileNql, describeFilter, validateFilter } from "../src/engine/situation.ts";
import { computeMetrics, confidenceFor, groupByDistanceBucket, ppDelta } from "../src/engine/metrics.ts";
import { analyzeTendency, baselineFilter } from "../src/engine/tendency.ts";
import { compare } from "../src/engine/comparison.ts";
import { scanSituations, SCAN_MIN_SAMPLE } from "../src/engine/scan.ts";
import { analyzeDeviation } from "../src/engine/deviation.ts";
import { distanceBucket, fieldZone, isGarbageTime } from "../src/model/football.ts";
import { normalizeNflDataPlay } from "../src/ingest/normalize.ts";
import { nqlStr } from "../src/store/nedb.ts";

const rows = fixtureRows();

test("fixture: 159 plays, game normalizes with winner and margin", () => {
  assert.equal(rows.length, 159);
  const g = fixtureGame();
  assert.equal(g.id, FIXTURE_GAME_ID);
  assert.equal(g.home_team, "TB");
  assert.equal(g.away_team, "CAR");
  assert.equal(g.winner, "TB");
  assert.equal(g.margin, 2);
});

test("third down: TB 8-of-15 exactly, buckets sum, evidence ids unique", () => {
  const a = analyzeThirdDown(rows, thirdDownFilter({ team: "TB", game_id: FIXTURE_GAME_ID }), AT);
  assert.equal(a.metrics.attempts, 15);
  assert.equal(a.metrics.conversions, 8);
  assert.equal(Math.round(a.metrics.conversion_rate! * 1000) / 10, 53.3);
  assert.equal(a.third_and_long.metrics.attempts, 7);
  assert.equal(a.third_and_long.metrics.conversions, 2);
  assert.equal(a.third_and_short.metrics.attempts, 3);
  assert.equal(a.third_and_short.metrics.conversions, 3);
  const bucketSum = a.by_distance.reduce((n, b) => n + b.metrics.attempts, 0);
  assert.equal(bucketSum, 15);
  assert.equal(new Set(a.evidence).size, 15);
  assert.equal(a.evidence_hashes.length, 15);
  assert.equal(a.metrics.turnovers, 1);
  assert.equal(a.confidence, "low");
  // Exclusions only count TB's own third downs. The fixture's single
  // third-down no_play (play 2497) is Carolina's, so TB excludes nothing.
  assert.deepEqual(a.excluded, {});
  assert.equal(a.candidates, 15);
  const car = analyzeThirdDown(rows, thirdDownFilter({ team: "CAR", game_id: FIXTURE_GAME_ID }), AT);
  assert.deepEqual(car.excluded, { no_play: 1 });
  assert.equal(car.candidates, 9);
});

test("third down: CAR 1-of-8; opponent filter matches", () => {
  const a = analyzeThirdDown(rows, thirdDownFilter({ team: "CAR", game_id: FIXTURE_GAME_ID }), AT);
  assert.equal(a.metrics.attempts, 8);
  assert.equal(a.metrics.conversions, 1);
  const b = analyzeThirdDown(rows, thirdDownFilter({ team: "TB", game_id: FIXTURE_GAME_ID, opponent: "CAR" }), AT);
  assert.equal(b.metrics.attempts, 15);
  const c = analyzeThirdDown(rows, thirdDownFilter({ team: "TB", game_id: FIXTURE_GAME_ID, opponent: "ATL" }), AT);
  assert.equal(c.metrics.attempts, 0);
  assert.equal(c.metrics.conversion_rate, null);
  assert.equal(c.confidence, "insufficient");
});

test("third down: defense side flips to the opponent's snaps", () => {
  const d = analyzeThirdDown(rows, thirdDownFilter({ team: "TB", game_id: FIXTURE_GAME_ID, side: "defense" }), AT);
  assert.equal(d.metrics.attempts, 8); // CAR's third downs against TB
  assert.equal(d.metrics.conversions, 1);
});

test("analysis id is content-derived: same input same id, different data different id", () => {
  const a1 = analyzeThirdDown(rows, thirdDownFilter({ team: "TB", game_id: FIXTURE_GAME_ID }), AT, "t1");
  const a2 = analyzeThirdDown(rows, thirdDownFilter({ team: "TB", game_id: FIXTURE_GAME_ID }), { seq: 99, head: "other" }, "t2");
  assert.equal(a1.id, a2.id);
  const fewer = rows.filter((r) => r.data.play_id !== 504);
  const a3 = analyzeThirdDown(fewer, thirdDownFilter({ team: "TB", game_id: FIXTURE_GAME_ID }), AT);
  assert.notEqual(a3.id, a1.id);
  assert.equal(a3.metrics.attempts, 14);
});

test("summary rounding is presentation-only and null-safe", () => {
  const a = analyzeThirdDown(rows, thirdDownFilter({ team: "TB", game_id: FIXTURE_GAME_ID }), AT);
  const s = summarizeThirdDown(a);
  assert.equal(s.conversion_pct, 53.3);
  assert.equal(s.attempts, 15);
  const vl = s.by_distance.find((b) => b.distance === "11+")!;
  assert.equal(vl.attempts, 1);
  assert.equal(vl.conversion_pct, 0);
});

test("situation filter: validation accepts, normalizes and rejects precisely", () => {
  const ok = validateFilter({ team: "tb", season: 2025, down: [3, 3], distance_min: 4, distance_max: 6, quarter: 4, score_state: "trailing" });
  assert.ok(ok.ok, ok.errors.join(";"));
  assert.equal(ok.filter!.team, "TB");
  assert.deepEqual(ok.filter!.down, [3]);
  assert.deepEqual(ok.filter!.quarter, [4]);
  assert.deepEqual(ok.filter!.score_state, ["trailing"]);
  assert.equal(ok.filter!.exclude_kneels, true);
  assert.equal(ok.filter!.exclude_garbage_time, false);

  const bad = validateFilter({ team: "Tampa Bay", down: 5, distance_min: 8, distance_max: 4, bogus: 1 });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((e) => e.startsWith("team")));
  assert.ok(bad.errors.some((e) => e.startsWith("down")));
  assert.ok(bad.errors.some((e) => e.includes("distance_min > distance_max")));
  assert.ok(bad.errors.some((e) => e.includes("season, game_id, game_ids")));
  assert.deepEqual(bad.unknown_keys, ["bogus"]);

  assert.equal(validateFilter(null).ok, false);
  assert.equal(validateFilter({ team: "TB", game_id: "nope" }).ok, false);
  assert.equal(validateFilter({ team: "TB", game_id: "2025_18_CAR_TB" }).ok, true);
});

test("situation filter: NQL compile is coarse and escapes literals", () => {
  const f = validateFilter({ team: "TB", season: 2025, down: 3, distance_min: 7 }).filter!;
  assert.equal(compileNql(f), 'FROM football_plays WHERE posteam = "TB" AND season = 2025 AND down = 3');
  const d = validateFilter({ team: "TB", season: 2025, side: "defense", down: [1, 2] }).filter!;
  assert.equal(compileNql(d), 'FROM football_plays WHERE defteam = "TB" AND season = 2025');
  const g = validateFilter({ team: "TB", game_id: "2025_18_CAR_TB" }).filter!;
  assert.ok(compileNql(g).includes('game_id = "2025_18_CAR_TB"'));
  assert.equal(nqlStr('a"b\\c'), '"a\\"b\\\\c"');
});

test("situation filter: excluded plays and dimensions", () => {
  const plays = rows.map((r) => r.data);
  const base = validateFilter({ team: "TB", game_id: FIXTURE_GAME_ID }).filter!;
  const snaps = applyFilter(plays, base);
  assert.ok(snaps.every((p) => p.is_snap && !p.is_no_play && !p.is_kneel && !p.is_spike));
  assert.ok(snaps.every((p) => p.posteam === "TB"));
  const withNoPlay = applyFilter(plays, { ...base, exclude_no_play: false, snaps_only: false });
  assert.ok(withNoPlay.length > snaps.length);
  assert.ok(withNoPlay.some((p) => p.is_no_play));
  const q4 = applyFilter(plays, { ...base, quarter: [4] });
  assert.ok(q4.length > 0 && q4.every((p) => p.quarter === 4));
  const h1 = applyFilter(plays, { ...base, half: [1] });
  assert.ok(h1.every((p) => p.quarter !== null && p.quarter <= 2));
  const lead = applyFilter(plays, { ...base, score_state: ["leading"] });
  assert.ok(lead.every((p) => p.score_diff !== null && p.score_diff > 0));
  const rz = applyFilter(plays, { ...base, field_zone: ["red_zone"] });
  assert.ok(rz.every((p) => p.yardline_100 !== null && p.yardline_100 <= 20));
  const home = applyFilter(plays, { ...base, home: true });
  assert.equal(home.length, snaps.length); // TB was home
  const away = applyFilter(plays, { ...base, home: false });
  assert.equal(away.length, 0);
  // defense side score_state flips
  const defLead = applyFilter(plays, { ...base, side: "defense", score_state: ["leading"] });
  assert.ok(defLead.every((p) => p.defteam === "TB" && p.score_diff !== null && p.score_diff < 0));
  assert.ok(describeFilter({ ...base, down: [3], distance_min: 7 }).includes("distance 7-99"));
});

test("metrics: definitions hold on a hand-built sample", () => {
  const mk = (over: Partial<ReturnType<typeof normalizeNflDataPlay>>) =>
    ({ ...normalizeNflDataPlay({ game_id: "x", play_id: 1, play_type: "pass", down: 3, ydstogo: 5, yards_gained: 0, epa: 0, first_down: false }, "h", null), ...over });
  const plays = [
    mk({ id: "a", play_type: "pass", is_snap: true, is_dropback: true, epa: 1.2, success: true, converted: true, yards_gained: 25, explosive: true, turnover: false }),
    mk({ id: "b", play_type: "run", is_snap: true, is_dropback: false, epa: -0.4, success: false, converted: false, yards_gained: 2, explosive: false, turnover: false }),
    mk({ id: "c", play_type: "pass", is_snap: true, is_dropback: true, epa: -2.0, success: false, converted: false, yards_gained: 0, explosive: false, turnover: true }),
    mk({ id: "d", play_type: "run", is_snap: true, is_dropback: false, epa: null, success: null, converted: true, yards_gained: 12, explosive: true, turnover: false }),
  ];
  const m = computeMetrics(plays);
  assert.equal(m.attempts, 4);
  assert.equal(m.conversions, 2);
  assert.equal(m.conversion_rate, 0.5);
  assert.equal(m.pass_rate, 0.5);
  assert.equal(m.epa_n, 3);
  assert.equal(Math.round(m.epa_per_play! * 1000) / 1000, -0.4);
  assert.equal(m.success_rate, 1 / 3);
  assert.equal(m.yards_per_play, 39 / 4);
  assert.equal(m.explosive_rate, 0.5);
  assert.equal(m.turnover_rate, 0.25);
  const empty = computeMetrics([]);
  assert.equal(empty.conversion_rate, null);
  assert.equal(empty.epa_per_play, null);
  assert.equal(empty.confidence, "insufficient");
});

test("sample-size ladder and helpers", () => {
  assert.equal(confidenceFor(0), "insufficient");
  assert.equal(confidenceFor(9), "insufficient");
  assert.equal(confidenceFor(10), "low");
  assert.equal(confidenceFor(24), "low");
  assert.equal(confidenceFor(25), "moderate");
  assert.equal(confidenceFor(59), "moderate");
  assert.equal(confidenceFor(60), "strong");
  assert.equal(ppDelta(0.6, 0.5)!.toFixed(6), "10.000000");
  assert.equal(ppDelta(null, 0.5), null);
  assert.equal(distanceBucket(3), "short");
  assert.equal(distanceBucket(4), "medium");
  assert.equal(distanceBucket(10), "long");
  assert.equal(distanceBucket(11), "very_long");
  assert.equal(distanceBucket(null), null);
  assert.equal(fieldZone(20), "red_zone");
  assert.equal(fieldZone(21), "opp");
  assert.equal(fieldZone(51), "own");
  assert.equal(isGarbageTime(4, 17), true);
  assert.equal(isGarbageTime(4, 16), false);
  assert.equal(isGarbageTime(3, 25), true);
  assert.equal(isGarbageTime(2, 40), false);
  assert.equal(isGarbageTime(null, 40), null);
});

test("normalizer: never fabricates — missing fields stay null", () => {
  const p = normalizeNflDataPlay({ game_id: "g", play_id: 7 }, "h", null);
  assert.equal(p.down, null);
  assert.equal(p.epa, null);
  assert.equal(p.success, null);
  assert.equal(p.explosive, null);
  assert.equal(p.converted, null);
  assert.equal(p.garbage_time, null);
  assert.equal(p.posteam_is_home, null);
  assert.equal(p.is_snap, false);
  assert.deepEqual(p.derived_from, ["h"]);
  assert.equal(p.normalizer_version, "0.1.0");
  const raw = rawPlays().find((r) => r.play_id === 1087)!;
  const n = normalizeNflDataPlay(raw, "h", fixtureGame());
  assert.equal(n.is_dropback, true);
  assert.equal(n.success, false);
  assert.equal(n.posteam_is_home, true);
  assert.equal(n.div_game, true);
  assert.equal(n.distance_bucket, "long");
});

test("distance buckets partition the third-down sample", () => {
  const a = analyzeThirdDown(rows, thirdDownFilter({ team: "TB", game_id: FIXTURE_GAME_ID }), AT);
  const kept = rows.map((r) => r.data).filter((p) => a.evidence.includes(p.id));
  const g = groupByDistanceBucket(kept);
  assert.equal(g.short.length + g.medium.length + g.long.length + g.very_long.length, 15);
  assert.equal(g.short.length, 3);
  assert.equal(g.medium.length, 5);
  assert.equal(g.long.length, 6);
  assert.equal(g.very_long.length, 1);
});

test("tendency: situation vs baseline, baseline strips situational dimensions", () => {
  const f = validateFilter({ team: "TB", game_id: FIXTURE_GAME_ID, down: 3, distance_min: 4, distance_max: 6 }).filter!;
  const b = baselineFilter(f);
  assert.equal(b.down, undefined);
  assert.equal(b.distance_min, undefined);
  assert.equal(b.team, "TB");
  const t = analyzeTendency(rows, f, AT);
  assert.equal(t.metrics.attempts, 5);
  assert.ok(t.baseline_evidence_count > t.metrics.attempts);
  assert.equal(t.confidence, "insufficient");
  assert.ok(t.headline!.startsWith("Only 5 qualifying snaps"));
  assert.equal(t.deltas[0].metric, "pass_rate");
  assert.equal(t.deltas[0].unit, "pp");
  assert.ok(t.unsupported.length >= 3);
});

test("comparison: deterministic A/B with deltas in the right units", () => {
  const fa = validateFilter({ team: "TB", game_id: FIXTURE_GAME_ID, half: [1] }).filter!;
  const fb = validateFilter({ team: "TB", game_id: FIXTURE_GAME_ID, half: [2] }).filter!;
  const c = compare(rows, fa, fb, AT);
  assert.ok(c.a.metrics.attempts > 0 && c.b.metrics.attempts > 0);
  const att = c.lines.find((l) => l.metric === "attempts")!;
  assert.equal(att.delta, c.b.metrics.attempts - c.a.metrics.attempts);
  const pr = c.lines.find((l) => l.metric === "pass_rate")!;
  assert.equal(pr.unit, "pp");
  assert.equal(Math.round(pr.delta! * 1000), Math.round((c.b.metrics.pass_rate! - c.a.metrics.pass_rate!) * 100 * 1000));
  assert.ok(c.biggest_gap);
  const c2 = compare(rows, fa, fb, { seq: 5, head: "z" });
  assert.equal(c2.id, c.id);
});

test("situation scan: buckets need min sample; ranking is by EPA shortfall", () => {
  const f = validateFilter({ team: "TB", game_id: FIXTURE_GAME_ID }).filter!;
  const s = scanSituations(rows, f, AT);
  assert.ok(s.buckets.length >= 25);
  for (const b of s.buckets) assert.equal(b.qualifies, b.metrics.attempts >= SCAN_MIN_SAMPLE);
  for (let i = 1; i < s.weakest.length; i++) assert.ok(s.weakest[i - 1].epa_delta_vs_team! <= s.weakest[i].epa_delta_vs_team!);
  assert.ok(s.weakest.every((b) => b.qualifies));
  const total = s.buckets.find((b) => b.key === "pass_snaps")!.metrics.attempts + s.buckets.find((b) => b.key === "run_snaps")!.metrics.attempts;
  assert.equal(total, s.baseline.attempts);
});

test("deviation: one-game fixture has no baseline -> insufficient, never a claim", () => {
  const f = validateFilter({ team: "TB", season: 2025 }).filter!;
  const d = analyzeDeviation(rows, f, FIXTURE_GAME_ID, AT);
  assert.equal(d.level, "insufficient");
  assert.ok(d.headline.includes("not enough"));
  assert.equal(d.baseline.attempts, 0);
});

test("deviation: synthetic season with a shifted game flags HIGH on the driver", () => {
  const base = rows.map((r) => r.data).filter((p) => p.posteam === "TB" && p.is_snap);
  // Build a 10-game "season" of the same TB snaps, then one game where every snap is a pass.
  const season: typeof rows = [];
  for (let g = 0; g < 10; g++) {
    for (const p of base) season.push({ _id: `${p.id}-g${g}`, _hash: `h${g}${p.play_id}`, _seq: 0, _coll: "football_plays", data: { ...p, id: `${p.id}-g${g}`, game_id: `2025_0${g}_TB_XX`.replace("_TB_XX", "_XX_TB"), season: 2025 } });
  }
  const shifted = base.map((p) => ({ _id: `${p.id}-s`, _hash: `hs${p.play_id}`, _seq: 0, _coll: "football_plays", data: { ...p, id: `${p.id}-s`, game_id: "2025_11_ZZ_TB", season: 2025, play_type: "pass", is_dropback: true } }));
  const f = validateFilter({ team: "TB", season: 2025 }).filter!;
  const d = analyzeDeviation([...season, ...shifted], f, "2025_11_ZZ_TB", AT);
  assert.equal(d.driver, "pass_rate");
  assert.equal(d.level, "HIGH");
  assert.equal(d.game.pass_rate, 1);
  assert.ok(d.headline.startsWith("CURRENT GAME DEVIATION: HIGH"));
});
