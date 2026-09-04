/**
 * Intent executors — a validated QueryPlan in, an EvidencePackage out.
 *
 * Everything here is deterministic and persisted. The package's `summary` is
 * the ONLY thing the model sees; every number in it is presentation-rounded
 * from a stored record the API can hand back by id.
 */
import { compare } from "../engine/comparison.ts";
import { analyzeDeviation } from "../engine/deviation.ts";
import { computeMetrics, round } from "../engine/metrics.ts";
import { scanSituations } from "../engine/scan.ts";
import { compileNql, type SituationFilter } from "../engine/situation.ts";
import { analyzeTendency, baselineFilter } from "../engine/tendency.ts";
import { runThirdDown, summarizeThirdDown } from "../engine/thirddown.ts";
import type { EvidencePackage } from "../llm/explain.ts";
import type { QueryPlan } from "../llm/planner.ts";
import type { Game, Play } from "../model/football.ts";
import { THIRD_DOWN_DEFAULT_V1 } from "../rating/definitions.ts";
import { compareDefinitions, loadDefinition, rateThirdDown, type RateResult } from "../rating/league.ts";
import type { RatingSnapshot } from "../rating/rating.ts";
import { COLL } from "../store/collections.ts";
import { ChalkStore, nqlStr, type NedbRow } from "../store/nedb.ts";
import type { RawDoc } from "../ingest/ingest.ts";

export interface ExecContext {
  store: ChalkStore;
  log: (l: string) => void;
}

export interface ExecResult {
  package: EvidencePackage;
  /** Full structured result for the UI (coach view). */
  detail: unknown;
}

const pct = (v: number | null) => (v === null ? null : round(v * 100, 1));

export function summarizeRating(r: RateResult) {
  const s = r.snapshot;
  return {
    team: s.subject_key,
    definition: s.definition_name,
    definition_id: s.definition_id,
    score: s.score,
    rank: r.rank,
    of: r.population.length,
    sample_size: s.sample_size,
    provisional: s.provisional,
    normalization: `${s.normalization}@${s.normalization_version}`,
    components: s.components.map((c) => ({
      metric: c.metric,
      weight_pct: Math.round(c.weight * 100),
      raw: c.metric.endsWith("_rate") ? pct(c.raw) : round(c.raw, 3),
      raw_unit: c.metric.endsWith("_rate") ? "%" : "epa",
      league_median: c.metric.endsWith("_rate") ? pct(c.population_median) : round(c.population_median, 3),
      percentile: c.normalized === null ? null : Math.round(c.normalized * 100),
      rank: c.rank,
      points: round(c.contribution, 1),
    })),
  };
}

export async function fetchCandidates(store: ChalkStore, f: SituationFilter) {
  return store.queryAt<Play>(compileNql(f));
}

export async function execute(plan: QueryPlan, ctx: ExecContext): Promise<ExecResult> {
  const { store, log } = ctx;
  switch (plan.intent) {
    case "third_down": {
      const f = plan.filter!;
      const res = await runThirdDown(store, {
        team: f.team, side: f.side, season: f.season, game_id: f.game_id, game_ids: f.game_ids, opponent: f.opponent,
        exclude_garbage_time: f.exclude_garbage_time, exclude_penalties: f.exclude_penalties, week_min: f.week_min, week_max: f.week_max,
      }, { log });
      const a = res.analysis;
      let rating: RateResult | null = null;
      if (f.season !== undefined && !f.game_id && !f.game_ids) rating = await rateThirdDown(store, f.team, f.season, THIRD_DOWN_DEFAULT_V1, f.side, log);
      const statements: string[] = [];
      const m = a.metrics;
      if (m.attempts > 0) statements.push(`${f.team} converted ${m.conversions} of ${m.attempts} third downs (${pct(m.conversion_rate)}%) in this scope.`);
      if (a.third_and_long.metrics.attempts > 0) statements.push(`On third-and-long (7+): ${a.third_and_long.metrics.conversions} of ${a.third_and_long.metrics.attempts} (${pct(a.third_and_long.metrics.conversion_rate)}%).`);
      if (rating) statements.push(`Third Down Rating: ${rating.snapshot.score}/100 under "${rating.definition.name}", rank ${rating.rank} of ${rating.population.length}.`);
      if (a.confidence === "insufficient" || a.confidence === "low") statements.push(`Sample is ${a.confidence} (${m.attempts} plays) — treat as descriptive, not a tendency.`);
      return {
        package: {
          kind: "third_down",
          summary: { analysis: summarizeThirdDown(a), rating: rating ? summarizeRating(rating) : null },
          calculation_ids: [a.id, ...(rating ? [rating.snapshot.id] : [])],
          calculation_hashes: [res.stored?._hash ?? "", ...(rating ? [rating.stored_hash] : [])].filter(Boolean),
          evidence_ids: a.evidence,
          deterministic_statements: statements,
        },
        detail: { analysis: a, rating: rating?.snapshot ?? null, league: rating?.league ?? null, nql: res.nql, cached: res.cached },
      };
    }
    case "tendency": {
      const f = plan.filter!;
      const { rows, seq, head } = await fetchCandidates(store, baselineFilter(f));
      const t = analyzeTendency(rows, f, { seq, head });
      const existing = await store.get(COLL.tendencies, t.id);
      const stored = existing ?? (await store.put(COLL.tendencies, t.id, t as unknown as Record<string, unknown>, { causedBy: t.evidence_hashes.slice(0, 2000), evidence: `tendency@${t.algorithm_version}` }));
      const m = t.metrics;
      const b = t.baseline;
      return {
        package: {
          kind: "tendency",
          summary: {
            team: f.team, side: f.side, situation: t.definition, baseline: t.baseline_definition,
            sample: m.attempts, baseline_sample: t.baseline_evidence_count, confidence: t.confidence,
            situation_metrics: { pass_pct: pct(m.pass_rate), run_pct: pct(m.run_rate), success_pct: pct(m.success_rate), conversion_pct: pct(m.conversion_rate), epa_per_play: round(m.epa_per_play, 3), yards_per_play: round(m.yards_per_play, 2), explosive_pct: pct(m.explosive_rate) },
            baseline_metrics: { pass_pct: pct(b.pass_rate), run_pct: pct(b.run_rate), success_pct: pct(b.success_rate), conversion_pct: pct(b.conversion_rate), epa_per_play: round(b.epa_per_play, 3), yards_per_play: round(b.yards_per_play, 2), explosive_pct: pct(b.explosive_rate) },
            deltas: t.deltas.map((d) => ({ metric: d.metric, delta: round(d.delta, d.unit === "pp" ? 1 : 3), unit: d.unit })),
          },
          calculation_ids: [t.id],
          calculation_hashes: [stored._hash],
          evidence_ids: t.evidence,
          unsupported: t.unsupported,
          deterministic_statements: t.headline ? [t.headline] : [],
        },
        detail: { tendency: t, cached: Boolean(existing) },
      };
    }
    case "comparison": {
      const fa = plan.a!;
      const fb = plan.b!;
      const ra = await fetchCandidates(store, fa);
      const rb = await fetchCandidates(store, fb);
      const seen = new Set<string>();
      const union: NedbRow<Play>[] = [];
      for (const r of [...ra.rows, ...rb.rows]) if (!seen.has(r._id)) { seen.add(r._id); union.push(r); }
      const c = compare(union, fa, fb, { seq: Math.max(ra.seq, rb.seq), head: rb.head });
      const existing = await store.get(COLL.comparisons, c.id);
      const stored = existing ?? (await store.put(COLL.comparisons, c.id, c as unknown as Record<string, unknown>, { evidence: `comparison@${c.algorithm_version}` }));
      const fmtB = (m: typeof c.a.metrics) => ({ attempts: m.attempts, pass_pct: pct(m.pass_rate), success_pct: pct(m.success_rate), conversion_pct: pct(m.conversion_rate), epa_per_play: round(m.epa_per_play, 3), yards_per_play: round(m.yards_per_play, 2), explosive_pct: pct(m.explosive_rate), turnover_pct: pct(m.turnover_rate) });
      const statements = c.lines.filter((l) => l.unit === "pp" && l.delta !== null && Math.abs(l.delta) >= 3).slice(0, 3).map((l) => `${l.metric.replace(/_/g, " ")}: ${pct(l.a)}% (A) vs ${pct(l.b)}% (B), ${l.delta! > 0 ? "+" : ""}${round(l.delta, 1)} pts.`);
      return {
        package: {
          kind: "comparison",
          summary: { a: { definition: c.a.definition, confidence: c.a.confidence, ...fmtB(c.a.metrics) }, b: { definition: c.b.definition, confidence: c.b.confidence, ...fmtB(c.b.metrics) }, biggest_gap: c.biggest_gap, lines: c.lines.map((l) => ({ metric: l.metric, a: l.unit === "pp" ? pct(l.a) : round(l.a, 3), b: l.unit === "pp" ? pct(l.b) : round(l.b, 3), delta: round(l.delta, l.unit === "pp" ? 1 : 3), unit: l.unit, higher_is_better: l.higher_is_better })) },
          calculation_ids: [c.id],
          calculation_hashes: [stored._hash],
          evidence_ids: [...c.a.evidence, ...c.b.evidence],
          deterministic_statements: statements,
        },
        detail: { comparison: c, cached: Boolean(existing) },
      };
    }
    case "situation_scan": {
      const f = plan.filter!;
      const { rows, seq, head } = await fetchCandidates(store, f);
      const scan = scanSituations(rows, f, { seq, head });
      const existing = await store.get(COLL.analyses, scan.id);
      const stored = existing ?? (await store.put(COLL.analyses, scan.id, { ...scan, buckets: scan.buckets.map((b) => ({ ...b, evidence: b.evidence.slice(0, 500) })) } as unknown as Record<string, unknown>, { evidence: `situation-scan@${scan.algorithm_version}` }));
      const fmt = (b: (typeof scan.buckets)[number]) => ({ situation: b.label, snaps: b.metrics.attempts, epa_per_play: round(b.metrics.epa_per_play, 3), epa_vs_team: round(b.epa_delta_vs_team, 3), success_pct: pct(b.metrics.success_rate), success_vs_team_pp: round(b.success_pp_vs_team, 1), confidence: b.confidence });
      const weakest = scan.weakest.slice(0, 5);
      const strongest = scan.strongest.slice(0, 3);
      const statements: string[] = [];
      if (weakest[0]) statements.push(`Weakest qualifying situation: ${weakest[0].label} — ${round(weakest[0].metrics.epa_per_play, 2)} EPA/play over ${weakest[0].metrics.attempts} snaps, ${round(weakest[0].epa_delta_vs_team, 2)} below the team's ${round(scan.baseline.epa_per_play, 2)} baseline.`);
      if (strongest[0]) statements.push(`Strongest: ${strongest[0].label} — ${round(strongest[0].metrics.epa_per_play, 2)} EPA/play over ${strongest[0].metrics.attempts} snaps.`);
      statements.push(`Buckets with fewer than ${scan.min_sample} snaps were excluded from ranking.`);
      return {
        package: {
          kind: "situation_scan",
          summary: { team: f.team, side: f.side, scope: f.game_id ?? `${f.season} season`, baseline: { snaps: scan.baseline.attempts, epa_per_play: round(scan.baseline.epa_per_play, 3), success_pct: pct(scan.baseline.success_rate) }, weakest: weakest.map(fmt), strongest: strongest.map(fmt), min_sample: scan.min_sample, excluded_small_samples: scan.buckets.filter((b) => !b.qualifies).map((b) => `${b.label} (${b.metrics.attempts})`) },
          calculation_ids: [scan.id],
          calculation_hashes: [stored._hash],
          evidence_ids: weakest.flatMap((b) => b.evidence),
          deterministic_statements: statements,
        },
        detail: { scan: { ...scan, buckets: scan.buckets.map((b) => ({ ...b, evidence: b.evidence.length > 200 ? b.evidence.slice(0, 200) : b.evidence })) }, cached: Boolean(existing) },
      };
    }
    case "game_summary": {
      const game_id = String(plan.filters.game_id);
      const team = String(plan.filters.team);
      const gRow = await store.get<Game>(COLL.games, game_id);
      if (!gRow) throw new Error(`game ${game_id} is not ingested`);
      const g = gRow.data;
      const { rows, seq, head } = await store.queryAt<Play>(`FROM ${COLL.plays} WHERE game_id = ${nqlStr(game_id)}`);
      const plays = rows.map((r) => r.data);
      const teams = [g.home_team, g.away_team].filter((t): t is string => Boolean(t));
      const perTeam = teams.map((t) => {
        const snaps = plays.filter((p) => p.posteam === t && p.is_snap && !p.is_no_play);
        const third = snaps.filter((p) => p.down === 3);
        const m = computeMetrics(snaps);
        const t3 = computeMetrics(third);
        return { team: t, snaps: m.attempts, epa_per_play: round(m.epa_per_play, 3), success_pct: pct(m.success_rate), yards_per_play: round(m.yards_per_play, 2), explosive_plays: m.explosives, turnovers: m.turnovers, pass_pct: pct(m.pass_rate), third_down: { attempts: t3.attempts, conversions: t3.conversions, conversion_pct: pct(t3.conversion_rate), epa_per_play: round(t3.epa_per_play, 3) } };
      });
      // Baseline-vs-game deviation for the focus team's offense.
      let deviation = null;
      if (g.season !== null) {
        const sf: SituationFilter = { team, side: "offense", season: g.season, snaps_only: true, exclude_kneels: true, exclude_spikes: true, exclude_no_play: true, exclude_penalties: false, exclude_garbage_time: false };
        const season = await fetchCandidates(store, sf);
        const d = analyzeDeviation(season.rows, sf, game_id, { seq: season.seq, head: season.head });
        const existing = await store.get(COLL.analyses, d.id);
        const stored = existing ?? (await store.put(COLL.analyses, d.id, d as unknown as Record<string, unknown>, { causedBy: d.evidence_hashes.slice(0, 2000), evidence: `deviation@${d.algorithm_version}` }));
        deviation = { d, hash: stored._hash };
      }
      const third = await runThirdDown(store, { team, game_id }, { log });
      const statements = [
        `${g.away_team} ${g.away_score} at ${g.home_team} ${g.home_score}${g.overtime ? " (OT)" : ""}, ${g.season} week ${g.week}. Winner: ${g.winner ?? "tie"}.`,
        ...(deviation ? [deviation.d.headline] : []),
        `${team} third down in this game: ${third.analysis.metrics.conversions} of ${third.analysis.metrics.attempts}.`,
      ];
      return {
        package: {
          kind: "game_summary",
          summary: { game: { id: g.id, season: g.season, week: g.week, home: g.home_team, away: g.away_team, home_score: g.home_score, away_score: g.away_score, winner: g.winner, margin: g.margin, overtime: g.overtime, div_game: g.div_game, stadium: g.stadium }, focus_team: team, teams: perTeam, focus_third_down: summarizeThirdDown(third.analysis), deviation: deviation ? { level: deviation.d.level, driver: deviation.d.driver, lines: deviation.d.lines.map((l) => ({ metric: l.metric, baseline: l.metric === "epa_per_play" ? round(l.baseline, 3) : pct(l.baseline), game: l.metric === "epa_per_play" ? round(l.game, 3) : pct(l.game), z: round(l.z, 2), n_game: l.n_game })) } : null },
          calculation_ids: [third.analysis.id, ...(deviation ? [deviation.d.id] : [])],
          calculation_hashes: [third.stored?._hash ?? "", deviation?.hash ?? ""].filter(Boolean),
          evidence_ids: plays.filter((p) => p.posteam === team && p.is_snap).map((p) => p.id),
          deterministic_statements: statements,
        },
        detail: { game: g, teams: perTeam, third_down: third.analysis, deviation: deviation?.d ?? null, play_count: plays.length },
      };
    }
    case "play_explain": {
      const play_id = String(plan.filters.play_id);
      const pRow = await store.get<Play>(COLL.plays, play_id);
      if (!pRow) throw new Error(`play ${play_id} is not ingested`);
      const p = pRow.data;
      const raw = pRow.data.derived_from?.[0] ? await findRawByHash(store, COLL.raw_plays, pRow.data.derived_from[0], p.game_id) : null;
      const g = await store.get<Game>(COLL.games, p.game_id);
      // Situational context: same team, same down, same distance bucket, season.
      let context = null;
      if (p.posteam && p.season !== null && p.down !== null && p.distance_bucket) {
        const sf: SituationFilter = { team: p.posteam, side: "offense", season: p.season, down: [p.down], distance_bucket: [p.distance_bucket], snaps_only: true, exclude_kneels: true, exclude_spikes: true, exclude_no_play: true, exclude_penalties: false, exclude_garbage_time: false };
        const { rows, seq, head } = await fetchCandidates(store, baselineFilter(sf));
        const t = analyzeTendency(rows, sf, { seq, head });
        context = { situation: t.definition, sample: t.metrics.attempts, pass_pct: pct(t.metrics.pass_rate), success_pct: pct(t.metrics.success_rate), epa_per_play: round(t.metrics.epa_per_play, 3), conversion_pct: pct(t.metrics.conversion_rate), confidence: t.confidence };
      }
      const desc = `${p.posteam} ${ordinal(p.down)} & ${p.ydstogo} at the ${p.yardline_100 !== null ? (p.yardline_100 > 50 ? `own ${100 - p.yardline_100}` : `opp ${p.yardline_100}`) : "?"}, Q${p.quarter}, ${p.posteam_score}-${p.defteam_score}: ${p.play_type} for ${p.yards_gained} yards${p.touchdown ? ", touchdown" : ""}${p.turnover ? ", turnover" : ""}${p.first_down ? ", first down" : ""}${p.penalty ? ", penalty on the play" : ""}. EPA ${round(p.epa, 2)}.`;
      return {
        package: {
          kind: "play_explain",
          summary: { play: { id: p.id, game_id: p.game_id, quarter: p.quarter, down: p.down, ydstogo: p.ydstogo, yardline_100: p.yardline_100, posteam: p.posteam, defteam: p.defteam, score: `${p.posteam_score}-${p.defteam_score}`, play_type: p.play_type, yards_gained: p.yards_gained, touchdown: p.touchdown, turnover: p.turnover, first_down: p.first_down, penalty: p.penalty, epa: round(p.epa, 3), wpa: round(p.wpa, 3), success: p.success, explosive: p.explosive, garbage_time: p.garbage_time }, game: g ? { home: g.data.home_team, away: g.data.away_team, final: `${g.data.away_team} ${g.data.away_score} @ ${g.data.home_team} ${g.data.home_score}`, week: g.data.week, season: g.data.season } : null, team_context_same_situation: context },
          calculation_ids: [],
          calculation_hashes: [pRow._hash],
          evidence_ids: [p.id],
          unsupported: ["formation, personnel, motion, coverage — in participation/charting data, not joined into play explanations yet", "player names — roster join not built"],
          deterministic_statements: [desc],
        },
        detail: { play: pRow, raw, game: g?.data ?? null, context },
      };
    }
    case "rating": {
      const f = plan.filter!;
      const defId = typeof plan.filters.definition_id === "string" ? plan.filters.definition_id : THIRD_DOWN_DEFAULT_V1.id;
      const def = (await loadDefinition(store, defId)) ?? THIRD_DOWN_DEFAULT_V1;
      const r = await rateThirdDown(store, f.team, f.season!, def, f.side, log);
      if (!r) throw new Error(`no third-down data for ${f.team} ${f.season}`);
      const s = r.snapshot;
      const top = [...s.components].sort((x, y) => (y.contribution ?? 0) - (x.contribution ?? 0))[0];
      return {
        package: {
          kind: "rating",
          summary: { rating: summarizeRating(r), analysis: summarizeThirdDown(r.analysis), formula_notes: def.notes ?? null, league_top5: r.league.slice(0, 5), league_bottom3: r.league.slice(-3) },
          calculation_ids: [s.id, r.analysis.id],
          calculation_hashes: [r.stored_hash],
          evidence_ids: r.analysis.evidence,
          deterministic_statements: [
            `${f.team} Third Down Rating: ${s.score}/100 under "${def.name}" v${def.version} — rank ${r.rank} of ${r.population.length} (${s.normalization} normalization, ${s.sample_size} third downs).`,
            ...(top ? [`Largest contributor: ${top.label} at the ${Math.round((top.normalized ?? 0) * 100)}th percentile, worth ${round(top.contribution, 1)} of the ${s.score} points.`] : []),
            ...(s.provisional ? [`Provisional: sample below the definition's minimum of ${def.min_sample}.`] : []),
          ],
        },
        detail: { snapshot: s, analysis: r.analysis, definition: def, league: r.league, rank: r.rank },
      };
    }
    case "rating_compare": {
      const f = plan.filter!;
      const a = await loadDefinition(store, String(plan.filters.a));
      const b = await loadDefinition(store, String(plan.filters.b));
      if (!a || !b) throw new Error(`unknown rating definition: ${!a ? plan.filters.a : plan.filters.b}`);
      const res = await compareDefinitions(store, f.team, f.season!, a, b, f.side);
      if (!res) throw new Error(`no third-down data for ${f.team} ${f.season}`);
      const d = res.disagreement;
      return {
        package: {
          kind: "rating_compare",
          summary: { team: f.team, a: { name: a.name, score: res.a.snapshot.score, rank: res.a.rank }, b: { name: b.name, score: res.b.snapshot.score, rank: res.b.rank }, delta: d.delta, drivers: d.lines.slice(0, 4).map((l) => ({ metric: l.label, weight_a_pct: Math.round(l.weight_a * 100), weight_b_pct: Math.round(l.weight_b * 100), percentile: l.normalized === null ? null : Math.round(l.normalized * 100), points_delta: round(l.delta, 1) })) },
          calculation_ids: [res.a.snapshot.id, res.b.snapshot.id],
          calculation_hashes: [res.a.stored_hash, res.b.stored_hash],
          evidence_ids: res.a.analysis.evidence,
          deterministic_statements: [d.headline, ...d.lines.slice(0, 3).map((l) => l.sentence)],
        },
        detail: { disagreement: d, a: res.a.snapshot as RatingSnapshot, b: res.b.snapshot as RatingSnapshot },
      };
    }
    case "unsupported":
      return {
        package: { kind: "unsupported", summary: { reason: plan.reason }, calculation_ids: [], calculation_hashes: [], evidence_ids: [], deterministic_statements: [plan.reason ?? "CHALK does not have data to answer this."] },
        detail: { reason: plan.reason },
      };
  }
}

async function findRawByHash(store: ChalkStore, coll: string, hash: string, gameId: string): Promise<NedbRow<RawDoc> | null> {
  const rows = await store.query<RawDoc>(`FROM ${coll} WHERE source_record_id_game = ${nqlStr(gameId)}`);
  return rows.find((r) => r._hash === hash) ?? null;
}

function ordinal(n: number | null): string {
  if (n === null) return "?";
  return ["", "1st", "2nd", "3rd", "4th"][n] ?? `${n}th`;
}
