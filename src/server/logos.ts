/**
 * Team logo configuration surfaced to the client via /api/v1/meta.
 *
 * Sports-Rater sells nothing and claims no affiliation; team marks are used
 * for identification only, with the disclaimer below rendered in the site
 * footer. Logos are hot-linked from a public CDN by default (nothing is
 * redistributed from this repo) and the whole feature is one env flip away
 * from off: CHALK_TEAM_LOGOS=0. The client falls back to the team wordmark
 * whenever an image fails to load.
 */
export interface TeamLogoConfig {
  enabled: boolean;
  /** `{abbr}` is replaced with the lowercased, provider-mapped abbreviation. */
  url_template: string;
  /** NFLData abbreviations that differ from the logo provider's. */
  abbr_map: Record<string, string>;
  disclaimer: string;
}

export const DEFAULT_LOGO_TEMPLATE = "https://a.espncdn.com/i/teamlogos/nfl/500/{abbr}.png";

/** nflverse/NFLData abbreviations → ESPN CDN file names where they differ. */
export const ESPN_ABBR_MAP: Record<string, string> = { WAS: "wsh", LA: "lar", JAX: "jax", LAR: "lar" };

export const LOGO_DISCLAIMER =
  "Team names, logos and marks are trademarks of the National Football League and its member clubs, shown here for identification only. " +
  "Sports-Rater / CHALK is an independent fan project — not affiliated with, endorsed by, or sponsored by the NFL or any team. Nothing is sold here.";

export function logoConfig(env: NodeJS.ProcessEnv = process.env): TeamLogoConfig {
  return {
    enabled: env.CHALK_TEAM_LOGOS !== "0",
    url_template: env.CHALK_TEAM_LOGO_URL || DEFAULT_LOGO_TEMPLATE,
    abbr_map: ESPN_ABBR_MAP,
    disclaimer: LOGO_DISCLAIMER,
  };
}

/** Pure resolver — the client runs the identical logic from the meta payload. */
export function logoUrl(cfg: TeamLogoConfig, abbr: string | null | undefined): string | null {
  if (!cfg.enabled || !abbr) return null;
  const a = abbr.toUpperCase();
  if (!/^[A-Z]{2,3}$/.test(a)) return null;
  return cfg.url_template.replace("{abbr}", (cfg.abbr_map[a] ?? a).toLowerCase());
}
