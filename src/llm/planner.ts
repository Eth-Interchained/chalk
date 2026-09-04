/**
 * Planner — question -> validated QueryPlan.
 *
 * The model proposes a plan inside a <<<PLAN>>> block. We parse the LAST
 * closed block, validate the intent, validate every filter through the
 * situation engine, and reject anything else with a precise reason. If the
 * model is unavailable, a deterministic rule-based planner covers the common
 * question shapes so the product never degrades to "LLM down, nothing works".
 *
 * Every attempt is logged as a football_model_events row (spec §39).
 */
import { extractBlocks } from "sentinel-blocks";
import { COLL } from "../store/collections.ts";
import { deterministicId } from "../store/hash.ts";
import type { ChalkStore } from "../store/nedb.ts";
import { validateFilter, type SituationFilter } from "../engine/situation.ts";
import { complete, LlmError, type LlmConfig } from "./client.ts";
import { PLANNER_SYSTEM, PLANNER_USER_SUFFIX, PROMPT_VERSION } from "./prompts.ts";

export type Intent =
  | "third_down"
  | "tendency"
  | "comparison"
  | "situation_scan"
  | "game_summary"
  | "play_explain"
  | "rating"
  | "rating_compare"
  | "unsupported";

export const INTENTS: readonly Intent[] = [
  "third_down", "tendency", "comparison", "situation_scan", "game_summary", "play_explain", "rating", "rating_compare", "unsupported",
];

export interface QueryPlan {
  id: string;
  intent: Intent;
  filters: Record<string, unknown>;
  /** Validated situation filter for single-filter intents. */
  filter?: SituationFilter;
  /** Validated A/B for comparison. */
  a?: SituationFilter;
  b?: SituationFilter;
  metrics: string[];
  notes: string | null;
  reason?: string;
  source: "model" | "rules";
  model?: string;
  prompt_version: string;
  raw?: string;
  latency_ms: number;
}

export interface PlanContext {
  default_team: string;
  default_season: number;
  game_id?: string;
  play_id?: string;
  /** Known team abbreviations for validation. */
  teams: string[];
}

export interface PlanOutcome {
  ok: boolean;
  plan?: QueryPlan;
  errors: string[];
  fallback_used: boolean;
  model_event_id?: string;
}

export async function planQuestion(
  question: string,
  ctx: PlanContext,
  cfg: LlmConfig | null,
  store: ChalkStore | null,
  log: (l: string) => void = () => {},
): Promise<PlanOutcome> {
  const started = Date.now();
  let raw = "";
  let modelErr: string | null = null;
  let proposed: unknown = null;
  let model = cfg?.model ?? "rules";

  if (cfg && cfg.key) {
    try {
      const res = await complete(cfg, [
        { role: "system", content: PLANNER_SYSTEM },
        { role: "user", content: `CONTEXT: ${JSON.stringify({ default_team: ctx.default_team, default_season: ctx.default_season, game_id: ctx.game_id ?? null, play_id: ctx.play_id ?? null })}\n\nQUESTION: ${question}${PLANNER_USER_SUFFIX}` },
      ], { maxTokens: 600, temperature: 0 });
      raw = res.content;
      model = res.model;
      if (res.finish_reason === "length") {
        modelErr = "planner output truncated (finish_reason=length) — cannot have closed a block";
      } else {
        const blocks = extractBlocks(raw, "PLAN");
        const last = blocks[blocks.length - 1];
        if (!last) modelErr = `planner returned no closed <<<PLAN>>> block (${raw.length} chars)`;
        else {
          try {
            proposed = JSON.parse(last.trim());
          } catch (e) {
            modelErr = `planner block is not JSON: ${(e as Error).message}`;
          }
        }
      }
    } catch (e) {
      modelErr = e instanceof LlmError ? e.message : `planner call failed: ${(e as Error).message}`;
    }
  } else {
    modelErr = cfg ? "no LLM key configured (CHALK_LLM_KEY / AIASSIST_API_KEY)" : "LLM disabled";
  }

  let outcome: PlanOutcome;
  if (proposed) {
    const v = validatePlan(proposed, ctx);
    if (v.ok) {
      outcome = { ok: true, plan: { ...v.plan!, source: "model", model, raw, latency_ms: Date.now() - started }, errors: [], fallback_used: false };
    } else {
      log(`planner: model plan rejected: ${v.errors.join("; ")} — falling back to rules`);
      const rb = rulePlan(question, ctx);
      outcome = rb
        ? { ok: true, plan: { ...rb, latency_ms: Date.now() - started }, errors: v.errors, fallback_used: true }
        : { ok: false, errors: v.errors, fallback_used: true };
    }
  } else {
    log(`planner: ${modelErr} — using rules`);
    const rb = rulePlan(question, ctx);
    outcome = rb
      ? { ok: true, plan: { ...rb, latency_ms: Date.now() - started }, errors: modelErr ? [modelErr] : [], fallback_used: true }
      : { ok: false, errors: [modelErr ?? "no plan", "rule planner could not interpret the question"], fallback_used: true };
  }

  if (store) {
    const id = deterministicId("mev", { kind: "plan", question, ctx, started });
    try {
      const row = await store.put(COLL.model_events, id, {
        kind: "plan",
        question,
        context: ctx,
        model,
        prompt_version: PROMPT_VERSION,
        ok: outcome.ok,
        fallback_used: outcome.fallback_used,
        intent: outcome.plan?.intent ?? null,
        plan: outcome.plan ? { intent: outcome.plan.intent, filters: outcome.plan.filters, metrics: outcome.plan.metrics } : null,
        errors: outcome.errors,
        raw_output: raw.slice(0, 4000),
        latency_ms: Date.now() - started,
        created_at: new Date().toISOString(),
      }, { evidence: `planner@${PROMPT_VERSION}` });
      outcome.model_event_id = row._id;
    } catch (e) {
      log(`planner: failed to record model event: ${(e as Error).message}`);
    }
  }
  return outcome;
}

export function validatePlan(input: unknown, ctx: PlanContext): { ok: boolean; plan?: Omit<QueryPlan, "source" | "latency_ms">; errors: string[] } {
  const errors: string[] = [];
  if (!input || typeof input !== "object") return { ok: false, errors: ["plan must be an object"] };
  const o = input as Record<string, unknown>;
  const intent = o.intent as Intent;
  if (!INTENTS.includes(intent)) return { ok: false, errors: [`intent: unknown ${JSON.stringify(o.intent)}`] };
  const filters = (o.filters && typeof o.filters === "object" ? o.filters : {}) as Record<string, unknown>;
  const metrics = Array.isArray(o.metrics) ? o.metrics.filter((m): m is string => typeof m === "string") : [];
  const notes = typeof o.notes === "string" ? o.notes.slice(0, 300) : null;
  const base: Omit<QueryPlan, "source" | "latency_ms"> = {
    id: deterministicId("plan", { intent, filters }),
    intent,
    filters,
    metrics,
    notes,
    prompt_version: PROMPT_VERSION,
  };

  const withDefaults = (f: Record<string, unknown>): Record<string, unknown> => {
    const out = { ...f };
    if (out.team === undefined) out.team = ctx.default_team;
    if (out.season === undefined && !out.game_id && !out.game_ids) out.season = ctx.default_season;
    if (typeof out.team === "string") {
      out.team = out.team.toUpperCase();
      if (ctx.teams.length && !ctx.teams.includes(out.team as string)) errors.push(`team: ${out.team} is not a known team`);
    }
    return out;
  };

  switch (intent) {
    case "third_down":
    case "tendency":
    case "situation_scan":
    case "rating": {
      const f = withDefaults(filters);
      if (intent === "third_down") f.down = [3];
      const v = validateFilter(f);
      if (!v.ok) errors.push(...v.errors.map((e) => `filters.${e}`));
      if (v.unknown_keys.length && intent !== "rating") {
        const allowedExtra = new Set(["definition_id"]);
        const bad = v.unknown_keys.filter((k) => !allowedExtra.has(k));
        if (bad.length) errors.push(`filters: unknown keys ${bad.join(", ")}`);
      }
      if (errors.length) return { ok: false, errors };
      return { ok: true, plan: { ...base, filters: f, filter: v.filter }, errors: [] };
    }
    case "comparison": {
      const a = withDefaults((o.a ?? filters.a ?? {}) as Record<string, unknown>);
      const b = withDefaults((o.b ?? filters.b ?? {}) as Record<string, unknown>);
      const va = validateFilter(a);
      const vb = validateFilter(b);
      if (!va.ok) errors.push(...va.errors.map((e) => `a.${e}`));
      if (!vb.ok) errors.push(...vb.errors.map((e) => `b.${e}`));
      if (errors.length) return { ok: false, errors };
      return { ok: true, plan: { ...base, filters: { a, b }, a: va.filter, b: vb.filter }, errors: [] };
    }
    case "rating_compare": {
      const f = withDefaults(filters);
      if (typeof f.a !== "string" || typeof f.b !== "string") errors.push("filters.a and filters.b must be rating definition ids");
      const v = validateFilter({ team: f.team, season: f.season });
      if (!v.ok) errors.push(...v.errors);
      if (errors.length) return { ok: false, errors };
      return { ok: true, plan: { ...base, filters: f, filter: v.filter }, errors: [] };
    }
    case "game_summary": {
      const game_id = typeof filters.game_id === "string" ? filters.game_id : ctx.game_id;
      if (!game_id) return { ok: false, errors: ["game_summary needs game_id"] };
      const team = typeof filters.team === "string" ? filters.team.toUpperCase() : ctx.default_team;
      return { ok: true, plan: { ...base, filters: { game_id, team } }, errors: [] };
    }
    case "play_explain": {
      const play_id = typeof filters.play_id === "string" ? filters.play_id : ctx.play_id;
      if (!play_id || !/^\d{4}_\d{2}_[A-Z]{2,3}_[A-Z]{2,3}:\d+$/.test(play_id)) return { ok: false, errors: ["play_explain needs play_id GAME_ID:PLAY_ID"] };
      return { ok: true, plan: { ...base, filters: { play_id } }, errors: [] };
    }
    case "unsupported": {
      const reason = typeof o.reason === "string" ? o.reason : typeof filters.reason === "string" ? (filters.reason as string) : "CHALK does not have the data to answer this";
      return { ok: true, plan: { ...base, reason }, errors: [] };
    }
  }
  return { ok: false, errors: ["unreachable"] };
}

// -------------------------------------------------------------- rule planner

const TEAM_WORDS: Record<string, string> = {
  tampa: "TB", bucs: "TB", buccaneers: "TB", "tampa bay": "TB",
  falcons: "ATL", atlanta: "ATL", saints: "NO", "new orleans": "NO", panthers: "CAR", carolina: "CAR",
  chiefs: "KC", "kansas city": "KC", eagles: "PHI", philadelphia: "PHI", cowboys: "DAL", dallas: "DAL",
  lions: "DET", detroit: "DET", packers: "GB", "green bay": "GB", bills: "BUF", buffalo: "BUF",
  ravens: "BAL", baltimore: "BAL", niners: "SF", "49ers": "SF", "san francisco": "SF", rams: "LA", chargers: "LAC",
  seahawks: "SEA", seattle: "SEA", vikings: "MIN", minnesota: "MIN", bears: "CHI", chicago: "CHI",
  commanders: "WAS", washington: "WAS", giants: "NYG", jets: "NYJ", patriots: "NE", "new england": "NE",
  dolphins: "MIA", miami: "MIA", steelers: "PIT", pittsburgh: "PIT", browns: "CLE", cleveland: "CLE",
  bengals: "CIN", cincinnati: "CIN", texans: "HOU", houston: "HOU", colts: "IND", indianapolis: "IND",
  jaguars: "JAX", jacksonville: "JAX", titans: "TEN", tennessee: "TEN", broncos: "DEN", denver: "DEN",
  raiders: "LV", "las vegas": "LV", cardinals: "ARI", arizona: "ARI",
};

export function resolveTeam(text: string, teams: string[]): string | null {
  const lower = text.toLowerCase();
  // Longest phrase first so "tampa bay" beats "tampa".
  for (const k of Object.keys(TEAM_WORDS).sort((a, b) => b.length - a.length)) {
    if (lower.includes(k)) return TEAM_WORDS[k];
  }
  const abbr = text.match(/\b([A-Z]{2,3})\b/g) ?? [];
  for (const a of abbr) if (teams.includes(a)) return a;
  return null;
}

export function rulePlan(question: string, ctx: PlanContext): Omit<QueryPlan, "latency_ms"> | null {
  const q = question.toLowerCase();
  const team = resolveTeam(question, ctx.teams) ?? ctx.default_team;
  const seasonMatch = question.match(/\b(20\d{2})\b/);
  const season = seasonMatch ? Number(seasonMatch[1]) : ctx.default_season;
  const gameId = question.match(/\b(\d{4}_\d{2}_[A-Z]{2,3}_[A-Z]{2,3})\b/)?.[1] ?? ctx.game_id;
  const playId = question.match(/\b(\d{4}_\d{2}_[A-Z]{2,3}_[A-Z]{2,3}:\d+)\b/)?.[1] ?? ctx.play_id;
  const side: "offense" | "defense" = /\bdefen[cs]e|defensive|stop(ping)?\b/.test(q) && !/\boffen[cs]e|offensive\b/.test(q) ? "defense" : "offense";
  const scope: Record<string, unknown> = gameId ? { game_id: gameId } : { season };
  const garbage = /garbage/.test(q);
  const mk = (intent: Intent, filters: Record<string, unknown>, extra: Partial<QueryPlan> = {}): Omit<QueryPlan, "latency_ms"> => {
    const v = validatePlan({ intent, filters, metrics: [], notes: "rule planner" }, ctx);
    if (!v.ok || !v.plan) throw new Error(`rulePlan produced invalid plan: ${v.errors.join("; ")}`);
    return { ...v.plan, ...extra, source: "rules", model: "rules", prompt_version: PROMPT_VERSION };
  };

  if (playId && /\bplay\b|what happened|explain/.test(q)) return mk("play_explain", { play_id: playId });
  if (/why .*(disagree|different)|rating.*(vs|versus|compare)|compare.*rating/.test(q)) return null; // needs explicit ids — UI path
  if (/\brating|rated|grade|score out of\b/.test(q) && /third|3rd/.test(q)) return mk("rating", { team, season });
  if (/\b(compare|vs\.?|versus|than last (season|year)|this (season|year) (vs|versus|against|to) last)\b/.test(q)) {
    if (/last (season|year)|this (season|year)/.test(q)) {
      return mk("comparison", { a: { team, season: season - 1, side }, b: { team, season, side } });
    }
    if (/first half|second half|1st half|2nd half/.test(q)) {
      return mk("comparison", { a: { team, ...scope, side, half: [1] }, b: { team, ...scope, side, half: [2] } });
    }
    if (/home|away|road/.test(q)) {
      return mk("comparison", { a: { team, ...scope, side, home: true }, b: { team, ...scope, side, home: false } });
    }
    if (/leading|trailing|behind|ahead/.test(q)) {
      return mk("comparison", { a: { team, ...scope, side, score_state: ["leading"] }, b: { team, ...scope, side, score_state: ["trailing"] } });
    }
  }
  if (/third|3rd/.test(q)) {
    const long = /long|7\+|seven/.test(q);
    const short = /short|1-3|and (1|2|3)\b|&\s?(1|2|3)\b/.test(q);
    const medium = /medium|4-6|4 to 6|4 through 6|four through six/.test(q);
    if (/tend|how often|pass rate|run rate|what do they do|throw|run the ball/.test(q) || long || short || medium) {
      const f: Record<string, unknown> = { team, ...scope, side, down: [3], exclude_garbage_time: garbage };
      if (long) f.distance_min = 7;
      if (short) f.distance_max = 3;
      if (medium) { f.distance_min = 4; f.distance_max = 6; }
      return mk("tendency", f);
    }
    return mk("third_down", { team, ...scope, side, exclude_garbage_time: garbage });
  }
  if (/hurt|struggl|weak|problem|worst|what.?s wrong|going wrong|why .*(lose|lost|losing)|biggest issue/.test(q)) {
    if (gameId && /why .*(lose|lost)/.test(q)) return mk("game_summary", { game_id: gameId, team });
    return mk("situation_scan", { team, ...scope, side });
  }
  if (/best|strength|good at|playing well|strong/.test(q)) return mk("situation_scan", { team, ...scope, side });
  if (gameId) return mk("game_summary", { game_id: gameId, team });
  if (/red zone|redzone|goal.?to.?go|when (leading|trailing)|one.?score|first down|second down|4th|fourth/.test(q)) {
    const f: Record<string, unknown> = { team, ...scope, side };
    if (/red zone|redzone/.test(q)) f.field_zone = ["red_zone"];
    if (/goal.?to.?go/.test(q)) f.goal_to_go = true;
    if (/when leading|ahead/.test(q)) f.score_state = ["leading"];
    if (/when trailing|behind/.test(q)) f.score_state = ["trailing"];
    if (/one.?score/.test(q)) f.neutral_only = true;
    if (/first down|1st down/.test(q)) f.down = [1];
    if (/second down|2nd down/.test(q)) f.down = [2];
    if (/4th|fourth/.test(q)) f.down = [4];
    return mk("tendency", f);
  }
  if (/how (good|bad)|overall|better|worse/.test(q)) return mk("situation_scan", { team, ...scope, side });
  return null;
}
