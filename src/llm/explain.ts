/**
 * Explainer — evidence package -> streamed prose -> stored observation.
 *
 * The model receives a COMPACT structured evidence object (a few KB at most,
 * spec §30) and writes inside an <<<ANSWER>>> block. We stream deltas to the
 * client as they arrive, then extract the last closed block for the stored
 * observation. finish_reason=length is a hard reject for the stored answer
 * (a truncated stream cannot have closed a block) — the client still saw the
 * partial text, flagged as truncated.
 *
 * Observation record (spec §5): question, query_plan, model, prompt_version,
 * evidence_ids, calculation_ids, answer, created_at, latency — caused_by the
 * analysis/rating hashes so TRACE from an answer reaches the plays.
 */
import { extractBlocks } from "sentinel-blocks";
import { COLL } from "../store/collections.ts";
import { deterministicId } from "../store/hash.ts";
import type { Store, NedbRow } from "../store/nedb.ts";
import { stream, type LlmConfig, type StreamEvent } from "./client.ts";
import { EXPLAINER_SYSTEM, EXPLAINER_USER_SUFFIX, PROMPT_VERSION } from "./prompts.ts";
import type { QueryPlan } from "./planner.ts";

export interface EvidencePackage {
  /** Human-readable kind for the model: "third_down", "tendency", ... */
  kind: string;
  /** Compact, presentation-rounded summary. THE ONLY NUMBERS THE MODEL MAY USE. */
  summary: unknown;
  /** Ids of stored calculation records (analyses, ratings, comparisons). */
  calculation_ids: string[];
  /** NEDB hashes of those records — become caused_by on the observation. */
  calculation_hashes: string[];
  /** Play ids supporting the summary (not sent to the model in full). */
  evidence_ids: string[];
  /** Fields CHALK explicitly cannot see, so the model may say so. */
  unsupported?: string[];
  /** Deterministic sentences the engine already produced (headlines, disagreement lines). */
  deterministic_statements?: string[];
}

export interface ObservationRecord {
  id: string;
  question: string;
  intent: string;
  query_plan: { id: string; intent: string; filters: unknown; source: string };
  model: string;
  model_revision: string | null;
  prompt_version: string;
  evidence_ids: string[];
  evidence_count: number;
  calculation_ids: string[];
  answer: string | null;
  answer_truncated: boolean;
  raw_output: string;
  finish_reason: string | null;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  latency_ms: number;
  error: string | null;
  created_at: string;
}

export type ExplainEvent =
  | { type: "token"; text: string }
  | { type: "observation"; observation: ObservationRecord; hash: string | null }
  | { type: "error"; error: string };

export function buildMessages(question: string, pkg: EvidencePackage, ctx: { team: string; season: number }) {
  const evidence = {
    kind: pkg.kind,
    context: ctx,
    summary: pkg.summary,
    evidence_play_count: pkg.evidence_ids.length,
    unsupported: pkg.unsupported ?? [],
    deterministic_statements: pkg.deterministic_statements ?? [],
  };
  const user = `QUESTION: ${question}\n\nEVIDENCE (JSON, computed deterministically by CHALK):\n${JSON.stringify(evidence)}${EXPLAINER_USER_SUFFIX}`;
  return [
    { role: "system" as const, content: EXPLAINER_SYSTEM },
    { role: "user" as const, content: user },
  ];
}

/** Rough byte budget guard — the point of §30 is that this stays small. */
export function evidenceBytes(question: string, pkg: EvidencePackage, ctx: { team: string; season: number }): number {
  return Buffer.byteLength(buildMessages(question, pkg, ctx).map((m) => m.content).join("\n"), "utf8");
}

export async function* explain(
  cfg: LlmConfig,
  store: Store | null,
  question: string,
  plan: QueryPlan,
  pkg: EvidencePackage,
  ctx: { team: string; season: number },
  log: (l: string) => void = () => {},
): AsyncGenerator<ExplainEvent> {
  const started = Date.now();
  const messages = buildMessages(question, pkg, ctx);
  log(`explain: ${pkg.kind} evidence ${evidenceBytes(question, pkg, ctx)} bytes, ${pkg.evidence_ids.length} plays, model ${cfg.model}`);
  let raw = "";
  let finish: string | null = null;
  let usage: ObservationRecord["usage"];
  let error: string | null = null;
  // Stream deltas; strip the sentinel wrapper for the live view so the reader
  // never sees <<<ANSWER>>> tokens. We buffer a small tail to catch markers
  // split across deltas.
  let pending = "";
  let opened = false;
  let closed = false;
  const OPEN = "<<<ANSWER>>>";
  const CLOSE = "<<<END>>>";
  for await (const ev of stream(cfg, messages) as AsyncGenerator<StreamEvent>) {
    if (ev.type === "delta" && ev.text) {
      raw += ev.text;
      if (closed) continue;
      pending += ev.text;
      if (!opened) {
        const i = pending.indexOf(OPEN);
        if (i >= 0) {
          opened = true;
          pending = pending.slice(i + OPEN.length);
        } else if (pending.length > OPEN.length * 2) {
          // No opener yet and plenty of text: model is writing bare prose.
          // Stream it anyway; the stored answer falls back to the raw text.
          opened = true;
        } else continue;
      }
      const j = pending.indexOf(CLOSE);
      if (j >= 0) {
        const out = pending.slice(0, j);
        if (out) yield { type: "token", text: out };
        pending = "";
        closed = true;
        continue;
      }
      // Hold back a tail that could be the start of a CLOSE marker.
      const hold = Math.min(pending.length, CLOSE.length - 1);
      const safe = pending.slice(0, pending.length - hold);
      if (safe) yield { type: "token", text: safe };
      pending = pending.slice(pending.length - hold);
    } else if (ev.type === "done") {
      finish = ev.finish_reason ?? null;
      usage = ev.usage;
    } else if (ev.type === "error") {
      error = ev.error ?? "unknown stream error";
      log(`explain: ${error}`);
      yield { type: "error", error };
    }
  }
  if (!closed && pending) yield { type: "token", text: pending.replace(CLOSE, "") };

  const truncated = finish === "length";
  const blocks = extractBlocks(raw, "ANSWER");
  const last = blocks[blocks.length - 1];
  const answer = truncated ? null : last ? last.trim() : raw.trim() || null;
  if (!last && !truncated && raw.trim()) log(`explain: model returned no closed <<<ANSWER>>> block; storing raw prose (${raw.length} chars)`);
  if (truncated) log(`explain: finish_reason=length — answer rejected for storage, ${raw.length} chars streamed`);

  const record: ObservationRecord = {
    id: deterministicId("obs", { question, plan: plan.id, calc: pkg.calculation_ids, started }),
    question,
    intent: plan.intent,
    query_plan: { id: plan.id, intent: plan.intent, filters: plan.filters, source: plan.source },
    model: cfg.model,
    model_revision: null,
    prompt_version: PROMPT_VERSION,
    evidence_ids: pkg.evidence_ids.slice(0, 500),
    evidence_count: pkg.evidence_ids.length,
    calculation_ids: pkg.calculation_ids,
    answer,
    answer_truncated: truncated,
    raw_output: raw.slice(0, 8000),
    finish_reason: finish,
    usage,
    latency_ms: Date.now() - started,
    error,
    created_at: new Date().toISOString(),
  };
  let hash: string | null = null;
  if (store) {
    try {
      const row: NedbRow = await store.put(COLL.observations, record.id, record as unknown as Record<string, unknown>, {
        causedBy: pkg.calculation_hashes.filter(Boolean),
        evidence: `explainer@${PROMPT_VERSION} · ${cfg.model}`,
      });
      hash = row._hash;
    } catch (e) {
      log(`explain: failed to store observation: ${(e as Error).message}`);
    }
  }
  yield { type: "observation", observation: record, hash };
}

/** Deterministic fallback text when the model is unavailable — never blank. */
export function deterministicFallback(pkg: EvidencePackage): string {
  const s = pkg.deterministic_statements ?? [];
  if (s.length) return s.join(" ");
  return "The numbers are ready below; the explanation model is unavailable right now, so CHALK is showing the evidence without narration.";
}
