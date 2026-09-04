/**
 * Third-down analysis — the first vertical slice (spec §33).
 *
 * Input: a SituationFilter (team/season or game, side) — down is forced to [3].
 * Output: a ThirdDownAnalysis whose every number is reproducible from the
 * evidence play ids, plus the play list itself so the API can hand it back.
 *
 * Persistence: the analysis is stored in football_analyses under a
 * content-derived id (filter + algorithm version + evidence hashes), with
 * caused_by = the evidence plays' NEDB hashes. Same question, same data ->
 * same id -> cache hit. New data or a new algorithm version -> new id. That is
 * the "as known then" vs "recalculated now" split made concrete: a stored
 * analysis IS what CHALK knew at that seq.
 */
import type { DistanceBucket, Play } from "../model/football.ts";
import { COLL } from "../store/collections.ts";
import { deterministicId } from "../store/hash.ts";
import { type NedbRow } from "../store/nedb.ts";
import type { Store } from "../store/nedb.ts";
import {
  computeMetrics,
  confidenceFor,
  groupBy,
  groupByDistanceBucket,
  round,
  DISTANCE_BUCKETS,
  DISTANCE_BUCKET_RANGES,
  type Confidence,
  type MetricBundle,
} from "./metrics.ts";
import { applyFilter, compileNql, describeFilter, type SituationFilter } from "./situation.ts";

export const THIRD_DOWN_ALGORITHM = "third-down";
export const THIRD_DOWN_VERSION = "0.1.0";

export interface BucketResult {
  bucket: DistanceBucket;
  label: string;
  metrics: MetricBundle;
  evidence: string[];
}

export interface GameSplit {
  game_id: string;
  week: number | null;
  opponent: string | null;
  metrics: MetricBundle;
  evidence: string[];
}

export interface ThirdDownAnalysis {
  id: string;
  algorithm: string;
  algorithm_version: string;
  kind: "third_down";
  filter: SituationFilter;
  definition: string;
  /** Provider-classified plays excluded by the filter, by reason — shown in evidence. */
  excluded: Record<string, number>;
  candidates: number;
  metrics: MetricBundle;
  by_distance: BucketResult[];
  by_game: GameSplit[];
  /** `long_and_very_long` — the "third-and-long" headline the fan view leads with. */
  third_and_long: { definition: string; metrics: MetricBundle; evidence: string[] };
  third_and_short: { definition: string; metrics: MetricBundle; evidence: string[] };
  /** Worst bucket by conversion rate with n >= low threshold; null if nothing qualifies. */
  weakest_bucket: DistanceBucket | null;
  strongest_bucket: DistanceBucket | null;
  confidence: Confidence;
  evidence: string[];
  evidence_hashes: string[];
  /** NEDB seq/head the candidate query was answered at. */
  computed_at_seq: number;
  computed_at_head: string;
  created_at: string;
}

export interface ThirdDownInput {
  team: string;
  side?: "offense" | "defense";
  season?: number;
  game_id?: string;
  game_ids?: string[];
  opponent?: string;
  exclude_garbage_time?: boolean;
  exclude_penalties?: boolean;
  week_min?: number;
  week_max?: number;
}

export function thirdDownFilter(input: ThirdDownInput): SituationFilter {
  const f: SituationFilter = {
    team: input.team.toUpperCase(),
    side: input.side ?? "offense",
    down: [3],
    snaps_only: true,
    exclude_kneels: true,
    exclude_spikes: true,
    exclude_no_play: true,
    exclude_penalties: input.exclude_penalties ?? false,
    exclude_garbage_time: input.exclude_garbage_time ?? false,
  };
  if (input.season !== undefined) f.season = input.season;
  if (input.game_id) f.game_id = input.game_id;
  if (input.game_ids) f.game_ids = [...input.game_ids].sort();
  if (input.opponent) f.opponent = input.opponent.toUpperCase();
  if (input.week_min !== undefined) f.week_min = input.week_min;
  if (input.week_max !== undefined) f.week_max = input.week_max;
  return f;
}

/** Pure: analysis over an already-fetched candidate population. */
export function analyzeThirdDown(
  candidates: readonly NedbRow<Play>[],
  filter: SituationFilter,
  at: { seq: number; head: string },
  now = new Date().toISOString(),
): ThirdDownAnalysis {
  const f: SituationFilter = { ...filter, down: [3] };
  // Scope candidates to the subject's own third downs BEFORE exclusion
  // accounting, so `excluded` reports only this team's dropped plays and never
  // counts the opponent's snaps as "filtered".
  const teamField = f.side === "offense" ? "posteam" : "defteam";
  const rows = candidates.filter(
    (r) =>
      r.data.down === 3 &&
      r.data[teamField] === f.team &&
      (!f.game_id || r.data.game_id === f.game_id) &&
      (f.season === undefined || r.data.season === f.season),
  );
  const plays = rows.map((r) => r.data);
  const kept = applyFilter(plays, f);
  const keptIds = new Set(kept.map((p) => p.id));
  const hashById = new Map(rows.map((r) => [r.data.id, r._hash] as const));

  // Exclusion accounting — the coach wants to know what was dropped and why.
  const excluded: Record<string, number> = {};
  for (const p of plays) {
    if (keptIds.has(p.id)) continue;
    const reason = p.is_no_play
      ? "no_play"
      : p.is_kneel
        ? "qb_kneel"
        : p.is_spike
          ? "qb_spike"
          : f.exclude_penalties && p.penalty
            ? "penalty"
            : f.exclude_garbage_time && p.garbage_time
              ? "garbage_time"
              : !p.is_snap
                ? `non_snap:${p.play_type ?? "unknown"}`
                : "filter";
    excluded[reason] = (excluded[reason] ?? 0) + 1;
  }

  const metrics = computeMetrics(kept);
  const buckets = groupByDistanceBucket(kept);
  const by_distance: BucketResult[] = DISTANCE_BUCKETS.map((b) => ({
    bucket: b,
    label: DISTANCE_BUCKET_RANGES[b].label,
    metrics: computeMetrics(buckets[b]),
    evidence: buckets[b].map((p) => p.id),
  }));

  const byGame = groupBy(kept, (p) => p.game_id);
  const by_game: GameSplit[] = [...byGame.entries()]
    .map(([game_id, ps]) => ({
      game_id,
      week: ps[0]?.week ?? null,
      opponent: (f.side === "offense" ? ps[0]?.defteam : ps[0]?.posteam) ?? null,
      metrics: computeMetrics(ps),
      evidence: ps.map((p) => p.id),
    }))
    .sort((a, b) => (a.week ?? 0) - (b.week ?? 0) || a.game_id.localeCompare(b.game_id));

  const longPlays = [...buckets.long, ...buckets.very_long];
  const shortPlays = buckets.short;

  const qualifying = by_distance.filter((b) => b.metrics.attempts >= 10 && b.metrics.conversion_rate !== null);
  const weakest = qualifying.length
    ? qualifying.reduce((w, b) => (b.metrics.conversion_rate! < w.metrics.conversion_rate! ? b : w)).bucket
    : null;
  const strongest = qualifying.length
    ? qualifying.reduce((s, b) => (b.metrics.conversion_rate! > s.metrics.conversion_rate! ? b : s)).bucket
    : null;

  const evidence = kept.map((p) => p.id);
  const evidence_hashes = evidence.map((id) => hashById.get(id)!).filter(Boolean);
  const id = deterministicId("tdn", {
    algorithm: THIRD_DOWN_ALGORITHM,
    version: THIRD_DOWN_VERSION,
    filter: f,
    evidence_hashes,
  });

  return {
    id,
    algorithm: THIRD_DOWN_ALGORITHM,
    algorithm_version: THIRD_DOWN_VERSION,
    kind: "third_down",
    filter: f,
    definition: describeFilter(f),
    excluded,
    candidates: plays.length,
    metrics,
    by_distance,
    by_game,
    third_and_long: {
      definition: "third down with 7+ yards to go (long + very_long buckets)",
      metrics: computeMetrics(longPlays),
      evidence: longPlays.map((p) => p.id),
    },
    third_and_short: {
      definition: "third down with 1-3 yards to go",
      metrics: computeMetrics(shortPlays),
      evidence: shortPlays.map((p) => p.id),
    },
    weakest_bucket: weakest,
    strongest_bucket: strongest,
    confidence: confidenceFor(kept.length),
    evidence,
    evidence_hashes,
    computed_at_seq: at.seq,
    computed_at_head: at.head,
    created_at: now,
  };
}

/** Fetch candidates from NEDB, analyze, persist (idempotent by content id). */
export async function runThirdDown(
  store: Store,
  input: ThirdDownInput,
  opts: { persist?: boolean; log?: (l: string) => void } = {},
): Promise<{ analysis: ThirdDownAnalysis; plays: NedbRow<Play>[]; stored: NedbRow | null; cached: boolean; nql: string }> {
  const filter = thirdDownFilter(input);
  const nql = compileNql(filter);
  const t0 = Date.now();
  const { rows, seq, head } = await store.queryAt<Play>(nql);
  opts.log?.(`third-down candidates: ${rows.length} rows in ${Date.now() - t0}ms via ${nql}`);
  const analysis = analyzeThirdDown(rows, filter, { seq, head });
  const keep = new Set(analysis.evidence);
  const plays = rows.filter((r) => keep.has(r.data.id));

  let stored: NedbRow | null = null;
  let cached = false;
  if (opts.persist !== false) {
    const existing = await store.get(COLL.analyses, analysis.id);
    if (existing) {
      stored = existing;
      cached = true;
    } else {
      // caused_by every evidence play: TRACE from the analysis reaches each play,
      // then each raw record. Capped at 2000 edges — a season has ~230 third downs.
      stored = await store.put(COLL.analyses, analysis.id, analysis as unknown as Record<string, unknown>, {
        causedBy: analysis.evidence_hashes.slice(0, 2000),
        evidence: `${THIRD_DOWN_ALGORITHM}@${THIRD_DOWN_VERSION}`,
      });
    }
  }
  return { analysis, plays, stored, cached, nql };
}

/** Compact, presentation-rounded view for the model + fan UI. Few hundred bytes. */
export function summarizeThirdDown(a: ThirdDownAnalysis) {
  const m = a.metrics;
  const pct = (v: number | null) => (v === null ? null : round(v * 100, 1));
  return {
    team: a.filter.team,
    side: a.filter.side,
    scope: a.filter.game_id ?? (a.filter.season !== undefined ? `${a.filter.season} season` : "selected games"),
    definition: a.definition,
    attempts: m.attempts,
    conversions: m.conversions,
    conversion_pct: pct(m.conversion_rate),
    pass_pct: pct(m.pass_rate),
    epa_per_play: round(m.epa_per_play, 3),
    success_pct: pct(m.success_rate),
    yards_per_play: round(m.yards_per_play, 2),
    turnovers: m.turnovers,
    confidence: a.confidence,
    by_distance: a.by_distance.map((b) => ({
      distance: b.label,
      attempts: b.metrics.attempts,
      conversions: b.metrics.conversions,
      conversion_pct: pct(b.metrics.conversion_rate),
      epa_per_play: round(b.metrics.epa_per_play, 3),
      pass_pct: pct(b.metrics.pass_rate),
    })),
    third_and_long: {
      attempts: a.third_and_long.metrics.attempts,
      conversions: a.third_and_long.metrics.conversions,
      conversion_pct: pct(a.third_and_long.metrics.conversion_rate),
    },
    third_and_short: {
      attempts: a.third_and_short.metrics.attempts,
      conversions: a.third_and_short.metrics.conversions,
      conversion_pct: pct(a.third_and_short.metrics.conversion_rate),
    },
    weakest_bucket: a.weakest_bucket,
    strongest_bucket: a.strongest_bucket,
    games: a.by_game.length,
    excluded: a.excluded,
  };
}
