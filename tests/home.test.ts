import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fixtureRows, AT, FIXTURE_GAME_ID } from "./fixture.ts";
import { normalizeContext, parsePersonnel, type PlayContext } from "../src/ingest/context.ts";
import { contextPatterns, patternStatements, summarizePatterns } from "../src/engine/context.ts";
import { thirdDownTrend, recentForm } from "../src/engine/trend.ts";
import { evaluateBadges, BADGE_DEFINITIONS } from "../src/rating/badges.ts";
import { opponentReport, summarizeOpponentReport } from "../src/engine/opponent.ts";
import { THIRD_DOWN_DEFAULT_V1 } from "../src/rating/definitions.ts";
import { validateFilter } from "../src/engine/situation.ts";
import { computeMetrics } from "../src/engine/metrics.ts";
import { validatePlan, rulePlan } from "../src/llm/planner.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const rows = fixtureRows();
const participation: Record<string, unknown>[] = JSON.parse(readFileSync(path.join(here, "fixtures/participation_2025_18_CAR_TB.json"), "utf8")).data;
const charting: Record<string, unknown>[] = JSON.parse(readFileSync(path.join(here, "fixtures/charting_2025_18_CAR_TB.json"), "utf8")).data;

function fixtureContext(): Map<string, PlayContext> {
  const byPlay = new Map<number, { p?: Record<string, unknown>; c?: Record<string, unknown> }>();
  for (const p of participation) { const id = Number(p.play_id); byPlay.set(id, { ...(byPlay.get(id) ?? {}), p }); }
  for (const c of charting) { const id = Number(c.play_id); byPlay.set(id, { ...(byPlay.get(id) ?? {}), c }); }
  const m = new Map<string, PlayContext>();
  for (const [id, s] of byPlay) {
    const ctx = normalizeContext(FIXTURE_GAME_ID, id, s.p ?? null, s.c ?? null, [s.p ? "ph" : "", s.c ? "ch" : ""].filter(Boolean), "2026-09-03T00:00:00Z");
    m.set(ctx.id, ctx);
  }
  return m;
}

test("personnel parsing: offensive groupings only, RB/TE/WR counted, FB is a back", () => {
  assert.deepEqual(parsePersonnel("1 RB, 1 TE, 3 WR"), { backs: 1, tight_ends: 1, receivers: 3, group: "11" });
  assert.deepEqual(parsePersonnel("2 C, 1 G, 1 QB, 1 RB, 2 T, 2 TE, 1 WR")?.group, "12");
  assert.deepEqual(parsePersonnel("1 FB, 1 RB, 1 TE, 2 WR")?.group, "21");
  assert.equal(parsePersonnel("1 CB, 1 FS, 1 ILB, 1 MLB, 2 OLB, 1 RB, 1 SS, 2 TE, 1 WR")?.group, "12"); // has RB/TE/WR -> offensive grouping still parsed
  assert.equal(parsePersonnel("1 CB, 2 DE, 3 LB"), null);
  assert.equal(parsePersonnel(null), null);
});

test("context normalizer joins participation + charting per play with lineage; never invents", () => {
  const ctx = fixtureContext();
  assert.ok(ctx.size >= 150, `context rows ${ctx.size}`);
  const c = ctx.get(`${FIXTURE_GAME_ID}:62`)!;
  assert.equal(c.formation, "UNDER CENTER");
  assert.equal(c.qb_location, "U");
  assert.equal(c.under_center, true);
  assert.equal(c.shotgun, false);
  assert.equal(c.motion, true);
  assert.deepEqual(c.sources, ["participation", "charting"]);
  assert.deepEqual(c.derived_from, ["ph", "ch"]);
  const only = normalizeContext("g", 1, null, { qb_location: "S", is_motion: false }, ["ch"]);
  assert.equal(only.shotgun, true);
  assert.equal(only.formation, null);
  assert.equal(only.was_pressure, null);
  assert.equal(only.personnel_group, null);
  const none = normalizeContext("g", 2, null, null, []);
  assert.equal(none.shotgun, null);
});

test("context patterns over the real game: shotgun %, pass-from-shotgun, personnel shares, coverage", () => {
  const ctx = fixtureContext();
  const tb = rows.map((r) => r.data).filter((p) => p.posteam === "TB" && p.is_snap);
  const c = contextPatterns(tb, ctx);
  assert.ok(c.covered > 0.8 * tb.length, `coverage ${c.covered}/${tb.length}`);
  assert.ok(c.shotgun_rate !== null && c.shotgun_rate > 0 && c.shotgun_rate < 1);
  assert.ok(c.pass_rate_from_shotgun !== null);
  assert.ok(c.personnel.length >= 2);
  assert.equal(Math.round(c.personnel.reduce((s, p) => s + p.share, 0) * 1000) / 1000, 1);
  assert.equal(c.personnel[0].n, Math.max(...c.personnel.map((p) => p.n)));
  assert.ok(c.motion_rate !== null);
  const s = summarizePatterns(c);
  assert.ok(typeof s.shotgun_pct === "number");
  const st = patternStatements("TB", "all snaps", c);
  assert.ok(st[0].includes("shotgun"));
  const tiny = patternStatements("TB", "x", contextPatterns(tb.slice(0, 3), ctx));
  assert.ok(tiny[0].includes("only 3"));
});

test("trend: as-known-then points, one per week, provisional flags honor min_sample", () => {
  // Build a fake 4-week league from the fixture's third downs by relabeling weeks.
  const third = rows.filter((r) => r.data.down === 3);
  const league: typeof rows = [];
  for (let w = 1; w <= 4; w++) for (const r of third) league.push({ ...r, _id: `${r._id}-w${w}`, data: { ...r.data, id: `${r.data.id}-w${w}`, week: w, game_id: `2025_0${w}_CAR_TB`, season: 2025 } });
  const t = thirdDownTrend(league, "TB", 2025, THIRD_DOWN_DEFAULT_V1, AT);
  assert.equal(t.points.length, 4);
  assert.deepEqual(t.points.map((p) => p.week), [1, 2, 3, 4]);
  assert.deepEqual(t.points.map((p) => p.attempts), [15, 30, 45, 60]);
  assert.equal(t.points[0].provisional, true); // 15 < 25
  assert.equal(t.points[1].provisional, false);
  assert.equal(t.points[3].games, 4);
  assert.ok(t.points.every((p) => p.population === 2));
  assert.ok(t.headline.includes("Third Down Rating"));
  // Same relative performance every week -> identical score, no change.
  assert.equal(t.points[1].score, t.points[3].score);
  assert.equal(t.score_change, 0);
});

test("recent form: last K games vs season, deltas in the right units", () => {
  const plays = rows.map((r) => r.data).map((p, i) => ({ ...p, game_id: i % 2 ? "2025_02_A_TB" : "2025_01_TB_B", week: i % 2 ? 2 : 1, season: 2025 }));
  const f = validateFilter({ team: "TB", season: 2025 }).filter!;
  const rf = recentForm(plays, f, 1);
  assert.deepEqual(rf.last_games, ["2025_02_A_TB"]);
  assert.ok(rf.recent.attempts > 0 && rf.recent.attempts < rf.season_metrics.attempts);
  assert.equal(rf.deltas[0].unit, "epa");
  assert.equal(rf.deltas[1].unit, "pp");
  assert.ok(rf.headline.startsWith("Last 1 games"));
});

test("badges: deterministic, league-relative, min-sample and min-population protected", () => {
  const mk = (key: string, conv: number, epa: number, expl: number, to: number, succ: number, n3 = 100, nAll = 500) => ({
    key,
    third_down: { ...computeMetrics([]), attempts: n3, conversion_rate: conv, epa_per_play: epa },
    all_snaps: { ...computeMetrics([]), attempts: nAll, explosive_rate: expl, turnover_rate: to, success_rate: succ },
  });
  const pop = Array.from({ length: 12 }, (_, i) => mk(`T${i}`, 0.3 + i * 0.02, -0.2 + i * 0.04, 0.05 + i * 0.01, 0.05 - i * 0.003, 0.35 + i * 0.01));
  const best = evaluateBadges("T11", pop);
  const ids = best.map((b) => b.id);
  assert.ok(ids.includes("third_down_monster"));
  assert.ok(ids.includes("explosive_offense"));
  assert.ok(ids.includes("ball_security"));
  assert.ok(!ids.includes("third_down_problem"));
  const worst = evaluateBadges("T0", pop);
  assert.ok(worst.map((b) => b.id).includes("third_down_problem"));
  assert.ok(worst.map((b) => b.id).includes("giveaway_machine"));
  for (const b of best) { assert.equal(b.of, 12); assert.ok(b.qualification_rule.includes("percentile")); }
  // Every team in a 12-team league earns something: two identity badges at minimum.
  for (let i = 0; i < 12; i++) {
    const e = evaluateBadges(`T${i}`, pop);
    assert.ok(e.length >= 2, `T${i} earned ${e.length}`);
    assert.equal(e.filter((b) => b.kind === "signature").length, 1, `T${i} signature`);
    assert.equal(e.filter((b) => b.kind === "heel").length, 1, `T${i} heel`);
    assert.notEqual(e.find((b) => b.kind === "signature")!.metric, e.find((b) => b.kind === "heel")!.metric);
    // One tier badge per metric+side: never both THIRD DOWN MONSTER and CONVERTS.
    const keys = e.filter((b) => b.kind === "tier").map((b) => `${b.metric}:${b.tone}`);
    assert.equal(new Set(keys).size, keys.length, `T${i} duplicate tier badges: ${keys.join(",")}`);
  }
  assert.ok(!ids.includes("converts")); // T11 is elite on third down -> tier-1 only
  // Percentiles are "higher is better" everywhere: BALL SECURITY (lowest turnover rate) reads high, GIVEAWAY MACHINE reads low.
  assert.ok(best.find((b) => b.id === "ball_security")!.percentile! >= 90);
  assert.ok(worst.find((b) => b.id === "giveaway_machine")!.percentile! <= 10);
  const mid = evaluateBadges("T5", pop);
  assert.ok(mid.some((b) => b.kind === "signature") && mid.some((b) => b.kind === "heel"));
  // Small sample -> no third-down badges even if elite.
  const small = [...pop.slice(0, 11), { ...mk("T11", 0.9, 1, 0.5, 0, 0.9, 20, 100) }];
  assert.equal(evaluateBadges("T11", small).length, 0);
  // Tiny league -> nothing.
  assert.equal(evaluateBadges("T3", pop.slice(0, 4)).length, 0);
  assert.equal(evaluateBadges("NOPE", pop).length, 0);
  assert.ok(BADGE_DEFINITIONS.every((d) => /^\d+\.\d+\.\d+$/.test(d.version)));
});

test("opponent report: composes sections, scan, and context statements deterministically", () => {
  const ctx = fixtureContext();
  const base = validateFilter({ team: "CAR", game_id: FIXTURE_GAME_ID }).filter!;
  const r = opponentReport("TB", rows, base, ctx, AT);
  assert.equal(r.opponent, "CAR");
  assert.equal(r.sections.length, 6);
  assert.ok(r.baseline.attempts > 30);
  assert.ok(r.baseline_patterns && r.baseline_patterns.covered > 0);
  assert.ok(r.statements.length >= 5);
  assert.ok(r.statements[0].startsWith("CAR offense"));
  // Small single-game sections say so instead of claiming a tendency.
  const tooFew = r.sections.filter((s) => s.metrics.attempts < 20);
  assert.ok(tooFew.every((s) => s.statements[0].includes("too few")));
  const s = summarizeOpponentReport(r);
  assert.equal(s.sections.length, 6);
  assert.ok(s.baseline_patterns);
  const r2 = opponentReport("TB", rows, base, ctx, AT);
  assert.equal(r2.id, r.id);
  const noCtx = opponentReport("TB", rows, base, new Map(), AT);
  assert.equal(noCtx.baseline_patterns, null);
  assert.ok(noCtx.statements.some((x) => x.includes("not ingested")));
  // Defense framing: the plays are offenses FACING the opponent.
  const dbase = validateFilter({ team: "CAR", game_id: FIXTURE_GAME_ID, side: "defense" }).filter!;
  const d = opponentReport("TB", rows, dbase, ctx, AT);
  assert.ok(d.statements[0].startsWith("CAR defense"), d.statements[0]);
  assert.ok(d.statements[0].includes("allowing"));
  assert.ok(d.statements.some((x) => x.startsWith("Offenses facing CAR")), d.statements.join(" | "));
  assert.ok(!d.statements.some((x) => /^CAR in shotgun/.test(x)));
});

test("planner: opponent_report validates and the rule planner routes scouting questions", () => {
  const ctx = { default_team: "TB", default_season: 2025, teams: ["TB", "CAR", "ATL", "NO"], next_opponent: "ATL" };
  const v = validatePlan({ intent: "opponent_report", filters: { opponent: "car" } }, ctx);
  assert.ok(v.ok, v.errors.join(";"));
  assert.equal(v.plan!.filter!.team, "CAR");
  assert.equal(v.plan!.filter!.side, "offense");
  assert.equal(validatePlan({ intent: "opponent_report", filters: {} }, ctx).ok, false);
  assert.equal(validatePlan({ intent: "opponent_report", filters: { opponent: "ZZZ" } }, ctx).ok, false);
  const p1 = rulePlan("What should I know about this week's opponent?", ctx)!;
  assert.equal(p1.intent, "opponent_report");
  assert.equal(p1.filters.opponent, "ATL");
  const p2 = rulePlan("Scout the Panthers for me", ctx)!;
  assert.equal(p2.intent, "opponent_report");
  assert.equal(p2.filters.opponent, "CAR");
  const p3 = rulePlan("What does the Saints defense do on third down", { ...ctx, next_opponent: undefined });
  assert.ok(p3 === null || p3.intent !== "opponent_report" || p3.filters.opponent === "NO");
});
