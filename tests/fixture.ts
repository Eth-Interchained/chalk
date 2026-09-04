/*
 * SPDX-License-Identifier: BUSL-1.1
 * Copyright (c) 2026 Interchained LLC. All rights reserved.
 * CHALK / Sports-Rater — https://sports-rater.com — Licensor: Interchained LLC
 */
/**
 * Frozen real-game fixture: 2025_18_CAR_TB (Carolina at Tampa Bay, 2026-01-03,
 * TB 16 – CAR 14), 159 plays exactly as api.nfldata.org returned them on
 * 2026-09-03. Ground truth asserted in tests:
 *   TB third downs (pass/run, excl. no_play): 15 attempts, 8 conversions
 *   TB third-and-long (7+): 7 attempts, 2 conversions
 *   TB third-and-short (1-3): 3 attempts, 3 conversions
 *   CAR third downs: 8 attempts, 1 conversion
 * Verified by hand against the raw rows before being frozen.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeNflDataGame, normalizeNflDataPlay } from "../src/ingest/normalize.ts";
import { hashPayload } from "../src/store/hash.ts";
import type { Game, Play } from "../src/model/football.ts";
import type { NedbRow } from "../src/store/nedb.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURE_GAME_ID = "2025_18_CAR_TB";

export function rawGame(): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(here, "fixtures/game_2025_18_CAR_TB.json"), "utf8"));
}
export function rawPlays(): Record<string, unknown>[] {
  return JSON.parse(readFileSync(path.join(here, "fixtures/plays_2025_18_CAR_TB.json"), "utf8")).data;
}
export function fixtureGame(): Game {
  return normalizeNflDataGame(rawGame(), "fixture-game-hash", "2026-09-03T00:00:00Z");
}
/** Normalized plays wrapped as NEDB rows with deterministic pseudo-hashes. */
export function fixtureRows(): NedbRow<Play>[] {
  const game = fixtureGame();
  return rawPlays().map((p) => {
    const h = hashPayload(p);
    const d = normalizeNflDataPlay(p, `raw-${h.slice(0, 12)}`, game, "2026-09-03T00:00:00Z");
    return { _id: d.id, _hash: `norm-${h.slice(0, 12)}`, _seq: 0, _coll: "football_plays", data: d };
  });
}
export const AT = { seq: 1, head: "fixture-head" };
