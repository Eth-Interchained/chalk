/**
 * Rating engine — metrics -> normalization -> weighted definition -> 0-100.
 *
 * A RatingSnapshot preserves everything spec §16 demands: population,
 * time window, normalization algorithm+version, raw metric values, normalized
 * values, weights, final score — plus the analysis id it was computed from and
 * the sample size, so the 0-100 can always be walked back to plays.
 *
 * Disagreement (spec §19) is computed deterministically from two snapshots
 * over the same subject: per-component contribution deltas, sorted by |delta|,
 * with a one-line deterministic sentence for each. The model may paraphrase;
 * it never invents the reason.
 */
import type { MetricBundle } from "../engine/metrics.ts";
import { COLL } from "../store/collections.ts";
import { deterministicId } from "../store/hash.ts";
import { type NedbRow } from "../store/nedb.ts";
import type { Store } from "../store/nedb.ts";
import type { RatingDefinition, RatingSubject } from "./definitions.ts";
import { percentileRank } from "./normalize.ts";

export interface PopulationMember {
  /** Subject key, e.g. team abbr. */
  key: string;
  metrics: MetricBundle;
  /** Analysis id the metrics came from (for provenance). */
  analysis_id: string;
  analysis_hash?: string;
  attempts: number;
}

export interface RatingComponentResult {
  metric: string;
  label: string;
  weight: number;
  direction: "higher_is_better" | "lower_is_better";
  raw: number | null;
  /** percentile rank (0..1) in the direction-adjusted sense: 1 = best. */
  normalized: number | null;
  /** weight * normalized * 100 — points contributed to the final score. */
  contribution: number | null;
  population_n: number;
  /** League median raw value for context. */
  population_median: number | null;
  /** 1-based rank among population (1 = best), null if raw missing. */
  rank: number | null;
}

export interface RatingSnapshot {
  id: string;
  subject_key: string;
  subject: RatingSubject;
  definition_id: string;
  definition_version: string;
  definition_name: string;
  analysis_id: string;
  score: number | null;
  /** Score before rounding, for exact comparisons. */
  score_exact: number | null;
  components: RatingComponentResult[];
  population: { size: number; description: string; keys: string[] };
  time_window: { season?: number; game_id?: string; description: string };
  normalization: "percentile_rank";
  normalization_version: string;
  sample_size: number;
  /** attempts < definition.min_sample */
  provisional: boolean;
  /** true when any component had no raw value and the score was re-weighted over the rest. */
  reweighted: boolean;
  created_at: string;
}

export function computeRating(
  def: RatingDefinition,
  subject: PopulationMember,
  population: readonly PopulationMember[],
  window: RatingSnapshot["time_window"],
  now = new Date().toISOString(),
): RatingSnapshot {
  const components: RatingComponentResult[] = [];
  let usedWeight = 0;
  let score = 0;
  let reweighted = false;
  for (const c of def.components) {
    const raw = (subject.metrics as unknown as Record<string, number | null>)[c.metric] ?? null;
    const pop = population
      .map((m) => (m.metrics as unknown as Record<string, number | null>)[c.metric] ?? null)
      .filter((v): v is number => v !== null);
    let normalized: number | null = null;
    let rank: number | null = null;
    if (raw !== null && pop.length) {
      const p = percentileRank(raw, pop);
      normalized = p === null ? null : c.direction === "higher_is_better" ? p : 1 - p;
      const better = pop.filter((v) => (c.direction === "higher_is_better" ? v > raw : v < raw)).length;
      rank = better + 1;
    }
    const contribution = normalized === null ? null : c.weight * normalized * 100;
    if (contribution !== null) {
      usedWeight += c.weight;
      score += contribution;
    } else {
      reweighted = true;
    }
    components.push({
      metric: c.metric,
      label: c.label,
      weight: c.weight,
      direction: c.direction,
      raw,
      normalized,
      contribution,
      population_n: pop.length,
      population_median: median(pop),
      rank,
    });
  }
  const score_exact = usedWeight > 0 ? score / usedWeight : null;
  const id = deterministicId("rating", {
    def: def.id,
    subject: subject.key,
    analysis: subject.analysis_id,
    population: population.map((m) => m.analysis_id).sort(),
  });
  return {
    id,
    subject_key: subject.key,
    subject: def.subject,
    definition_id: def.id,
    definition_version: def.version,
    definition_name: def.name,
    analysis_id: subject.analysis_id,
    score: score_exact === null ? null : Math.round(score_exact),
    score_exact,
    components,
    population: {
      size: population.length,
      description: `${population.length} ${def.subject} units, same scope`,
      keys: population.map((m) => m.key).sort(),
    },
    time_window: window,
    normalization: "percentile_rank",
    normalization_version: def.normalization_version,
    sample_size: subject.attempts,
    provisional: subject.attempts < def.min_sample,
    reweighted,
    created_at: now,
  };
}

export function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// ------------------------------------------------------------- disagreement

export interface DisagreementLine {
  metric: string;
  label: string;
  weight_a: number;
  weight_b: number;
  normalized: number | null;
  contribution_a: number | null;
  contribution_b: number | null;
  /** contribution_b - contribution_a, points of the 0-100 score. */
  delta: number | null;
  sentence: string;
}

export interface Disagreement {
  subject_key: string;
  a: { definition_id: string; name: string; score: number | null; snapshot_id: string };
  b: { definition_id: string; name: string; score: number | null; snapshot_id: string };
  /** score_b - score_a */
  delta: number | null;
  lines: DisagreementLine[];
  /** Deterministic headline: the single largest driver. */
  headline: string;
}

export function explainDisagreement(a: RatingSnapshot, b: RatingSnapshot): Disagreement {
  if (a.subject_key !== b.subject_key) throw new Error("explainDisagreement: snapshots are for different subjects");
  const metrics = new Set([...a.components.map((c) => c.metric), ...b.components.map((c) => c.metric)]);
  const lines: DisagreementLine[] = [];
  for (const m of metrics) {
    const ca = a.components.find((c) => c.metric === m);
    const cb = b.components.find((c) => c.metric === m);
    const normalized = (ca ?? cb)!.normalized;
    const wa = ca?.weight ?? 0;
    const wb = cb?.weight ?? 0;
    const conA = ca?.contribution ?? (normalized === null ? null : 0);
    const conB = cb?.contribution ?? (normalized === null ? null : 0);
    const delta = conA === null || conB === null ? null : conB - conA;
    const label = (ca ?? cb)!.label;
    let sentence: string;
    if (normalized === null) sentence = `${label}: no value available, contributes to neither rating.`;
    else if (wa === 0) sentence = `${label} counts in "${b.definition_name}" (${pct(wb)}) but not in "${a.definition_name}"; the team sits at the ${pctile(normalized)} percentile, ${signed(delta)} pts.`;
    else if (wb === 0) sentence = `${label} counts in "${a.definition_name}" (${pct(wa)}) but not in "${b.definition_name}"; the team sits at the ${pctile(normalized)} percentile, ${signed(delta)} pts.`;
    else if (Math.abs(wa - wb) < 1e-9) sentence = `${label} weighted the same (${pct(wa)}) in both; no effect on the gap.`;
    else sentence = `${label} weighted ${pct(wb)} vs ${pct(wa)} (${ratio(wb, wa)}); team is at the ${pctile(normalized)} percentile, so the shift is worth ${signed(delta)} pts.`;
    lines.push({ metric: m, label, weight_a: wa, weight_b: wb, normalized, contribution_a: conA, contribution_b: conB, delta, sentence });
  }
  lines.sort((x, y) => Math.abs(y.delta ?? 0) - Math.abs(x.delta ?? 0));
  const scoreDelta = a.score_exact === null || b.score_exact === null ? null : b.score_exact - a.score_exact;
  const top = lines.find((l) => l.delta !== null && Math.abs(l.delta) > 0.05);
  const headline = top
    ? `"${b.definition_name}" scores ${a.subject_key} ${signed(scoreDelta)} vs "${a.definition_name}", mainly because ${top.label.toLowerCase()} is weighted ${pct(top.weight_b)} instead of ${pct(top.weight_a)}.`
    : `"${a.definition_name}" and "${b.definition_name}" agree on ${a.subject_key} within a point.`;
  return {
    subject_key: a.subject_key,
    a: { definition_id: a.definition_id, name: a.definition_name, score: a.score, snapshot_id: a.id },
    b: { definition_id: b.definition_id, name: b.definition_name, score: b.score, snapshot_id: b.id },
    delta: scoreDelta === null ? null : Math.round(scoreDelta * 10) / 10,
    lines,
    headline,
  };
}

function pct(w: number): string {
  return `${Math.round(w * 100)}%`;
}
function pctile(p: number): string {
  const n = Math.round(p * 100);
  const suffix = n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th";
  return `${n}${suffix}`;
}
function signed(v: number | null): string {
  if (v === null) return "n/a";
  const r = Math.round(v * 10) / 10;
  return `${r >= 0 ? "+" : ""}${r}`;
}
function ratio(a: number, b: number): string {
  if (b === 0) return "new";
  const r = a / b;
  return `${Math.round(r * 10) / 10}×`;
}

// ------------------------------------------------------------- persistence

export async function persistRating(
  store: Store,
  snap: RatingSnapshot,
  causedBy: string[],
): Promise<{ row: NedbRow; cached: boolean }> {
  const existing = await store.get(COLL.ratings, snap.id);
  if (existing) return { row: existing, cached: true };
  const row = await store.put(COLL.ratings, snap.id, snap as unknown as Record<string, unknown>, {
    causedBy,
    evidence: `${snap.definition_id} · percentile_rank@${snap.normalization_version}`,
  });
  return { row, cached: false };
}

export async function persistDefinition(store: Store, def: RatingDefinition): Promise<NedbRow> {
  const existing = await store.get<RatingDefinition>(COLL.rating_definitions, def.id);
  if (existing && JSON.stringify(existing.data.components) === JSON.stringify(def.components)) {
    return existing as unknown as NedbRow;
  }
  return store.put(COLL.rating_definitions, def.id, def as unknown as Record<string, unknown>, {
    causedBy: existing ? [existing._hash] : undefined,
    evidence: existing ? "rating definition revised" : "rating definition created",
  });
}
