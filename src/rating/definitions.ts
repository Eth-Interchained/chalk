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

export type RatingSubject = "third_down" | "offense" | "red_zone" | "explosiveness" | "ball_security" | "defense";
export const RATING_SUBJECTS: readonly RatingSubject[] = ["offense", "third_down", "red_zone", "explosiveness", "ball_security", "defense"];

export interface RatingDefinition {
  id: string;
  name: string;
  version: string;
  /** Which metric surface supplies the components (see rating/subjects.ts). */
  subject: RatingSubject;
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

/**
 * Offense Default v1 — the spec's placeholder weights (V2 §15), kept because
 * they read like a coach's priorities: efficiency first, then chunk plays, then
 * the two situational units, then giveaways. All league-relative percentiles.
 */
export const OFFENSE_DEFAULT_V1: RatingDefinition = {
  id: "offense_default@1.0.0",
  name: "Sports-Rater Offense",
  version: "1.0.0",
  subject: "offense",
  components: [
    { metric: "epa_per_play", weight: 0.3, direction: "higher_is_better", label: "EPA / play" },
    { metric: "success_rate", weight: 0.2, direction: "higher_is_better", label: "Success rate" },
    { metric: "explosive_rate", weight: 0.15, direction: "higher_is_better", label: "Explosive rate" },
    { metric: "third_down_conversion_rate", weight: 0.15, direction: "higher_is_better", label: "Third down" },
    { metric: "red_zone_touchdown_rate", weight: 0.1, direction: "higher_is_better", label: "Red zone TD rate" },
    { metric: "turnover_rate", weight: 0.1, direction: "lower_is_better", label: "Turnover rate" },
  ],
  normalization: "percentile_rank",
  normalization_version: PERCENTILE_RANK_VERSION,
  min_sample: 300,
  author: "sports-rater",
  created_at: "2026-09-04T00:00:00Z",
  notes: "EPA and success carry half the weight because they price every snap; explosive plays and the two situational units add what averages hide; turnovers are the tax.",
};

export const RED_ZONE_DEFAULT_V1: RatingDefinition = {
  id: "red_zone_default@1.0.0",
  name: "Sports-Rater Red Zone",
  version: "1.0.0",
  subject: "red_zone",
  components: [
    { metric: "red_zone_touchdown_rate", weight: 0.5, direction: "higher_is_better", label: "TD rate per snap" },
    { metric: "red_zone_epa_per_play", weight: 0.3, direction: "higher_is_better", label: "EPA / play" },
    { metric: "red_zone_success_rate", weight: 0.2, direction: "higher_is_better", label: "Success rate" },
  ],
  normalization: "percentile_rank",
  normalization_version: PERCENTILE_RANK_VERSION,
  min_sample: 40,
  author: "sports-rater",
  created_at: "2026-09-04T00:00:00Z",
  notes: "Touchdowns are the point of the red zone; EPA and success keep a team honest that stalls to field goals.",
};

export const EXPLOSIVENESS_V1: RatingDefinition = {
  id: "explosiveness@1.0.0",
  name: "Explosiveness",
  version: "1.0.0",
  subject: "explosiveness",
  components: [{ metric: "explosive_rate", weight: 1, direction: "higher_is_better", label: "Explosive rate (pass 20+, run 12+)" }],
  normalization: "percentile_rank",
  normalization_version: PERCENTILE_RANK_VERSION,
  min_sample: 300,
  author: "sports-rater",
  created_at: "2026-09-04T00:00:00Z",
};

export const BALL_SECURITY_V1: RatingDefinition = {
  id: "ball_security@1.0.0",
  name: "Ball Security",
  version: "1.0.0",
  subject: "ball_security",
  components: [{ metric: "turnover_rate", weight: 1, direction: "lower_is_better", label: "Turnovers per snap" }],
  normalization: "percentile_rank",
  normalization_version: PERCENTILE_RANK_VERSION,
  min_sample: 300,
  author: "sports-rater",
  created_at: "2026-09-04T00:00:00Z",
};

/** Defense: the offense surface over plays the team defended, directions flipped. */
export const DEFENSE_DEFAULT_V1: RatingDefinition = {
  id: "defense_default@1.0.0",
  name: "Sports-Rater Defense",
  version: "1.0.0",
  subject: "defense",
  components: [
    { metric: "epa_per_play", weight: 0.3, direction: "lower_is_better", label: "EPA / play allowed" },
    { metric: "success_rate", weight: 0.2, direction: "lower_is_better", label: "Success rate allowed" },
    { metric: "explosive_rate", weight: 0.15, direction: "lower_is_better", label: "Explosive rate allowed" },
    { metric: "third_down_conversion_rate", weight: 0.15, direction: "lower_is_better", label: "Third down allowed" },
    { metric: "red_zone_touchdown_rate", weight: 0.1, direction: "lower_is_better", label: "Red zone TD rate allowed" },
    { metric: "turnover_rate", weight: 0.1, direction: "higher_is_better", label: "Takeaway rate" },
  ],
  normalization: "percentile_rank",
  normalization_version: PERCENTILE_RANK_VERSION,
  min_sample: 300,
  author: "sports-rater",
  created_at: "2026-09-04T00:00:00Z",
  notes: "Mirror of the offense formula over the snaps this defense faced.",
};

export const BUILTIN_DEFINITIONS: RatingDefinition[] = [
  OFFENSE_DEFAULT_V1, THIRD_DOWN_DEFAULT_V1, THIRD_DOWN_EXPLOSIVE_V1, RED_ZONE_DEFAULT_V1, EXPLOSIVENESS_V1, BALL_SECURITY_V1, DEFENSE_DEFAULT_V1,
];

/** The card order for the Home rating list: one built-in per subject. */
export const CARD_SUBJECTS: Array<{ subject: RatingSubject; definition: RatingDefinition; label: string }> = [
  { subject: "offense", definition: OFFENSE_DEFAULT_V1, label: "Offense" },
  { subject: "defense", definition: DEFENSE_DEFAULT_V1, label: "Defense" },
  { subject: "third_down", definition: THIRD_DOWN_DEFAULT_V1, label: "Third Down" },
  { subject: "red_zone", definition: RED_ZONE_DEFAULT_V1, label: "Red Zone" },
  { subject: "explosiveness", definition: EXPLOSIVENESS_V1, label: "Explosiveness" },
  { subject: "ball_security", definition: BALL_SECURITY_V1, label: "Ball Security" },
];

export const RATEABLE_METRICS: Record<string, { label: string; default_direction: Direction; subjects: RatingSubject[] }> = {
  conversion_rate: { label: "Conversion rate", default_direction: "higher_is_better", subjects: ["third_down"] },
  epa_per_play: { label: "EPA / play", default_direction: "higher_is_better", subjects: ["third_down", "offense", "defense", "explosiveness", "ball_security"] },
  success_rate: { label: "Success rate", default_direction: "higher_is_better", subjects: ["third_down", "offense", "defense"] },
  yards_per_play: { label: "Yards / play", default_direction: "higher_is_better", subjects: ["third_down", "offense", "defense"] },
  explosive_rate: { label: "Explosive rate", default_direction: "higher_is_better", subjects: ["third_down", "offense", "defense", "explosiveness"] },
  turnover_rate: { label: "Turnover rate", default_direction: "lower_is_better", subjects: ["third_down", "offense", "defense", "ball_security"] },
  touchdown_rate: { label: "Touchdown rate", default_direction: "higher_is_better", subjects: ["third_down", "offense", "defense"] },
  pass_rate: { label: "Pass rate", default_direction: "higher_is_better", subjects: ["third_down", "offense", "defense"] },
  third_down_conversion_rate: { label: "Third-down conversion", default_direction: "higher_is_better", subjects: ["offense", "defense"] },
  third_down_epa_per_play: { label: "Third-down EPA / play", default_direction: "higher_is_better", subjects: ["offense", "defense"] },
  red_zone_touchdown_rate: { label: "Red-zone TD rate", default_direction: "higher_is_better", subjects: ["offense", "defense", "red_zone"] },
  red_zone_epa_per_play: { label: "Red-zone EPA / play", default_direction: "higher_is_better", subjects: ["offense", "defense", "red_zone"] },
  red_zone_success_rate: { label: "Red-zone success", default_direction: "higher_is_better", subjects: ["offense", "defense", "red_zone"] },
  points_per_game: { label: "Points per game", default_direction: "higher_is_better", subjects: ["offense", "defense"] },
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
  const subject = (o.subject ?? "third_down") as RatingSubject;
  if (!RATING_SUBJECTS.includes(subject)) errors.push(`subject: one of ${RATING_SUBJECTS.join("|")}`);
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
    if (RATING_SUBJECTS.includes(subject) && !RATEABLE_METRICS[metric].subjects.includes(subject)) { errors.push(`component.metric: ${metric} is not available on subject ${subject}`); continue; }
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
  const defaultMin = subject === "third_down" ? 25 : subject === "red_zone" ? 40 : 300;
  const min_sample = typeof o.min_sample === "number" && Number.isInteger(o.min_sample) && o.min_sample >= 0 ? o.min_sample : defaultMin;
  const def: RatingDefinition = {
    id: typeof o.id === "string" && /^[a-z0-9_@.\-]+$/.test(o.id) ? o.id : `custom_${slug}@${version}`,
    name: name!,
    version,
    subject,
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
