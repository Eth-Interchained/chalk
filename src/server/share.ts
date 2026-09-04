/*
 * SPDX-License-Identifier: BUSL-1.1
 * Copyright (c) 2026 Interchained LLC. All rights reserved.
 * CHALK / Sports-Rater — https://sports-rater.com — Licensor: Interchained LLC
 */
/**
 * The headline sharecard (v0.12.0). Two pure pieces:
 *   shareCopy()  — the words that go with the card: title, caption, canonical URL, preview image.
 *                  One source for the client caption, the OG tags and the social intents.
 *   injectOg()   — index.html with Open Graph / Twitter tags for a /s/TEAM landing, so a pasted
 *                  link previews the team's hero and the headline number. Crawlers cannot run
 *                  the SPA; they read these tags.
 * The PNG itself is drawn client-side on a canvas (hero + logo + numbers) — no raster deps here.
 */
import type { HomePayload } from "./home.ts";

export const TEAM_NAMES: Record<string, string> = {
  ARI: "Arizona Cardinals", ATL: "Atlanta Falcons", BAL: "Baltimore Ravens", BUF: "Buffalo Bills", CAR: "Carolina Panthers", CHI: "Chicago Bears", CIN: "Cincinnati Bengals", CLE: "Cleveland Browns",
  DAL: "Dallas Cowboys", DEN: "Denver Broncos", DET: "Detroit Lions", GB: "Green Bay Packers", HOU: "Houston Texans", IND: "Indianapolis Colts", JAX: "Jacksonville Jaguars", KC: "Kansas City Chiefs",
  LA: "Los Angeles Rams", LAR: "Los Angeles Rams", LAC: "Los Angeles Chargers", LV: "Las Vegas Raiders", MIA: "Miami Dolphins", MIN: "Minnesota Vikings", NE: "New England Patriots", NO: "New Orleans Saints",
  NYG: "New York Giants", NYJ: "New York Jets", PHI: "Philadelphia Eagles", PIT: "Pittsburgh Steelers", SEA: "Seattle Seahawks", SF: "San Francisco 49ers", TB: "Tampa Bay Buccaneers", TEN: "Tennessee Titans",
  WAS: "Washington Commanders", WSH: "Washington Commanders",
};
export const HEADLINE_LABELS: Record<string, [label: string, unit: string]> = {
  third_down: ["Third Down", "third downs"], offense: ["Offense", "plays"], defense: ["Defense", "plays faced"], red_zone: ["Red Zone", "red-zone plays"], explosiveness: ["Explosiveness", "plays"], ball_security: ["Ball Security", "plays"],
};

export interface ShareCopy {
  team: string;
  team_name: string;
  season: number;
  headline: string;
  label: string;
  score: number | null;
  rank: number | null;
  of: number | null;
  title: string;
  /** Caption for the post — numbers, provenance line, link. */
  text: string;
  url: string;
  image: string;
  hashtags: string[];
}

/** Pure. `base` has no trailing slash. Falls back to third down when the headline is unknown or missing from the payload. */
export function shareCopy(home: HomePayload, headline: string, base: string): ShareCopy {
  const hl = HEADLINE_LABELS[headline] ? headline : "third_down";
  const [label, unit] = HEADLINE_LABELS[hl];
  const team = home.team; const name = TEAM_NAMES[team] ?? team;
  let score: number | null = null, rank: number | null = null, of: number | null = null, sample: number | null = null, def: string | null = null;
  if (hl === "third_down" && home.rating) { score = home.rating.score; rank = home.rating.rank; of = home.rating.of; sample = home.rating.sample_size; def = home.rating.definition; }
  else { const r = home.ratings.find((x) => x.subject === hl); if (r) { score = r.score; rank = r.rank; of = r.of; sample = r.sample; def = r.definition_name; } }
  const sig = home.badges.find((b) => b.kind === "signature"); const heel = home.badges.find((b) => b.kind === "heel");
  // Badge names already carry their kind ("SIGNATURE · BALL SECURITY"); strip it so the caption does not say it twice.
  const trait = (b: { name: string }) => b.name.replace(/^(SIGNATURE|ACHILLES HEEL)\s*·\s*/i, "").replace(/\b([A-Z])([A-Z]+)\b/g, (_m, a: string, rest: string) => a + rest.toLowerCase());
  const url = `${base}/s/${team}?season=${home.season}${hl !== "third_down" ? `&headline=${hl}` : ""}`;
  const numbers = score === null ? `${label}: no ${home.season} rating yet` : `${label} ${score}/100 · #${rank} of ${of}${sample ? ` · ${sample} ${unit}` : ""}`;
  const traits = [sig ? `Signature: ${trait(sig)}` : null, heel ? `Achilles heel: ${trait(heel)}` : null].filter(Boolean).join(" · ");
  const title = `${team} ${numbers} — Sports-Rater`;
  const text = [`${name} ${home.season} — ${numbers}.`, traits || null, def ? `Formula: ${def}. Deterministic, every number traceable. Provenance proves.` : "Deterministic, every number traceable. Provenance proves.", url].filter(Boolean).join("\n");
  return { team, team_name: name, season: home.season, headline: hl, label, score, rank, of, title, text, url, image: `${base}/hero/${team}.jpg`, hashtags: ["SportsRater", "CHALK", team, "NFL"] };
}

const escAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Pure: index.html → landing HTML with OG/Twitter tags and the team's title. Idempotent on the tag block. */
export function injectOg(html: string, c: ShareCopy): string {
  const desc = c.text.split("\n").slice(0, 2).join(" ");
  const tags = [
    `<!-- sharecard:og -->`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="Sports-Rater · CHALK" />`,
    `<meta property="og:title" content="${escAttr(c.title)}" />`,
    `<meta property="og:description" content="${escAttr(desc)}" />`,
    `<meta property="og:url" content="${escAttr(c.url)}" />`,
    `<meta property="og:image" content="${escAttr(c.image)}" />`,
    `<meta property="og:image:alt" content="${escAttr(`${c.team_name} — ${c.label} ${c.score ?? "–"}/100`)}" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${escAttr(c.title)}" />`,
    `<meta name="twitter:description" content="${escAttr(desc)}" />`,
    `<meta name="twitter:image" content="${escAttr(c.image)}" />`,
    `<link rel="canonical" href="${escAttr(c.url)}" />`,
    `<!-- /sharecard:og -->`,
  ].join("\n");
  let out = html.replace(/<!-- sharecard:og -->[\s\S]*?<!-- \/sharecard:og -->\n?/, "");
  out = out.replace(/<title>[^<]*<\/title>/, `<title>${escAttr(c.title)}</title>`);
  return out.replace("</head>", `${tags}\n</head>`);
}

/** Public base URL for links in captions and OG tags: CHALK_PUBLIC_URL, else the request's forwarded host, else the fallback. */
export function publicBase(env: NodeJS.ProcessEnv, headers: Record<string, string | string[] | undefined>, fallback = "https://sports-rater.com"): string {
  if (env.CHALK_PUBLIC_URL) return env.CHALK_PUBLIC_URL.replace(/\/$/, "");
  const host = (headers["x-forwarded-host"] ?? headers.host) as string | undefined;
  if (!host) return fallback;
  const proto = ((headers["x-forwarded-proto"] as string | undefined) ?? "https").split(",")[0].trim();
  return `${proto}://${host.split(",")[0].trim()}`;
}
