<!--
  SPDX-License-Identifier: BUSL-1.1
  Copyright (c) 2026 Interchained LLC. All rights reserved.
  CHALK / Sports-Rater — https://sports-rater.com — Licensor: Interchained LLC
-->
# To: the Oracle (GPT-5.5), Claude agents, and any AI that inherits this codebase

**From:** Vex (Claude Fable 5.1), with Mark Allen Evans Jr. (INTERCHAINED LLC)
**Date:** 2026-09-04 — written the evening CHALK reached v0.12.12 and Mark said "we can call this stable"
**Read with:** [LORE.md](./LORE.md) (why it is the way it is), [docs/BUILD_REPORT.md](./docs/BUILD_REPORT.md) (every version, every root cause), [README.md](./README.md) (user-facing)

This file is the operating manual for an agent touching this repo. It is a map of what **is**, verified against the code the day it was written (v0.12.13). If the code and this file disagree, the code is right and this file is a bug — fix it in the same PR.

---

## The doctrine (load-bearing, not a slogan)

> **The database knows. Deterministic code calculates. The model interprets. Provenance proves.**

Every design decision below falls out of those four sentences.

- **The database knows.** NEDB is canonical. Play-by-play, games, context, analyses, ratings, observations (LLM answers), fan writes — all of it lives in one content-addressed, hash-chained DAG store. Every row carries `_hash`, `_seq`, `caused_by` lineage. Nothing important lives only in process memory or only in the browser.
- **Deterministic code calculates.** Every number a fan sees (ratings, ranks, percentiles, EPA, trends, badges, situational scans) comes from `src/engine` and `src/rating` — pure functions over rows, stored as analysis records with an algorithm id + version. No model ever produces a number.
- **The model interprets.** The LLM (GLM via AiAssist, `src/llm`) only *explains* an evidence package the deterministic layer built. Its prompt forbids numbers not in EVIDENCE. Its output is stored as an **observation** with the evidence key, model, latency, and register — and served from The Record on repeat asks. Planner intents are validated by rules; a rejected model plan falls back to the rule planner, never to a guess.
- **Provenance proves.** Every card has a provenance drawer; every fan write cites the record it reacts to and the fan's own previous write (a per-fan hash chain that verifies end to end); every answer names its evidence. If you cannot trace it, do not show it.

## The fact wall (enforced by a test)

Fans turn knobs that are **not facts** — favorite, picks, hype, reactions, takes. They never touch a CHALK reading.

`tests/fact_wall.test.ts` fails the build if anything under `src/rating`, `src/engine`, `src/llm`, `src/planner`, `src/ingest`, `src/model` or `src/source` imports `src/fans` or names an `sr_*` collection. Fan data may decorate responses **at the server route layer only** (`src/server/app.ts`). Keep it that way. (Mark, 2026-09-04: "make sure the CHALK readings are not manipulated by fans — give them other knobs to turn but not the facts.")

---

## What is here

```
bin/chalk.ts            CLI: ingest · analyze · rate · scan · league · pulse · watch · rankings · audit · verify · serve
src/source/             NFLData adapter (nfldata.ts), Pulse source, licensing notes
src/ingest/             ingest (raw → normalized, idempotent, floors, contradictions error), context join, pulse, audit
src/model/football.ts   Play / Game / context types
src/engine/             deterministic analyses: third down, situation scan, tendency, deviation, opponent report, trend, games, metrics
src/rating/             rating definitions (subjects, weights, directions), percentile-rank normalization, league profiles, badges, trends
src/llm/                planner (intent + filters), explain (evidence → prose), prompts (fan/coach registers), record (observations, evidence keys), client
src/server/app.ts       the HTTP server: 57 routes, static files, /s/TEAM landing, admin, telemetry, watcher, warmup
src/server/home.ts      the Home payload builder + snapshot-first serving + data stamp
src/server/share.ts     sharecard copy + OG injection + publicBase
src/server/admin.ts     usage aggregations (token-gated)      src/server/moderation.ts  hide / regenerate
src/store/              Store interface; HttpStore (nedbd over HTTP); EmbeddedStore (napi, in-process); WorkerStore (engine on a worker thread)
web/                    the client: index.html · app.js (no framework, no build) · styles.css · admin.* · hero/ logos/ icons/ og/
tests/                  node --test, run TWICE: http store and embedded store (CHALK_TEST_STORE=embedded)
docs/BUILD_REPORT.md    the living log — one entry per version, trigger and root cause named
DEPLOY.md · deploy/     VPS: node bin/chalk.ts serve on :4040 behind nginx (Cloudflare Flexible)
```

Node ≥ 24, native TypeScript (type stripping), zero paid dependencies. Runtime deps: `nedb-engine` (exact pin), `nedb-engine-client`, `sentinel-blocks`.

## Commands that matter

```
npm run typecheck                         tsc --noEmit
npm test                                  both stores; 114 tests at v0.12.13 — must be green before any commit
node bin/chalk.ts ingest --season 2025    idempotent; --deep pulls participation + charting context; --context-only
node bin/chalk.ts audit --season 2025     names every game whose play count is short (no silent short games)
node bin/chalk.ts verify                  walks the hash chain
node bin/chalk.ts serve                   prints the boot banner; the `engine` line must read the pinned nedb-engine version
```

## Store rules

- **One engine per data dir.** The embedded engine holds a LOCK; a second open fails loudly. `serve` runs the engine on a **worker thread** (`WorkerStore` ↔ `embedded_worker.ts`) because napi calls are synchronous and a season-scale scan (0.3–2.4 s, ~8 per Home build) must never block the HTTP thread. The CLI runs in-thread. `CHALK_EMBEDDED_WORKER=0` opts out.
- **Read cache.** Both stores have a read-through NQL cache (`CHALK_QUERY_CACHE_MS`, 90 s default). `put`/`batchPut` invalidate cached answers over the **written collection only** (`invalidateCollection`) — a write is visible to the next read of its collection; the play/game scans stay warm. The ingest watcher invalidates everything when ingest/pulse actually wrote.
- **Durability.** nedb-engine ≥ 2.8.5: an acknowledged write is on disk within one manifest tick (1 s, `NEDB_FLUSH_MS`) or at exit. Before 2.8.5 an embedded app killed with SIGKILL lost every write since open — CHALK found that; the fix is upstream (eth-interchained/nedb #72). Do not downgrade.
- **Home snapshots.** `football_home_snapshots` stamped `w<last writing ingest seq>:p<last writing pulse seq>:v<package version>`. Fresh → serve; stale → serve instantly flagged `refreshing`, rebuild once in the background; missing → compute inline (~30 s). Do-nothing watch ticks **must not** move the stamp (v0.9.1); a deploy moves it exactly once (v0.12.2).
- **Never compute Home inline for a caption or a crawler** (`/api/v1/share`, `/s/TEAM` read the snapshot only).

## LLM rules

- Planner: rule planner never throws; model plans are validated and **repaired** (opponent inferred, subject aliases normalized) or rejected → rule fallback, logged as a fallback for the admin panel.
- Explainer: `EXPLAINER_SYSTEM` (fan) and `EXPLAINER_SYSTEM_COACH` (coach) share the hard rules (numbers only from EVIDENCE; sample-honest). `PROMPT_VERSION` is part of the evidence key; bump it when a prompt changes and every first ask streams fresh once.
- The Record: `evidenceKey(plan, pkg, promptVersion, register)`. A fan answer is never served to a coach or vice versa. Hidden (moderated) observations are excluded everywhere; regenerate re-plans + re-explains and hides the old.
- No LLM key → deterministic statements only; the UI says so. **Never claim an LLM behaviour is verified on a store with no key** (we did once; corrected in v0.9.1's report).

## Client rules

- No framework, no build step. `app.js` is a module; `index.html`, `app.js`, `styles.css` are served `no-cache` so a deploy never leaves a browser on last week's client.
- **Every interactive card goes through `showCard()`** (switches to the Feed view, prepends, scrolls). A card prepended into `#feed` from the Dashboard without switching lands in a `display:none` container — four buttons were dead that way once (v0.9.2). A static test forbids direct prepends.
- **Never wipe tiles on a refresh.** `loadHome(defId, { quiet: true })` swaps a payload in place. The slow-load message names only causes the client can actually observe.
- **Grid items need `min-width: 0`** or a wide table grows the item instead of scrolling (coach deck, v0.9.3; Next up, v0.12.3).
- **Anything drawn from `state.home` waits for it** (`state.homeLoading`) — never draw a blank card from an empty state (sharecard, v0.12.12).
- **Never trust the request Host for public URLs.** `publicBase` ignores loopback/private hosts; the client re-homes server URLs to `location.host`. Set `CHALK_PUBLIC_URL` in production anyway.
- Team assets are vendored (`web/logos/*.png`, `web/hero/*.jpg`) — no hotlinking. Every `TEAMS` entry has both; a static test checks. `WSH` is a team (NFLData's code), `LAR` aliases `LA`.
- Static guard tests (`tests/client_static.test.ts`) encode every client lesson above. When you fix a client bug, add the guard that would have caught it.

## Fan layer (Sports-Rater)

Identity is math: `fan_id = sha256(nickname:salt)`, handle `nick#first6`, no accounts. Every write (`sr_posts`, `sr_reactions`, `sr_favorites`, `sr_picks`, `sr_hype`, legacy `sr_ratings`) carries `prev` + `chain_index`; `fanChain` verifies the chain and resolves superseded versions through TRACE history (v0.12.1). Picks cite the `football_games` row, lock once the game has a score or its gameday has passed, and are **settled by the facts** (`settlePick` → won/lost/push/pending). Hype is 1–5 sentiment, labelled as such on the card. Rate-it sliders and fan-vs-CHALK consensus were **cut** in v0.11.0 on purpose — do not bring back "fans rating a fact".

## Operating rules (Mark's, non-negotiable)

1. **Never force-push. Never rewrite public history. Never retag.** Branch → PR → merge. Even a one-line fix.
2. **Tests green on both stores before any commit.** Chain `npm test && git commit`, never `;`. Two suites committed red once because of a semicolon.
3. **Every PR names the trigger and the root cause** (they are usually different) and what was verified on the real system. If it was not verified live, say so in those words.
4. **Never round up.** "Tests pass" is not "it works". A browser feature has never been verified until a browser rendered it. Mark drives the live site unless he says "go".
5. **Never change LICENSE without an explicit, unambiguous instruction.** CHALK is BUSL-1.1, Licensor Interchained LLC. SPDX header on every file; "Interchained LLC" on every page and in `x-powered-by`.
6. **Never swallow a failure.** No empty catch, no silent skip. Every failure path names the status, the payload shape, and the condition — and names every plausible cause the system genuinely cannot distinguish rather than baking in one.
7. **Audit your own diff first.** When Mark reports a regression, read what you just shipped before blaming cache, CDN, or his environment.
8. **Stay in scope.** Do what was asked; mention what you noticed; do not fix it uninvited. If challenged on an unrequested change, revert it immediately.
9. **Version + BUILD_REPORT in every PR.** Bump `package.json`; add an entry — Mark's words, the trigger, the root cause, the fix, what was tested, what was not.
10. **Leftovers are a queue.** When a directive lands mid-loop, build it; when it merges, go back to the previous PR's "known / not in this PR" items before proposing anything new.

## Environment

| var | meaning |
|---|---|
| `CHALK_DATA` | embedded store data dir (one engine per dir) |
| `CHALK_STORE` / `NEDB_URL` / `NEDB_DB` / `NEDBD_TOKEN` | use nedbd over HTTP instead of embedded |
| `NEDB_DAG_V3` | defaults to `1` for the embedded engine |
| `NEDB_FLUSH_MS` | engine manifest tick (default 1000) — durability window |
| `CHALK_DEFAULT_TEAM` / `CHALK_DEFAULT_SEASON` | dashboard defaults |
| `CHALK_LLM_PROVIDER` / `CHALK_LLM_MODEL` / `CHALK_LLM_KEY` / `AIASSIST_API_KEY` | explainer; absent → deterministic statements only |
| `CHALK_WATCH_SEASON` / `CHALK_WATCH_INTERVAL` / `CHALK_WATCH_DEEP` | in-process re-ingest + pulse loop (deep by default) |
| `CHALK_INGEST_WATCH_MS` | data-stamp watcher cadence (60 s) |
| `CHALK_QUERY_CACHE_MS` | NQL read cache TTL (90 s) |
| `CHALK_WARMUP` | `0` disables the boot-time Home warmup |
| `CHALK_ADMIN_TOKEN` | ≥16 chars enables `/admin` and `/api/v1/admin/*`; unset → 404 |
| `CHALK_TELEMETRY` | `0` disables anonymous page-view rows |
| `CHALK_PUBLIC_URL` | public base for captions and OG tags — set it in production |
| `CHALK_EMBEDDED_WORKER` | `0` runs the engine in-thread (CLI default) |
| `THESPORTSDB_KEY` | optional pulse source |
| `HOST` / `PORT` | listen address |

## Where to start

1. `npm test` — both stores green? If not, stop; something in your environment differs.
2. Read the newest three entries of `docs/BUILD_REPORT.md`. They tell you what just changed and what was left on the table.
3. Read `LORE.md`. Then argue with us.

— Vex × Interchained LLC
