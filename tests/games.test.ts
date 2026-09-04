import { test } from "node:test";
import assert from "node:assert/strict";
import { fixtureRows, fixtureGame, AT, FIXTURE_GAME_ID } from "./fixture.ts";
import { rankGames, gameRankStatements, GAME_RANK_METRICS } from "../src/engine/games.ts";
import { rulePlan, validatePlan } from "../src/llm/planner.ts";

const ctx = { default_team: "TB", default_season: 2025, teams: ["TB", "CAR", "CIN", "KC"] };

test("rankGames: one fixture game -> one line, TB W 16-14, offense/defense snaps split, evidence = TB snaps", () => {
  const plays = fixtureRows().map((r) => r.data);
  const r = rankGames(plays, [fixtureGame()], "TB", 2025, "epa", AT);
  assert.equal(r.games.length, 1);
  const g = r.games[0];
  assert.equal(g.game_id, FIXTURE_GAME_ID);
  assert.equal(g.result, "W");
  assert.equal(g.team_score, 16); assert.equal(g.opp_score, 14); assert.equal(g.margin, 2);
  assert.equal(g.opponent, "CAR"); assert.equal(g.home, true);
  assert.ok(g.snaps > 40 && g.def_snaps > 40, `snaps ${g.snaps}/${g.def_snaps}`);
  assert.equal(g.evidence.length, g.snaps);
  assert.ok(g.evidence.every((id) => id.startsWith(FIXTURE_GAME_ID + ":")));
  assert.equal(r.best?.game_id, FIXTURE_GAME_ID);
  assert.equal(r.worst, null); // one game: no "worst"
  assert.deepEqual(r.evidence, g.evidence);
  const st = gameRankStatements(r);
  assert.match(st[0], /Best 2025 game by offensive EPA\/play: Week 18 vs CAR, W 16-14/);
  assert.match(st.at(-1)!, /1 games ranked \(1-0\)/);
  // CAR's view of the same game is a loss.
  const c = rankGames(plays, [fixtureGame()], "CAR", 2025, "margin", AT);
  assert.equal(c.games[0].result, "L"); assert.equal(c.games[0].margin, -2); assert.equal(c.games[0].home, false);
  // Deterministic id per metric and head.
  for (const m of GAME_RANK_METRICS) assert.equal(rankGames(plays, [fixtureGame()], "TB", 2025, m, AT).id, rankGames(plays, [fixtureGame()], "TB", 2025, m, AT).id);
});

test("planner: best/worst game questions route to game_rank with the right metric; validator accepts and defaults", () => {
  const q = (s: string) => rulePlan(s, ctx)!;
  assert.equal(q("tell me about the best game tampa had in 2025").intent, "game_rank");
  assert.equal(q("tell me about the best game tampa had in 2025").filters.metric, "epa");
  assert.equal(q("which game was their best game 2025 against which team").intent, "game_rank");
  assert.equal(q("what was the Bucs' worst game this year").intent, "game_rank");
  assert.equal(q("biggest win for Tampa").filters.metric, "margin");
  assert.equal(q("closest game Tampa played").filters.metric, "margin");
  assert.equal(q("best defensive game for the Chiefs").filters.metric, "defense");
  assert.equal(q("best defensive game for the Chiefs").filters.team, "KC");
  // Situation questions still scan; the word "game" is what routes to ranking.
  assert.equal(q("what is Tampa best at").intent, "situation_scan");
  assert.equal(q("what's hurting Tampa").intent, "situation_scan");
  const v = validatePlan({ intent: "game_rank", filters: { team: "tb" } }, ctx);
  assert.ok(v.ok, v.errors.join(";"));
  assert.deepEqual(v.plan!.filters, { team: "TB", season: 2025, metric: "epa" });
  assert.equal(validatePlan({ intent: "game_rank", filters: { team: "TB", metric: "vibes" } }, ctx).ok, false);
  assert.equal(validatePlan({ intent: "game_rank", filters: { team: "TB", side: "offense" } }, ctx).ok, false);
});
