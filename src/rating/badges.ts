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
];

export interface EarnedBadge {
  id: string;
  version: string;
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
    earned.push({
      id: def.id,
      version: def.version,
      name: def.name,
      emoji: def.emoji,
      tone: def.tone,
      description: def.description,
      metric: def.metric,
      value,
      percentile: Math.round(p * 100),
      rank: better + 1,
      of: pop.length,
      sample: bundle.attempts,
      qualification_rule: `${def.metric} percentile ${def.side === "top" ? ">=" : "<="} ${def.threshold * 100} among teams with >= ${def.min_sample} ${def.source === "third_down" ? "third downs" : "snaps"}`,
    });
  }
  return earned;
}
