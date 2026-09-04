/*
 * SPDX-License-Identifier: BUSL-1.1
 * Copyright (c) 2026 Interchained LLC. All rights reserved.
 * CHALK / Sports-Rater — https://sports-rater.com — Licensor: Interchained LLC
 */
/**
 * Data licensing registry (V3 §15) — CHALK knows where every dataset came
 * from and what we may do with it. Reviewed by a human; dates are explicit.
 * Served at /api/v1/meta so the boundary is visible, not buried.
 */
export interface DatasetLicense {
  provider: string;
  dataset: string;
  endpoints: string[];
  license: string;
  commercial_use: "unknown" | "prototype_only" | "permitted" | "prohibited";
  redistribution: "unknown" | "prohibited" | "attribution_required" | "permitted";
  retention: string;
  attribution: string | null;
  last_reviewed: string;
  notes: string;
}

export const LICENSING: DatasetLicense[] = [
  {
    provider: "nfldata",
    dataset: "nflverse gold layer via api.nfldata.org",
    endpoints: ["/v1/games", "/v1/plays", "/v1/participation", "/v1/charting", "/v1/players", "/v1/stats/*"],
    license: "Public read-only API; underlying nflverse data is community-maintained (nflverse: CC-BY-4.0 for data packages, code MIT). API terms not published at /docs — treat as unknown until reviewed.",
    commercial_use: "prototype_only",
    redistribution: "attribution_required",
    retention: "Raw observations retained indefinitely in NEDB as immutable history (provenance requirement).",
    attribution: "Data: nflverse via NFLData.org",
    last_reviewed: "2026-09-03",
    notes: "Cadence: daily-ish (health.last_refresh 2026-09-01 on 2026-09-03). NOT a live source. Throttles with HTTP 403 under burst load.",
  },
  {
    provider: "thesportsdb",
    dataset: "TheSportsDB NFL events / scores / livescore",
    endpoints: ["eventsnextleague", "eventspastleague", "lookupevent", "livescore (Premium v2)"],
    license: "Free tier for non-commercial/testing with test key; Premium subscription (~$9/mo) for livescore and higher limits. Commercial redistribution not included.",
    commercial_use: "prototype_only",
    redistribution: "prohibited",
    retention: "Pulse observations retained as immutable NEDB rows; display near-live state only, never republish bulk feeds.",
    attribution: "Live scores: TheSportsDB",
    last_reviewed: "2026-09-03",
    notes: "Pulse v1 experiment dependency. Replace with a licensed professional provider before any commercial deployment.",
  },
];
