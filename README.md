# CHALK

**Live Football Intelligence.** The engine behind [sports-rater.com](https://sports-rater.com).

> The database knows. Deterministic code calculates. The model interprets. Provenance proves.

CHALK turns structured football data into evidence-backed answers, tendencies, comparisons and ratings — and can show its work down to the raw source row for every number it states. It is built to be challenged by an NFL coach: *here are the plays, here is the calculation, here is the rating formula, here is the source, here is exactly why we said that.*

```
question
  ↓  intent / query plan          (local model proposes; code validates)
  ↓  validated situation filter
  ↓  NEDB query                   (coarse fetch)
  ↓  deterministic calculation    (metrics · tendencies · ratings · deviation)
  ↓  compact evidence package     (a few KB, presentation-rounded)
  ↓  local model interpretation   (GLM-4-32B on the A6000 via AiAS/PIN)
  ↓  answer + evidence + drill-down + provenance
```

No computer vision. No hosted database. No model doing arithmetic.

## What runs today (v0.6.0)

| Layer | What it does |
| --- | --- |
| `src/source/` | `FootballSource` contract + **NFLData** adapter (nflverse gold layer, verified against the live OpenAPI). `PulseSource` contract + **TheSportsDB** adapter for near-live scores (Pulse v1). Licensing registry per dataset. |
| `src/ingest/` | Immutable raw observations, normalized plays/games with lineage, idempotent re-runs (`source_hash`), upstream-change detection with `football_source_changes` events, an ingest event per run, pulse ticks. **Play context** (`--context-only` / `--deep`): participation + charting joined into `football_play_context` — formation, personnel group, motion, play-action, pressure, box counts. |
| `src/engine/` | Situation filter (validate → coarse NQL → fine filter in code), metrics with a sample-size ladder, **third-down analysis**, **tendency vs baseline** (with formation/personnel **context patterns**), **A/B comparison**, **30-bucket situation scan**, **season-vs-game deviation**, **trend** (rating week over week, as known then) + recent form, **opponent report**. |
| `src/rating/` | Versioned rating definitions over **six subjects** (Offense, Defense, Third Down, Red Zone, Explosiveness, Ball Security), percentile-rank normalization, 0–100 snapshots that record population, weights, raw and normalized values; **power rankings** with week-over-week movement; custom profiles; deterministic **disagreement explainer**; **badges**. |
| `src/llm/` | OpenAI-compatible client (inactivity-only stream deadline), versioned prompts, planner with validation + rule fallback, streaming explainer that stores every answer as an observation `caused_by` the calculations it used. |
| `src/server/` | Zero-framework HTTP API (OpenAPI at `/api/v1/openapi.json`), SSE `POST /api/v1/ask`, provenance routes (`TRACE caused_by` as JSON), static client. |
| `src/fans/` | **Sports-Rater fan layer** — no accounts: nickname + a device-held salt → sha256 → `nick#xxxxxx` with a deterministic identicon. Fan ratings, reactions and takes are NEDB writes `caused_by` the CHALK record they react to and chained per fan by previous hash; feed newest-first; fan consensus vs CHALK; chain walk with link verification; token-bucket anti-spam. |
| `web/` | **Sports-Rater Home**: team-colored hero with badges, rating ring, trend sparkline, recent form, last game with deviation, next up with opponent snapshot and *Scout them*, weak spots that ask on tap; ask bar, streamed answers, evidence drawer (tap a play to ask about it), coach view, *rate differently*, league table, provenance viewer. |

Everything lives in **one NEDB database**, **embedded in the CHALK process** by default (the napi engine from `nedb-engine`, data at `./chalk-data`) — no daemon. Set `NEDB_URL` (or `CHALK_STORE=http`) to talk to a `nedbd` daemon instead; both stores implement the same `Store` interface and the whole test suite runs against both. NEDB is the truth, history and provenance layer — not a cache.

## Quick start

Requires Node ≥ 24 (TypeScript runs natively — no build step).

```bash
npm install
node bin/chalk.ts ingest --season 2025          # ~3 min: 285 games, 48,771 plays → embedded NEDB at ./chalk-data
node bin/chalk.ts ingest --season 2025 --context-only   # ~6 min: formation/personnel/motion/pressure context for every play
node bin/chalk.ts ingest --season 2026          # schedule (so "this week's opponent" resolves); plays land as games are played
node bin/chalk.ts rate --team TB --season 2025  # Third Down Rating with formula, population, sample
node bin/chalk.ts serve --port 4040             # open http://127.0.0.1:4040
```

### Store

| Mode | When | How |
| --- | --- | --- |
| **embedded** (default) | one process owns the data | napi `NedbCore` in-process at `CHALK_DATA` (default `./chalk-data`), v3 segment layout pinned. One engine per directory — the core holds an exclusive lock and refuses a second opener. `chalk serve` runs the watch loop in-process (`CHALK_WATCH_SEASON`). Stop the server before running CLI commands against the same dir. |
| **http** | several processes, or a remote store | `NEDB_URL=http://127.0.0.1:7070` (or `CHALK_STORE=http`). Autostarts the bundled `nedbd-v2` on loopback when nothing answers unless `CHALK_AUTOSTART_NEDB=0`. `chalk watch` may run as its own process here. |

Same NQL, same hashes, same `TRACE`; `npm test` runs every integration test against both.

### Model

Set the model once; nothing else in CHALK knows which model answers.

```bash
export CHALK_LLM_URL=https://api.aiassist.net/api/v1/pin/chat/completions   # any OpenAI-compatible endpoint
export CHALK_LLM_KEY=…                                                       # bearer token (or AIASSIST_API_KEY)
export CHALK_LLM_MODEL=GLM-4-32B
export CHALK_LLM_PROVIDER=pin                                                # sent as X-AiAssist-Provider; "" to disable
```

Without a key, CHALK still answers every question with the deterministic statements — the model only narrates.

### Near-live (Pulse v1)

```bash
node bin/chalk.ts pulse                     # one tick: schedule + recent scores from TheSportsDB (free test key)
THESPORTSDB_KEY=… node bin/chalk.ts pulse --watch --interval 120   # Premium key unlocks livescore (~2-min freshness)
```

Every tick lands as immutable observations in `football_raw_pulse` with derived `football_game_state` rows; changed scores create new versions `caused_by` the previous one. "Near-live", never "realtime".

## CLI

```
chalk ingest --season 2025 [--team TB] [--game 2025_18_CAR_TB] [--deep | --context-only]
chalk analyze --team TB --season 2025 [--game ID] [--side defense]
chalk rate --team TB --season 2025 [--definition third_down_default@1.0.0]
chalk scan --team TB --season 2025
chalk league --season 2025
chalk pulse [--watch] [--interval 120]
chalk watch --season 2026 [--interval 1800]      # re-ingest + pulse on a cadence (the only polling loop)
chalk rankings --season 2025 [--definition offense_default@1.0.0]
chalk verify
chalk serve [--port 4040] [--host 127.0.0.1] [--watch-season 2026 --watch-interval 1800]
```

## API

Full document: `GET /api/v1/openapi.json`. Highlights:

| Route | Returns |
| --- | --- |
| `GET /api/v1/analyses/third-down?team=TB&season=2025` | Deterministic third-down analysis, persisted, cached by content id |
| `GET /api/v1/ratings/third-down?team=TB&season=2025[&definition=]` | 0–100 rating with every component's raw value, percentile, rank, points |
| `GET /api/v1/ratings/third-down/league?season=2025` | League table under a definition |
| `GET /api/v1/ratings/compare?team=TB&season=2025&a=…&b=…` | Why two formulas disagree, per component, in points |
| `POST /api/v1/rating-definitions` | Save a custom formula (weights normalized, versioned in NEDB) |
| `GET /api/v1/analyses/scan?team=TB&season=2025` | Situations hurting/helping the team most, min-sample protected |
| `GET /api/v1/teams/TB/home?season=2025` | Home composite: rating card (6 subjects), trend, badges, form, last game + deviation, next game + scout card, weak spots |
| `GET /api/v1/ratings/offense?team=TB&season=2025` | Any subject: `offense`, `defense`, `red-zone`, `explosiveness`, `ball-security` — snapshot + formula + team profile |
| `GET /api/v1/rankings?season=2025[&definition=]` | Power rankings with movement, risers and fallers |
| `GET /api/v1/ratings/offense/trend?team=TB&season=2025` | Any subject's rating week over week, as known then |
| `POST /api/v1/fans/ratings` · `/fans/reactions` · `/fans/posts` | Fan writes (body carries `fan_id` + `handle`; no account) |
| `GET /api/v1/feed?team=TB` | Newest-first feed of takes and ratings — the hash chain, rendered |
| `GET /api/v1/fans/consensus?team=TB&season=2025` | Fans' mean/median per subject vs CHALK |
| `GET /api/v1/fans/:fan_id` | A fan's chain, walked and verified link by link |
| `GET /api/v1/ratings/third-down/trend?team=TB&season=2025` | Rating week over week, as known then |
| `GET /api/v1/badges?team=TB&season=2025` | Earned badges with qualification rules |
| `GET /api/v1/reports/opponent?team=TB[&opponent=CAR]` | Opponent report: six situations with formation/personnel context, weak/strong spots |
| `POST /api/v1/tendencies` / `POST /api/v1/comparisons` | Any situation filter vs baseline / any A vs B |
| `POST /api/v1/ask` | SSE: `plan` → `evidence` → `token*` → `observation` → `done` |
| `GET /api/v1/plays/:id` | Normalized play + raw source record + lineage |
| `GET /api/v1/provenance/:coll/:id` | `TRACE caused_by` as nodes + edges, down to raw rows |
| `GET /api/v1/ingest/status` | Ingest runs, upstream changes, pulse ticks, NEDB head/seq |
| `GET /api/v1/verify` | NEDB tamper-evidence check over the whole store |

## Situation filter

Every question compiles to this (the model proposes it; `validateFilter` decides):

```json
{ "team": "TB", "side": "offense", "season": 2025,
  "down": [3], "distance_min": 4, "distance_max": 6,
  "score_state": ["trailing"], "neutral_only": true,
  "exclude_kneels": true, "exclude_spikes": true, "exclude_no_play": true,
  "exclude_penalties": false, "exclude_garbage_time": false }
```

Definitions that matter (all in `src/engine/metrics.ts`, `src/model/football.ts`):
conversion = `first_down || touchdown` · success = `epa > 0` · explosive = pass ≥ 20 / run ≥ 12 yds · garbage time = Q4 with a 17+ gap or Q3+ with 25+ · distance buckets 1–3 / 4–6 / 7–10 / 11+ · confidence ladder n<10 insufficient, <25 low, <60 moderate, else strong.

## Ratings

Every rating is a versioned definition (`src/rating/definitions.ts`, with the *why* of each weight) over a deterministic metric surface, percentile-ranked against the league for the same season, weighted, ×100:

- **Offense** v1 — EPA/play 30 · success 20 · explosive 15 · third-down conversion 15 · red-zone TD rate 10 · turnover rate 10 (lower is better)
- **Defense** v1 — the same surface over the snaps the defense faced, directions flipped
- **Third Down** v1 — conversion 50 · EPA 30 · success 20 (plus `Explosive & Clean` as a second philosophy)
- **Red Zone** v1 — TD rate per snap 50 · EPA 30 · success 20
- **Explosiveness** / **Ball Security** — single-metric

Every snapshot records population, weights, raw and normalized values, points per component, sample size and a `provisional` flag. Custom profiles: `POST /api/v1/rating-definitions` with a `subject`.

## Tests

```bash
npm run typecheck
npm test              # node --test — 55 tests, run twice: HTTP store (nedbd --memory) and embedded store (in-process): engine, rating, planner, context/trend/badges/opponent unit tests + ingest/pulse/rating integration against a real in-memory nedbd
```

The frozen fixture is the real game `2025_18_CAR_TB` (159 plays as returned by NFLData on 2026-09-03). Ground truth asserted exactly: TB 8-of-15 on third down, 2-of-7 on third-and-long, CAR 1-of-8. The model is never required for analytics tests.

## Sports-Rater identity

There are no accounts. The browser makes a random salt once, keeps it in `localStorage`, and computes `fan_id = sha256("nickname:salt")`. The handle everyone sees is `nickname#` + the first six hex characters. Every rating, reaction and take carries `fan_id` + `handle` and nothing else about the person; the server never sees the salt and has no fan table. Each fan's writes form a chain (`prev` = hash of their previous write), and every write is `caused_by` the CHALK record it reacts to — so `TRACE` from a fan's take reaches the plays behind the number they were arguing about. Lose the device, lose the handle; that's the deal.

## Deploy

See `DEPLOY.md` — nginx block, systemd units for nedbd / CHALK / the watch loop, env template, and the exact commands for sports-rater.com on the VPS.

## Data & licensing

See `src/source/licensing.ts` (also served in `/api/v1/meta`). Prototype data only: NFLData/nflverse (attribution) and TheSportsDB (test/Premium tiers). Neither implies commercial redistribution rights. No private team data enters this codebase.

## Repository layout

```
bin/chalk.ts            CLI
src/source/             provider adapters (NFLData, TheSportsDB), licensing registry
src/ingest/             raw → normalized ingest, pulse ticks, indexes
src/model/              CHALK's football model
src/engine/             situation · metrics · third-down · tendency · comparison · scan · deviation
src/rating/             definitions · normalization · rating · league orchestration
src/llm/                client · prompts · planner · explainer
src/server/             HTTP API · intents · OpenAPI
web/                    client
tests/                  node --test suites + frozen fixture
docs/                   NFLData OpenAPI snapshot, build report
```

© 2026 Interchained LLC · BUSL-1.1 (see `LICENSE`) · built by Interchained × Vex
