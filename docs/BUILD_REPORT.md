# CHALK — Build Report

Living document. Newest entry first. Sections: SHIPPED · IN PROGRESS · DISCOVERED · BLOCKED · NEXT.

---

## 2026-09-03 — v0.1.0 · first vertical slice, end to end on real data

### SHIPPED

- **Truth path.** NFLData adapter (verified against the live OpenAPI 3.1 contract; snapshot in `docs/nfldata-openapi-2026-09-03.json`) → immutable raw rows → normalized plays/games with `derived_from` lineage → NEDB. Full **2025 league ingested: 285 games, 48,771 plays** (exactly NFLData's advertised total), 0 errors, `seq 98,145`. A second run over the same season wrote **0 new plays, 37,981 duplicates skipped**, proving idempotency at scale.
- **Deterministic engines.** Situation filter (validate → coarse NQL → fine filter), metrics with a sample-size ladder, third-down analysis, tendency vs baseline, A/B comparison, 30-bucket situation scan, season-vs-game deviation (z on binomial SE / EPA SD).
- **Rating engine.** Versioned definitions (`third_down_default@1.0.0`, `third_down_explosive@1.0.0`), percentile-rank normalization v1.0.0, snapshots recording population/weights/raw/normalized/points, custom profiles via `POST /rating-definitions`, deterministic disagreement explainer.
- **LLM layer.** GLM-4-32B via AiAS PIN (Mark's call). Planner with sentinel-block output, validation, and a rule fallback; streaming explainer with inactivity-only deadline; observations stored `caused_by` the calculations.
- **Pulse v1.** `PulseSource` contract, TheSportsDB adapter (free test key verified live for schedule + scores; Premium livescore path written, unverified — no key), `pulseTick`/`pulseLoop` writing immutable observations + derived `football_game_state`, `chalk pulse --watch`.
- **API + client.** OpenAPI document, SSE ask loop, provenance routes, mobile-first client with rating card, evidence drawer, coach view, rate-differently, league table.
- **Tests.** 38 tests (`node --test`): engine/rating/planner unit tests on the frozen real game + ingest/pulse/rating/verify integration against a real in-memory `nedbd-v2`.

### VERIFIED ON THE REAL SYSTEM

- Fixture `2025_18_CAR_TB`: engine reproduces TB **8-of-15** on third down, 2-of-7 on third-and-long, CAR 1-of-8 — asserted exactly.
- Live `POST /api/v1/ask` "Why is Tampa struggling on third down?": model plan `third_down` (source: model) → 227 plays → **Third Down Rating 66/100, rank 11 of 32** → 11.0s streamed explanation → observation `obs_6c0c5634678c1612` stored. **Every number in the model's prose was checked against the evidence package: 13/13 present, 0 invented.**
- `GET /provenance/football_ratings/<id>`: 457 nodes, 456 edges, depth 4 — rating → analysis + definition → 227 plays → 227 raw NFLData rows.
- `GET /verify`: `ok: true, tamper_evident: true, objects_checked: 98,155, tampered: []`.
- League table under the default formula: SF 98, GB 95, BUF 92 … ATL 8, MIN 3, TEN 3.

### DISCOVERED (evidence-based corrections to the spec; NEDB surface facts CHALK now relies on)

1. **NFLData `/v1/plays` has no team filter** (game_id/season/week/play_type only) and **no personnel/formation/shotgun fields** — those live in `/v1/participation` (offense_formation, offense_personnel, was_pressure, defenders_in_box) and `/v1/charting` (FTN: is_motion, is_play_action, n_blitzers…). Tendency output therefore lists formation/personnel/motion as `unsupported` until the participation/charting join is built (raw rows are ingested with `--deep`; the join is not).
2. **NFLData throttles with HTTP 403, not 429** (Cloudflare). 64 of 285 games 403'd mid-run; treating 403 as retryable with 2s→45s backoff fixed it. Cadence is daily-ish (`last_refresh` 2026-09-01); it is not a live source.
3. **NEDB: `POST /v1/databases` is a create call.** Issuing it for a database the daemon already has open returns 500 (the data dir is held by the daemon's own lock). Contract on our side: `listDatabases()` first, create only when absent (`ChalkStore.ensureDatabase`).
4. **NEDB: NQL addresses top-level fields only.** `WHERE source_payload.game_id = X` matches nothing (no nested paths); `OR`/`IN` are not part of the grammar. CHALK keeps every filter dimension in code and stores a top-level `source_record_id_game` on raw plays for lookups.
5. **NEDB: re-put of an identical document creates a new version** (new hash, new seq). Idempotency is the application's job; CHALK compares `source_hash` before writing.
6. **NEDB: `TRACE caused_by` returns history** — prior versions of the same id (play v1 behind play v2, raw v1 behind raw v2) are part of the answer, distinguished by `_seq`. I briefly misread that as a plain query returning stale rows; it was not. Tests now assert the chain play v2 → raw v2 → raw v1 and count distinct ids separately from versions.
7. **Measured NQL latency on 48,771 plays** (eq indexes created on game_id/posteam/season): Measured on 48,771 plays after `createIndex(...,"eq")` on game_id/posteam/season: `game_id = X` (159 rows) **851ms**; `posteam = TB` (1,420 rows) 922ms; `season = 2025` (48,771 rows) 2,959ms; `posteam AND game_id AND down` 968ms (1,235ms before indexes). `football_games` (285 rows) answers in 17–34ms, so the cost is a per-row scan of the play table, not HTTP. CHALK mitigates with a 90s read-through NQL cache in the server (`CHALK_QUERY_CACHE_MS`), logged on every hit, and content-cached analyses. Whether eq indexes are meant to accelerate NQL `WHERE` is a question for the engine; this is a measurement, not a bug claim.
8. **NEDB: `/link` and `/neighbors` are not HTTP routes** on 2.8.2 (napi-only). Not needed yet.
9. *(withdrawn — the '16 rows for 15 ids' was a TRACE result carrying two versions of one play; see 6.)*
10. **`/batch` returns per-op hashes** — the ingest uses them directly (no readback query).
11. **The 2026 season is not in play yet**: NFLData lists the 2026 schedule with null scores (0 plays); TheSportsDB shows Week 1 kicking off 2026-09-10 (SEA vs NE). Pulse will have something to watch in a week.

### BLOCKED

- **TheSportsDB Premium livescore** — no key. Path is written; verify when a key arrives via a skill credential (never chat).
- **Nothing else.**

### NEXT (in build-order, V3 §24)

1. Participation + charting **join** into normalized plays (formation, personnel, motion, play-action, pressure) → tendency engine stops saying `unsupported` for them; the Sarah screen ("pass from shotgun 61%") becomes possible.
2. `chalk watch` for the knowledge layer: poll NFLData for the current week on a cadence, delta-ingest, invalidate the league cache, so ratings move as games land.
3. **Deviation cards in the UI** wired to pulse game state: when a TB game is `live`, show CURRENT GAME DEVIATION against the season baseline.
4. Rating subjects beyond third down (red zone, explosiveness, ball security) — only where the play table supports them.
5. Opponent report intent (`What should I know about this week's opponent?`) — composes tendency + scan for the opponent; the engines exist, the composition does not.
6. Sports-Rater fan layer: `nick#hash` identity, fan ratings/likes as NEDB writes `caused_by` the CHALK record they react to, hash-chain feed. Same database, `sr_*` collections.
7. Share the NQL latency measurement (#7) with the engine work; nothing here is a bug to file.

### DECISIONS AFFECTING INVARIANTS

- **One monorepo, one NEDB database** (`chalk`). Cross-database edges do not exist in NEDB, and fan reactions must `caused_by` engine records — so they share a database.
- **Data scope rule:** ingest the seasons the questions need (2025 baseline, 2026 as it happens). Never backfill 1999+ speculatively.
- **Rust deferred.** The first slice is IO-bound (HTTP to nedbd); TypeScript with native type-stripping on Node 24 gets a zero-build-step repo. Revisit when a deterministic hot path (e.g. season-scale scans) earns it.
- **TheSportsDB (~$9/mo) is an experiment dependency**, named as such in `src/source/licensing.ts`; it is not an enterprise licensing assumption.
