/**
 * Badges (V3 §24) — deterministic, versioned, league-relative. Never invented
 * by the model. A badge is a qualification rule over the league population
 * (percentile thresholds on metrics CHALK already computes) plus the
 * evidence snapshot that qualified it.
 */
import type { MetricBundle } from "../engine/metrics.ts";
import { percentileRank } from "./normalize.ts";

export interface BadgeDefinition {
  id: string;
  version: string;
  name: string;
  emoji: string;
  /** Where the metric comes from. */
  source: "third_down" | "all_snaps";
  metric: keyof MetricBundle;
  /** "top" = percentile >= threshold; "bottom" = percentile <= threshold. */
  side: "top" | "bottom";
  /** Percentile threshold in [0,1]. */
  threshold: number;
  min_sample: number;
  description: string;
  tone: "good" | "bad";
}

export const BADGE_DEFINITIONS: BadgeDefinition[] = [
  { id: "third_down_monster", version: "1.0.0", name: "THIRD DOWN MONSTER", emoji: "🔥", source: "third_down", metric: "conversion_rate", side: "top", threshold: 0.9, min_sample: 60, description: "Top 10% third-down conversion rate", tone: "good" },
  { id: "third_down_problem", version: "1.0.0", name: "THIRD DOWN PROBLEM", emoji: "🚧", source: "third_down", metric: "conversion_rate", side: "bottom", threshold: 0.2, min_sample: 60, description: "Bottom 20% third-down conversion rate", tone: "bad" },
  { id: "money_down_epa", version: "1.0.0", name: "MONEY DOWN", emoji: "💰", source: "third_down", metric: "epa_per_play", side: "top", threshold: 0.9, min_sample: 60, description: "Top 10% EPA per play on third down", tone: "good" },
  { id: "explosive_offense", version: "1.0.0", name: "EXPLOSIVE OFFENSE", emoji: "💥", source: "all_snaps", metric: "explosive_rate", side: "top", threshold: 0.9, min_sample: 300, description: "Top 10% explosive-play rate (pass 20+, run 12+)", tone: "good" },
  { id: "ball_security", version: "1.0.0", name: "BALL SECURITY", emoji: "🔒", source: "all_snaps", metric: "turnover_rate", side: "bottom", threshold: 0.1, min_sample: 300, description: "Lowest 10% turnover rate per snap", tone: "good" },
  { id: "giveaway_machine", version: "1.0.0", name: "GIVEAWAY MACHINE", emoji: "🎁", source: "all_snaps", metric: "turnover_rate", side: "top", threshold: 0.9, min_sample: 300, description: "Top 10% turnover rate per snap", tone: "bad" },
  { id: "efficient_offense", version: "1.0.0", name: "EFFICIENT", emoji: "⚙️", source: "all_snaps", metric: "success_rate", side: "top", threshold: 0.9, min_sample: 300, description: "Top 10% success rate (EPA > 0) on all snaps", tone: "good" },
  { id: "stalling_offense", version: "1.0.0", name: "STALLING", emoji: "🧱", source: "all_snaps", metric: "success_rate", side: "bottom", threshold: 0.15, min_sample: 300, description: "Bottom 15% success rate on all snaps", tone: "bad" },
  // Tier 2 (top/bottom quarter). A team that also clears the tier-1 threshold on
  // the same metric+side gets only the tier-1 badge (see evaluateBadges dedupe).
  { id: "converts", version: "1.0.0", name: "CONVERTS", emoji: "⛓️", source: "third_down", metric: "conversion_rate", side: "top", threshold: 0.75, min_sample: 60, description: "Top quarter third-down conversion rate", tone: "good" },
  { id: "stalls_on_third", version: "1.0.0", name: "STALLS ON THIRD", emoji: "⏸️", source: "third_down", metric: "conversion_rate", side: "bottom", threshold: 0.25, min_sample: 60, description: "Bottom quarter third-down conversion rate", tone: "bad" },
  { id: "positive_plays", version: "1.0.0", name: "POSITIVE PLAYS", emoji: "📈", source: "all_snaps", metric: "epa_per_play", side: "top", threshold: 0.75, min_sample: 300, description: "Top quarter EPA per play on all snaps", tone: "good" },
  { id: "negative_plays", version: "1.0.0", name: "NEGATIVE PLAYS", emoji: "📉", source: "all_snaps", metric: "epa_per_play", side: "bottom", threshold: 0.25, min_sample: 300, description: "Bottom quarter EPA per play on all snaps", tone: "bad" },
  { id: "big_play_threat", version: "1.0.0", name: "BIG PLAY THREAT", emoji: "🚀", source: "all_snaps", metric: "explosive_rate", side: "top", threshold: 0.75, min_sample: 300, description: "Top quarter explosive-play rate", tone: "good" },
  { id: "dink_and_dunk", version: "1.0.0", name: "DINK AND DUNK", emoji: "🩹", source: "all_snaps", metric: "explosive_rate", side: "bottom", threshold: 0.25, min_sample: 300, description: "Bottom quarter explosive-play rate", tone: "bad" },
  { id: "protects_the_ball", version: "1.0.0", name: "PROTECTS THE BALL", emoji: "🧤", source: "all_snaps", metric: "turnover_rate", side: "bottom", threshold: 0.25, min_sample: 300, description: "Lowest quarter turnover rate per snap", tone: "good" },
  { id: "loose_ball", version: "1.0.0", name: "LOOSE BALL", emoji: "🫳", source: "all_snaps", metric: "turnover_rate", side: "top", threshold: 0.75, min_sample: 300, description: "Highest quarter turnover rate per snap", tone: "bad" },
  { id: "steady", version: "1.0.0", name: "STEADY", emoji: "🎯", source: "all_snaps", metric: "success_rate", side: "top", threshold: 0.75, min_sample: 300, description: "Top quarter success rate on all snaps", tone: "good" },
  { id: "inconsistent", version: "1.0.0", name: "INCONSISTENT", emoji: "🎲", source: "all_snaps", metric: "success_rate", side: "bottom", threshold: 0.25, min_sample: 300, description: "Bottom quarter success rate on all snaps", tone: "bad" },
];

/**
 * Identity badges — every team with enough snaps earns exactly two, no matter
 * where it sits in the league: SIGNATURE (its best trait relative to the
 * league) and ACHILLES HEEL (its worst). Percentiles are oriented so higher is
 * always better, then the max/min traits are named. Same population, same
 * evidence, same qualification text as tier badges — nothing is invented.
 */
/** Metrics where a LOWER value is the good direction. */
export const LOWER_IS_BETTER: ReadonlySet<keyof MetricBundle> = new Set<keyof MetricBundle>(["turnover_rate"]);
export const IDENTITY_VERSION = "1.0.0";
export const IDENTITY_TRAITS: Array<{ source: BadgeDefinition["source"]; metric: keyof MetricBundle; label: string; higher_is_better: boolean; min_sample: number }> = [
  { source: "all_snaps", metric: "epa_per_play", label: "EPA / PLAY", higher_is_better: true, min_sample: 300 },
  { source: "all_snaps", metric: "success_rate", label: "SUCCESS RATE", higher_is_better: true, min_sample: 300 },
  { source: "all_snaps", metric: "explosive_rate", label: "EXPLOSIVENESS", higher_is_better: true, min_sample: 300 },
  { source: "all_snaps", metric: "turnover_rate", label: "BALL SECURITY", higher_is_better: false, min_sample: 300 },
  { source: "third_down", metric: "conversion_rate", label: "THIRD DOWN", higher_is_better: true, min_sample: 60 },
];

export interface EarnedBadge {
  id: string;
  version: string;
  /** tier = threshold badge (elite/strong); signature/heel = the team's best/worst trait, always awarded. */
  kind: "tier" | "signature" | "heel";
  name: string;
  emoji: string;
  tone: "good" | "bad";
  description: string;
  metric: string;
  value: number | null;
  percentile: number | null;
  rank: number;
  of: number;
  sample: number;
  qualification_rule: string;
}

export interface BadgePopulationMember {
  key: string;
  third_down: MetricBundle | null;
  all_snaps: MetricBundle | null;
}

export function evaluateBadges(team: string, population: readonly BadgePopulationMember[]): EarnedBadge[] {
  const subject = population.find((m) => m.key === team);
  if (!subject) return [];
  const earned: EarnedBadge[] = [];
  for (const def of BADGE_DEFINITIONS) {
    const bundle = subject[def.source];
    if (!bundle || bundle.attempts < def.min_sample) continue;
    const value = bundle[def.metric] as number | null;
    if (value === null) continue;
    const pop = population
      .map((m) => m[def.source])
      .filter((b): b is MetricBundle => Boolean(b) && (b as MetricBundle).attempts >= def.min_sample)
      .map((b) => b[def.metric] as number | null)
      .filter((v): v is number => v !== null);
    if (pop.length < 8) continue; // a badge over a tiny league means nothing
    const p = percentileRank(value, pop);
    if (p === null) continue;
    const ok = def.side === "top" ? p >= def.threshold : p <= def.threshold;
    if (!ok) continue;
    const better = def.side === "top" ? pop.filter((v) => v > value).length : pop.filter((v) => v < value).length;
    // Percentile is reported "higher is better" everywhere a fan sees it: for
    // metrics where lower is good (turnover rate) the raw percentile is flipped.
    const oriented = LOWER_IS_BETTER.has(def.metric) ? 1 - p : p;
    earned.push({
      id: def.id,
      version: def.version,
      kind: "tier",
      name: def.name,
      emoji: def.emoji,
      tone: def.tone,
      description: def.description,
      metric: def.metric,
      value,
      percentile: Math.round(oriented * 100),
      rank: better + 1,
      of: pop.length,
      sample: bundle.attempts,
      qualification_rule: `${def.metric} percentile ${def.side === "top" ? ">=" : "<="} ${def.threshold * 100} among teams with >= ${def.min_sample} ${def.source === "third_down" ? "third downs" : "snaps"}`,
    });
  }
  // One badge per metric+side: keep the more extreme threshold (tier 1 over tier 2).
  const byKey = new Map<string, EarnedBadge>();
  for (const b of earned) {
    const def = BADGE_DEFINITIONS.find((d) => d.id === b.id)!;
    const k = `${def.source}:${def.metric}:${def.side}`;
    const cur = byKey.get(k);
    if (!cur) { byKey.set(k, b); continue; }
    const curDef = BADGE_DEFINITIONS.find((d) => d.id === cur.id)!;
    const moreExtreme = def.side === "top" ? def.threshold > curDef.threshold : def.threshold < curDef.threshold;
    if (moreExtreme) byKey.set(k, b);
  }
  const tiers = [...byKey.values()];

  // Identity badges: best and worst trait, oriented so higher percentile = better.
  const traits: Array<{ t: (typeof IDENTITY_TRAITS)[number]; value: number; p: number; rank: number; of: number; sample: number }> = [];
  for (const t of IDENTITY_TRAITS) {
    const bundle = subject[t.source];
    if (!bundle || bundle.attempts < t.min_sample) continue;
    const value = bundle[t.metric] as number | null;
    if (value === null) continue;
    const pop = population
      .map((m) => m[t.source])
      .filter((b): b is MetricBundle => Boolean(b) && (b as MetricBundle).attempts >= t.min_sample)
      .map((b) => b[t.metric] as number | null)
      .filter((v): v is number => v !== null);
    if (pop.length < 8) continue;
    const raw = percentileRank(value, pop);
    if (raw === null) continue;
    const p = t.higher_is_better ? raw : 1 - raw;
    const better = t.higher_is_better ? pop.filter((v) => v > value).length : pop.filter((v) => v < value).length;
    traits.push({ t, value, p, rank: better + 1, of: pop.length, sample: bundle.attempts });
  }
  const identity: EarnedBadge[] = [];
  if (traits.length >= 2) {
    // Stable: ties resolve by IDENTITY_TRAITS order, so best and worst are always different traits.
    const sorted = [...traits].sort((a, b) => b.p - a.p || IDENTITY_TRAITS.indexOf(a.t) - IDENTITY_TRAITS.indexOf(b.t));
    const best = sorted[0], worst = sorted[sorted.length - 1];
    {
      const mk = (x: typeof best, kind: "signature" | "heel"): EarnedBadge => ({
        id: `${kind}_${x.t.metric}`,
        version: IDENTITY_VERSION,
        kind,
        name: `${kind === "signature" ? "SIGNATURE" : "ACHILLES HEEL"} · ${x.t.label}`,
        emoji: kind === "signature" ? "🏷️" : "🩻",
        tone: kind === "signature" ? "good" : "bad",
        description: kind === "signature" ? `The team's best trait relative to the league: ${x.t.label.toLowerCase()} at the ${Math.round(x.p * 100)}th percentile` : `The team's weakest trait relative to the league: ${x.t.label.toLowerCase()} at the ${Math.round(x.p * 100)}th percentile`,
        metric: x.t.metric,
        value: x.value,
        percentile: Math.round(x.p * 100),
        rank: x.rank,
        of: x.of,
        sample: x.sample,
        qualification_rule: `${kind === "signature" ? "highest" : "lowest"} oriented percentile among ${traits.length} traits (${IDENTITY_TRAITS.map((q) => q.metric).join(", ")}) over teams with the minimum sample`,
      });
      identity.push(mk(best, "signature"), mk(worst, "heel"));
    }
  }
  return [...tiers, ...identity];
}
