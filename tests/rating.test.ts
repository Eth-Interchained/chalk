import { test } from "node:test";
import assert from "node:assert/strict";
import { percentileRank, percentile100 } from "../src/rating/normalize.ts";
import { computeRating, explainDisagreement, median, type PopulationMember } from "../src/rating/rating.ts";
import { THIRD_DOWN_DEFAULT_V1, THIRD_DOWN_EXPLOSIVE_V1, validateDefinition } from "../src/rating/definitions.ts";
import { computeMetrics } from "../src/engine/metrics.ts";
import { fixtureRows } from "./fixture.ts";

test("percentile rank: strict-below plus half ties, bounded, empty -> null", () => {
  assert.equal(percentileRank(5, [1, 2, 3, 4, 5]), 0.9);
  assert.equal(percentileRank(1, [1, 2, 3, 4, 5]), 0.1);
  assert.equal(percentileRank(3, [3, 3, 3]), 0.5);
  assert.equal(percentileRank(10, [1, 2, 3]), 1);
  assert.equal(percentileRank(0, [1, 2, 3]), 0);
  assert.equal(percentileRank(1, []), null);
  assert.equal(percentile100(5, [1, 2, 3, 4, 5]), 90);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([]), null);
});

function member(key: string, conversion_rate: number, epa_per_play: number, success_rate: number, extra: Partial<ReturnType<typeof computeMetrics>> = {}): PopulationMember {
  const m = { ...computeMetrics([]), attempts: 100, conversion_rate, epa_per_play, success_rate, explosive_rate: 0.1, turnover_rate: 0.02, ...extra };
  return { key, metrics: m, analysis_id: `a_${key}`, attempts: 100 };
}

const pop: PopulationMember[] = [
  member("A", 0.50, 0.20, 0.55),
  member("B", 0.45, 0.10, 0.50),
  member("C", 0.40, 0.00, 0.45),
  member("D", 0.35, -0.10, 0.40),
  member("E", 0.30, -0.20, 0.35),
];
const window = { season: 2025, description: "test" };

test("rating: best team scores 90, worst 10 under percentile rank; components add up", () => {
  const best = computeRating(THIRD_DOWN_DEFAULT_V1, pop[0], pop, window);
  assert.equal(best.score, 90);
  const worst = computeRating(THIRD_DOWN_DEFAULT_V1, pop[4], pop, window);
  assert.equal(worst.score, 10);
  const mid = computeRating(THIRD_DOWN_DEFAULT_V1, pop[2], pop, window);
  assert.equal(mid.score, 50);
  const sum = best.components.reduce((s, c) => s + (c.contribution ?? 0), 0);
  assert.equal(Math.round(sum * 1000) / 1000, Math.round(best.score_exact! * 1000) / 1000);
  assert.equal(best.components[0].rank, 1);
  assert.equal(worst.components[0].rank, 5);
  assert.equal(best.population.size, 5);
  assert.equal(best.normalization, "percentile_rank");
  assert.equal(best.provisional, false);
  assert.equal(best.reweighted, false);
  assert.ok(best.id.startsWith("rating_"));
});

test("rating: snapshot id is stable for the same inputs and changes with definition", () => {
  const s1 = computeRating(THIRD_DOWN_DEFAULT_V1, pop[1], pop, window, "t1");
  const s2 = computeRating(THIRD_DOWN_DEFAULT_V1, pop[1], pop, window, "t2");
  assert.equal(s1.id, s2.id);
  const s3 = computeRating(THIRD_DOWN_EXPLOSIVE_V1, pop[1], pop, window);
  assert.notEqual(s3.id, s1.id);
});

test("rating: lower_is_better metric inverts; missing metric reweights instead of zeroing", () => {
  const p2 = pop.map((m, i) => ({ ...m, metrics: { ...m.metrics, turnover_rate: [0.01, 0.02, 0.03, 0.04, 0.05][i] } }));
  const r = computeRating(THIRD_DOWN_EXPLOSIVE_V1, p2[0], p2, window);
  const to = r.components.find((c) => c.metric === "turnover_rate")!;
  assert.equal(to.normalized, 0.9); // lowest turnover rate -> best
  const noEpa = { ...p2[0], metrics: { ...p2[0].metrics, epa_per_play: null } };
  const r2 = computeRating(THIRD_DOWN_DEFAULT_V1, noEpa, p2, window);
  assert.equal(r2.reweighted, true);
  assert.equal(r2.components.find((c) => c.metric === "epa_per_play")!.contribution, null);
  assert.ok(r2.score !== null);
});

test("rating: provisional when sample below definition minimum", () => {
  const small = { ...pop[0], attempts: 10 };
  const r = computeRating(THIRD_DOWN_DEFAULT_V1, small, pop, window);
  assert.equal(r.provisional, true);
  assert.equal(r.sample_size, 10);
});

test("custom definition: validation normalizes weights, rejects unknown metrics, fills direction", () => {
  const v = validateDefinition({ name: "Dad Rating", components: [{ metric: "conversion_rate", weight: 30 }, { metric: "turnover_rate", weight: 25 }, { metric: "epa_per_play", weight: 20 }] });
  assert.ok(v.ok, v.errors.join(";"));
  const d = v.definition!;
  assert.equal(d.id, "custom_dad_rating@1.0.0");
  assert.equal(Math.round(d.components.reduce((s, c) => s + c.weight, 0) * 1e6) / 1e6, 1);
  assert.equal(d.components[0].weight, 0.4);
  assert.equal(d.components[1].direction, "lower_is_better");
  const bad = validateDefinition({ name: "x", components: [{ metric: "vibes", weight: 1 }] });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors[0].includes("unknown"));
  const dup = validateDefinition({ name: "x", components: [{ metric: "epa_per_play", weight: 1 }, { metric: "epa_per_play", weight: 1 }] });
  assert.equal(dup.ok, false);
  const neg = validateDefinition({ name: "x", components: [{ metric: "epa_per_play", weight: -1 }] });
  assert.equal(neg.ok, false);
  assert.equal(validateDefinition({ components: [] }).ok, false);
});

test("disagreement: deterministic per-component deltas explain the score gap", () => {
  const dad = validateDefinition({ name: "Dad Rating", components: [{ metric: "turnover_rate", weight: 50 }, { metric: "conversion_rate", weight: 50 }] }).definition!;
  const p2 = pop.map((m, i) => ({ ...m, metrics: { ...m.metrics, turnover_rate: [0.05, 0.01, 0.03, 0.04, 0.02][i] } }));
  const a = computeRating(THIRD_DOWN_DEFAULT_V1, p2[0], p2, window);
  const b = computeRating(dad, p2[0], p2, window);
  const d = explainDisagreement(a, b);
  assert.equal(d.subject_key, "A");
  assert.equal(Math.round((d.delta ?? 0) * 10) / 10, Math.round((b.score_exact! - a.score_exact!) * 10) / 10);
  const sumDelta = d.lines.reduce((s, l) => s + (l.delta ?? 0), 0);
  assert.equal(Math.round(sumDelta * 100) / 100, Math.round((b.score_exact! - a.score_exact!) * 100) / 100);
  assert.ok(d.lines[0].sentence.length > 20);
  assert.ok(d.headline.includes("Dad Rating"));
  // Team A has the WORST turnover rate; Dad's formula should score it lower.
  assert.ok(b.score! < a.score!);
  assert.throws(() => explainDisagreement(a, computeRating(dad, p2[1], p2, window)));
});

test("rating over the real fixture: two-team population, TB better on every component", async () => {
  const rows = fixtureRows();
  const { analyzeThirdDown, thirdDownFilter } = await import("../src/engine/thirddown.ts");
  const tb = analyzeThirdDown(rows, thirdDownFilter({ team: "TB", game_id: "2025_18_CAR_TB" }), { seq: 1, head: "h" });
  const car = analyzeThirdDown(rows, thirdDownFilter({ team: "CAR", game_id: "2025_18_CAR_TB" }), { seq: 1, head: "h" });
  const members: PopulationMember[] = [
    { key: "TB", metrics: tb.metrics, analysis_id: tb.id, attempts: tb.metrics.attempts },
    { key: "CAR", metrics: car.metrics, analysis_id: car.id, attempts: car.metrics.attempts },
  ];
  const r = computeRating(THIRD_DOWN_DEFAULT_V1, members[0], members, { game_id: "2025_18_CAR_TB", description: "one game" });
  assert.equal(r.score, 75); // better than CAR on every component: percentile 0.75 each
  assert.equal(r.provisional, true);
  assert.equal(r.sample_size, 15);
});
