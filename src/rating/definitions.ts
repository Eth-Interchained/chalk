/**
 * Rating definitions — versioned data, never hidden (spec §15).
 *
 * A definition is a weighted list of components. Each component names a
 * metric produced by a deterministic analysis, a weight, and a direction
 * (whether higher raw values are better). Weights are normalized at compute
 * time so a user can type "30 / 25 / 20" without summing to 1.
 *
 * The first production formula and WHY:
 *   Third Down Rating v1
 *     conversion_rate  0.50  The outcome that decides drives. Highest weight
 *                            because it is the number a coach is judged on.
 *     epa_per_play     0.30  Conversion is binary; EPA credits a 3rd-and-8
 *                            gain of 25 more than a 3rd-and-1 plunge. Captures
 *                            magnitude conversion rate cannot.
 *     success_rate     0.20  Down-weighted because on third down success
 *                            (epa > 0) and conversion overlap heavily; it
 *                            mostly adds signal on incomplete-but-positive
 *                            plays and penalties.
 *   Normalization: percentile rank against the league population for the same
 *   scope (team-season), so 82 means "better than 82% of the league's
 *   third-down units" — not an absolute.
 */
export type Direction = "higher_is_better" | "lower_is_better";

export interface RatingComponent {
  /** Metric key on the analysis' MetricBundle (e.g. conversion_rate). */
  metric: string;
  weight: number;
  direction: Direction;
  label: string;
}

export interface RatingDefinition {
  id: string;
  name: string;
  version: string;
  /** Which analysis kind supplies the metrics. */
  subject: "third_down";
  components: RatingComponent[];
  normalization: "percentile_rank";
  normalization_version: string;
  /** Minimum sample (attempts) below which the rating is reported as provisional. */
  min_sample: number;
  author: string;
  created_at: string;
  notes?: string;
  /** For user-defined profiles: the definition this was derived from. */
  derived_from?: string;
}

export const PERCENTILE_RANK_VERSION = "1.0.0";

export const THIRD_DOWN_DEFAULT_V1: RatingDefinition = {
  id: "third_down_default@1.0.0",
  name: "Sports-Rater Third Down",
  version: "1.0.0",
  subject: "third_down",
  components: [
    { metric: "conversion_rate", weight: 0.5, direction: "higher_is_better", label: "Conversion rate" },
    { metric: "epa_per_play", weight: 0.3, direction: "higher_is_better", label: "EPA / play" },
    { metric: "success_rate", weight: 0.2, direction: "higher_is_better", label: "Success rate" },
  ],
  normalization: "percentile_rank",
  normalization_version: PERCENTILE_RANK_VERSION,
  min_sample: 25,
  author: "sports-rater",
  created_at: "2026-09-03T00:00:00Z",
  notes:
    "Conversion carries half the weight because it decides drives; EPA adds magnitude a binary conversion cannot; success rate is down-weighted because it overlaps conversion on third down.",
};

/**
 * A second, deliberately different philosophy over the SAME evidence — proves
 * the architecture (spec §34) and seeds the "rate differently" flow.
 * "Explosive-first": a coach who cares about chunk plays and ball security on
 * third down more than the conversion checkbox.
 */
export const THIRD_DOWN_EXPLOSIVE_V1: RatingDefinition = {
  id: "third_down_explosive@1.0.0",
  name: "Explosive & Clean",
  version: "1.0.0",
  subject: "third_down",
  components: [
    { metric: "epa_per_play", weight: 0.4, direction: "higher_is_better", label: "EPA / play" },
    { metric: "explosive_rate", weight: 0.25, direction: "higher_is_better", label: "Explosive rate" },
    { metric: "turnover_rate", weight: 0.2, direction: "lower_is_better", label: "Turnover rate" },
    { metric: "conversion_rate", weight: 0.15, direction: "higher_is_better", label: "Conversion rate" },
  ],
  normalization: "percentile_rank",
  normalization_version: PERCENTILE_RANK_VERSION,
  min_sample: 25,
  author: "sports-rater",
  created_at: "2026-09-03T00:00:00Z",
  notes: "Rewards chunk plays and punishes giveaways; treats the conversion checkbox as secondary.",
};

export const BUILTIN_DEFINITIONS: RatingDefinition[] = [THIRD_DOWN_DEFAULT_V1, THIRD_DOWN_EXPLOSIVE_V1];

export const RATEABLE_METRICS: Record<string, { label: string; default_direction: Direction }> = {
  conversion_rate: { label: "Conversion rate", default_direction: "higher_is_better" },
  epa_per_play: { label: "EPA / play", default_direction: "higher_is_better" },
  success_rate: { label: "Success rate", default_direction: "higher_is_better" },
  yards_per_play: { label: "Yards / play", default_direction: "higher_is_better" },
  explosive_rate: { label: "Explosive rate", default_direction: "higher_is_better" },
  turnover_rate: { label: "Turnover rate", default_direction: "lower_is_better" },
  touchdown_rate: { label: "Touchdown rate", default_direction: "higher_is_better" },
  pass_rate: { label: "Pass rate", default_direction: "higher_is_better" },
};

export interface DefinitionValidation {
  ok: boolean;
  definition?: RatingDefinition;
  errors: string[];
}

/** Validate a user-supplied definition (custom profile). Weights are normalized. */
export function validateDefinition(input: unknown, now = new Date().toISOString()): DefinitionValidation {
  const errors: string[] = [];
  if (!input || typeof input !== "object") return { ok: false, errors: ["definition must be an object"] };
  const o = input as Record<string, unknown>;
  const name = typeof o.name === "string" && o.name.trim() ? o.name.trim().slice(0, 80) : null;
  if (!name) errors.push("name: required");
  const version = typeof o.version === "string" && /^\d+\.\d+\.\d+$/.test(o.version) ? o.version : "1.0.0";
  const subject = o.subject ?? "third_down";
  if (subject !== "third_down") errors.push("subject: only third_down is rateable today");
  const comps = Array.isArray(o.components) ? o.components : null;
  if (!comps || comps.length === 0) errors.push("components: non-empty array required");
  const components: RatingComponent[] = [];
  let total = 0;
  const seen = new Set<string>();
  for (const c of comps ?? []) {
    if (!c || typeof c !== "object") { errors.push("component: object required"); continue; }
    const cc = c as Record<string, unknown>;
    const metric = typeof cc.metric === "string" ? cc.metric : "";
    if (!(metric in RATEABLE_METRICS)) { errors.push(`component.metric: unknown ${JSON.stringify(metric)}; allowed ${Object.keys(RATEABLE_METRICS).join(", ")}`); continue; }
    if (seen.has(metric)) { errors.push(`component.metric: duplicate ${metric}`); continue; }
    seen.add(metric);
    const weight = typeof cc.weight === "number" && Number.isFinite(cc.weight) && cc.weight > 0 ? cc.weight : NaN;
    if (Number.isNaN(weight)) { errors.push(`component ${metric}: weight must be a positive number`); continue; }
    const direction =
      cc.direction === "higher_is_better" || cc.direction === "lower_is_better"
        ? cc.direction
        : RATEABLE_METRICS[metric].default_direction;
    components.push({ metric, weight, direction, label: RATEABLE_METRICS[metric].label });
    total += weight;
  }
  if (errors.length) return { ok: false, errors };
  for (const c of components) c.weight = c.weight / total;
  const slug = name!.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  const min_sample = typeof o.min_sample === "number" && Number.isInteger(o.min_sample) && o.min_sample >= 0 ? o.min_sample : 25;
  const def: RatingDefinition = {
    id: typeof o.id === "string" && /^[a-z0-9_@.\-]+$/.test(o.id) ? o.id : `custom_${slug}@${version}`,
    name: name!,
    version,
    subject: "third_down",
    components,
    normalization: "percentile_rank",
    normalization_version: PERCENTILE_RANK_VERSION,
    min_sample,
    author: typeof o.author === "string" ? o.author.slice(0, 80) : "user",
    created_at: now,
  };
  if (typeof o.notes === "string") def.notes = o.notes.slice(0, 500);
  if (typeof o.derived_from === "string") def.derived_from = o.derived_from;
  return { ok: true, definition: def, errors: [] };
}
