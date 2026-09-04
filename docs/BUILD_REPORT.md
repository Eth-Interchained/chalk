# CHALK — Build Report

Living document. Newest entry first. Sections: SHIPPED · IN PROGRESS · DISCOVERED · BLOCKED · NEXT.

---

## 2026-09-04 — v0.6.7 · game_rank intent: "which game was their best game" now has a tool

### SHIPPED
- **Mark:** "tell me about the best game tampa had in 2025" → badges `situation_scan · rules · fallback`; GLM answered that the evidence had no games. GLM was right. Trigger: the model planner proposed `unsupported` (no intent knew games) so rules took over and mapped "best" to a situation scan. Root cause: CHALK had no game-level tool — `recentForm` computed per-game lines internally but nothing exposed them.
- `src/engine/games.ts` — `rankGames(plays, games, team, season, metric)`: one `GameLine` per completed game (opponent, home/away, result, score, margin, offense EPA/play, success, explosive, turnovers, defense EPA allowed), ranked by `epa | margin | success | defense` (versioned 1.0.0; ties → margin → week). Evidence = the best game's offensive snap ids so TRACE lands on plays. `gameRankStatements` writes the deterministic lines (best, worst, biggest win by margin when different, record).
- Planner: `game_rank` intent + validator (team, season, metric; unknown keys rejected); prompt lists it (PROMPT_VERSION 0.4.0) so the model planner stops saying `unsupported`; rule planner routes "best/worst game", "which game", "biggest win", "worst loss", "closest", "blowout", "best defensive game" — and still scans for "what is Tampa best at" (no "game" word). Executor persists the ranking as a `football_analyses` record; coach view shows the full ranked table.

### VERIFIED ON THE REAL SYSTEM
- Live ask on the 48,771-play store: "tell me about the best game tampa had in 2025" → plan `game_rank`, statements name the game/score/EPA; evidence = that game's snaps. Tests: fixture game ranks as TB W 16-14 / CAR L; metric routing matrix; validator; 64/64 both stores.

---

## 2026-09-04 — v0.6.6 · loading indicators everywhere; team logos with disclaimer

### SHIPPED
- **Mark:** "loading 227 of 227 plays…" sat as static text; the UI had no motion anywhere while working. Now: Home tiles and rating cards shimmer while loading (`.home.loading`), the ring pulses, ask cards show skeleton statement lines + an animated `planning` badge until the evidence event, and the Evidence drawer has a real progress bar (`aria-valuenow`) with "game k of K · n plays" — plays are fetched four games at a time in parallel (was sequential) and the count climbs as they land.
- **Team logos** (`src/server/logos.ts`, surfaced in `/api/v1/meta.team_logos`): hot-linked from the public ESPN CDN by default (`{abbr}` template, nflverse→ESPN map WAS→wsh, LA→lar), `CHALK_TEAM_LOGOS=0` turns them off, `CHALK_TEAM_LOGO_URL` swaps the provider. Client renders the hero logo (wordmark shrinks beside it), the next-opponent logo, and every `<img>` removes itself on load error so the wordmark always stands. Site footer carries the trademark disclaimer + data attribution. Plainly: a disclaimer grants no rights; this is the identification-only usage every fan stats site relies on, and it is one env flip from off.

### VERIFIED ON THE REAL SYSTEM
- `/api/v1/meta` on the local serve carries `team_logos` with the template and map; `node --check web/app.js`; logos resolver test matrix; 62/62 both stores. Rendering itself is not browser-tested in the sandbox.

---

## 2026-09-04 — v0.6.5 · Home is snapshot-first: restart costs milliseconds, not 30 s of three dots

### SHIPPED
- **Bug (Mark, VPS):** after `serve` restarted, the Home page sat empty (ring "•••", blank tiles) for ~30 s, then filled. Trigger: first visit after restart. Root cause: `buildHome` is ~8 season-scale NQL scans (`warmup: home TB 2025 ready in 26000ms` on the VPS) and every cache was in-process — a restart (= every deploy) threw them away; a visitor arriving during warmup started a SECOND identical build instead of joining the first.
- `football_home_snapshots`: the built payload is persisted with `data_stamp` = ingest + pulse event count at build time (the same counter the cache watcher already polls). Route decision (`homeServeDecision`, pure): fresh snapshot → serve instantly; stale snapshot → serve instantly with `served.refreshing: true`, rebuild once in the background; no snapshot → build inline (once per team/season, ever). `computeHome` dedupes concurrent builds per key and persists on completion. Warmup checks the snapshot first and only rebuilds when stale. `?fresh=1` forces.
- Client: response `served` block drives a `refreshing…` chip + one 4 s re-pull (≤8) until fresh; an inline build past 1.5 s says "Computing from the full season's plays — first look at this team since the data changed (~30s)" in the tiles instead of nothing.
- Ratings on Mark's screen matched this store exactly: ring 66 (#11), Offense 48 / Defense 45 / Third Down 66 / Red Zone 40 / Explosiveness 67 / Ball Security 73.

### VERIFIED ON THE REAL SYSTEM
- Local: restart serve → first `/home` request served from snapshot in ms with `served.source: "snapshot", fresh: true`; `?fresh=1` rebuilds and re-persists. Tests: decision matrix, persist/load roundtrip, re-persist versions, version-mismatch reads as absent. Full suite both stores.

---

## 2026-09-04 — v0.6.4 · client: subject-rating answers rendered; a render bug can no longer kill the ask stream

### SHIPPED
- **Bug (Mark, live on the VPS):** "How is the Tampa Bay offense rated overall?" → three correct statements, then `Cannot read properties of undefined (reading 'definition')` and no model prose. Server package verified correct (kind `rating`, `summary.rating` + `summary.profile` 1065 snaps/17 games, no `analysis`). Root cause in `web/app.js`: `renderCoach` treated every `rating` package as third-down shaped and read `summary.analysis.definition`; the throw inside the SSE `handle()` propagated out of the read loop and the outer catch abandoned the stream — so the coach-view bug also swallowed the interpretation.
- `renderCoach`: third-down shape when `analysis` exists; otherwise the season profile (snaps, games, EPA/play, success, explosive, turnover, third-down, red-zone TD, PPG) + formula notes; components table unchanged (shape already matched); league top-5 and bottom-3 tolerate `attempts`/`sample_size`/`snaps`.
- `handle("evidence")`: `renderCoach` wrapped — a failure logs to console and renders a named `.err` in the coach box; statements, tokens and observation continue.
- Badge: `0 plays` → `1065 snaps · aggregate` when there is no play list; Evidence drawer explains the aggregate instead of "loading 0 of 0 plays…".

### VERIFIED ON THE REAL SYSTEM
- Local serve, POST /api/v1/ask for the same question: identical three statements to Mark's screen; `summary` keys `rating, formula_notes, league_top5, league_bottom3, profile`. Client change syntax-checked (`node --check`); no headless browser in the sandbox — Mark's reload is the render test.

---

## 2026-09-04 — v0.6.3 · no silent short games: source contradictions error, ingest floor, season audit

### SHIPPED
- **Root cause of the 48,602-vs-48,771 gap on Mark's VPS (0 errors, 285 games):** `NFLDataSource.paginate` stopped on any short page, and `ingest` accepted a completed game with 0–N plays without comment. A 200 with an empty/partial body for one game cost 169 plays and left no trace. Trigger: upstream partial response. Root cause: two silent-accept paths in CHALK.
- `paginate`: a short page BEFORE the advertised `total` now throws `SourceError` (endpoint, offset/total, page size, params, body head) → lands in the run's `errors` for that game; the next run refetches. `total` reached or an honest short final page still ends the walk.
- `ingest`: a completed game returning fewer than `MIN_PLAYS_COMPLETED_GAME` (100; the shortest real 2025 game had 135) is written as received AND recorded in `errors` with the exact refetch command. Nothing dropped, nothing quiet.
- `src/ingest/audit.ts` — `auditSeason(store, season)`: per-game plays + context counts, `short_games`, `games_without_context`, min/max, `ok`, actionable `summary`. `GET /api/v1/ingest/audit?season=2025[&full=1]` (runs against the live server — no need to stop `serve`) and `chalk audit --season 2025 [--full]` (exit 2 when not ok).
- Serve's deep log prints the actual `CHALK_WATCH_DEEP` value instead of asserting one cause. LOCK message reworded: "previous holder (pid N) has exited — taking the lock" — the core leaves LOCK behind on clean exit, so this is normal after every CLI run (reproduced: fresh dir, two `verify` runs).

### VERIFIED ON THE REAL SYSTEM
- Local store: `chalk audit --season 2025` → 285/285 games, 48,771 plays, min 2025_15_LV_PHI 135, max 2025_02_NYG_DAL 221, `ok: true`.
- Tests: short-page contradiction throws / honest short page passes / empty+total 0 passes to the floor; ingest floor records the error with refetch command; audit on fixture store + empty season. Full suite both stores.

### NEXT
- Mark: `git pull`, `curl /api/v1/ingest/audit?season=2025` names the short game → `ingest --game <ID> --deep`.

---

## 2026-09-04 — v0.6.2 · watch loop deep by default (+ v0.6.1 nedb-engine ^2.8.4 pin)

### SHIPPED
- **Watch loop pulls play context by default.** `chalk serve` (in-process watch) and `chalk watch` now ingest participation + charting on every tick. Before, context required `--deep` on the command line — the systemd unit did not pass it, so a DEPLOY.md deployment would have collected 2026 plays all season with no formation/personnel context and only surfaced it as "context not ingested for this season" in answers. `src/ingest/watch_config.ts` — `resolveWatchDeep(flag, env)`: `--deep` wins, `CHALK_WATCH_DEEP=0|false|no|off` opts out, otherwise deep. Serve logs `deep=true — context included` so the state is visible in journalctl.
- One-shot `chalk ingest` is unchanged: plays first (`deep:false`), context via `--context-only` or `--deep`. Splitting keeps the first ratings ~3 min away and isolates NFLData throttling to the slow pass.
- v0.6.1: nedb-engine / nedb-engine-client pinned `^2.8.4`; the 2.8.4 napi addon projects `_caused_by` on get, so embedded TRACE/lineage matches HTTP mode with no CHALK-side shim.
- README quick start uses `node bin/chalk.ts …` (not `npx chalk`, which relies on the package `bin` and would fall through to the unrelated registry package `chalk` if that resolution ever failed).

### VERIFIED ON THE REAL SYSTEM
- `--context-only` on a season with zero played games is a no-op that exits 0 (games list is built from records with a result) — confirmed by reading `ingest.ts` step 3; the 2026 context command is therefore unnecessary until games are played.
- Tests: resolveWatchDeep matrix (default / "" / "1" / "0" / " false " / "off" / flag override); full suite on both stores.

### NEXT
- Deploy per DEPLOY.md; first live watch ticks on 2026-09-10.

---

## 2026-09-04 — v0.6.0 · NEDB embedded (no daemon), one engine per process

### SHIPPED
- **`Store` interface** (`src/store/nedb.ts`) — everything above the store depends on it, not on the HTTP client. Two implementations: `ChalkStore` (HTTP to nedbd, unchanged) and **`EmbeddedStore`** (`src/store/embedded.ts`, napi `NedbCore` in-process).
- **Embedded is the default.** `CHALK_STORE=embedded` / `CHALK_DATA=./chalk-data`. `NEDB_URL` or `CHALK_STORE=http` selects the daemon path (autostart kept there). `chalk serve` runs the watch loop **in-process** (`CHALK_WATCH_SEASON`/`--watch-season`) because one engine owns the directory. Deploy kit collapses to a single `chalk.service`; DEPLOY.md rewritten (ingest before the service starts).
- **Tests run against both stores**: `npm test` = 55 HTTP + 55 embedded. `tests/stores.ts` picks by `CHALK_TEST_STORE`.
- nedb-engine **v2.8.3 released** via `scripts/release.py v2.8.2 v2.8.3` (PR #70; contains PR #68 `_caused_by` projection on embedded reads and PR #69 NQL quote escaping). PyPI and crates.io show 2.8.3; npm follows when the release job finishes (waits on all platform addons, including the Codemagic Mac wheels — both queued by the tag, CI config untouched). CHALK pins `^2.8.2` and works on either.

### VERIFIED ON THE REAL SYSTEM
- Embedded serve over the SAME data dir the daemon had written (238k seq): six ratings identical (Offense 48 … Ball Security 73), scout CIN, ask "Why is Tampa struggling on third down?" → model plan → 227 plays → GLM narration, **16/16 numbers verified**; dad's fan chain continued (link #3, verified) across the store swap. `verify: true`.
- Concurrent double open refused (core flock + CHALK pre-check).

### DISCOVERED (evidence, not assumptions)
1. **napi `put` already carries `caused_by`** when it is a top-level key of the doc JSON — TRACE walks the edges on 2.8.2. My first probe used `_caused_by` and concluded the binding lacked it; wrong key, wrong conclusion. The planned engine slice shrank to "release master" (whose PR #68 additionally projects `_caused_by` on embedded reads). EmbeddedStore normalizes both shapes so rows look identical on 2.8.2 and 2.8.3.
2. **Layout is an env decision, not a file decision.** `NedbCore.open` on a v3 (`--dag-v3`) directory without `NEDB_DAG_V3=1` shows the MANIFEST seq but returns **zero rows for every query** — no error. EmbeddedStore pins `NEDB_DAG_V3=1`. Worth an engine-side guard (a v3 MANIFEST opened as v2 should refuse, not read empty).
3. **In-process is not faster than HTTP for NQL scans.** Cold, on 48,771 plays: `game_id = X` 1.6s (HTTP 0.85s), season 2.4s (HTTP 3.0s), a `football_play_context` game lookup 8.3s; TRACE 1.3s; verify 1.8s. The cost is the engine's scan, not the wire. The 90s read-through cache carries the UX in both modes.
4. **My EmbeddedStore cleared the cache on every put** → Home recomputed per request (17.4s warm). Removed; CHALK's own writes never touch the cached play/game scans, and the ingest/pulse event watcher remains the invalidation path. After the fix, embedded serve: warmup 11.0s, Home warm **537–674ms**, another team's Home first hit 4.3s, rankings 329ms, game page 2.4s.
5. The core's exclusive `flock` on `LOCK` is real and refuses a second opener — the "locked by another process" error from night one was that guard doing its job. (I briefly misread a dead daemon's directory as "napi ignores the lock"; it doesn't.)

### NEXT
- Wait for npm 2.8.3 + Codemagic wheels, then pin CHALK to `^2.8.3` and drop the 2.8.2 `caused_by` echo normalization.
- Engine follow-up worth filing: v3 MANIFEST opened as v2 should error, not read empty.
- Game day Sept 10; deploy per DEPLOY.md.

---

## 2026-09-04 — v0.5.0 · deploy kit, trends for every subject, Games tile

### SHIPPED
- **Deploy kit** (`deploy/`, `DEPLOY.md`): nginx server block for sports-rater.com (Cloudflare real-IP, SSE-safe `/api/v1/ask` location, 64 KB body cap), systemd units `nedbd-chalk` (loopback, optional NEDB_TMK + token), `chalk` (API + client on 127.0.0.1:4040), `chalk-watch` (re-ingest + pulse every 30 min), `env.example`, copy-paste runbook with expected outputs and an operations table. Nothing touches other sites on the box.
- **Per-subject trends** (`rating/trend.ts`, `GET /ratings/{subject}/trend`): as-known-then weekly score/rank for Offense, Defense, Red Zone, Explosiveness, Ball Security (third-down keeps its richer engine). Home trend tile gets subject chips.
- **Games tile**: every TB game with W/L/scheduled, score, week, divisional flag; tap a played game → "Why did Tampa win/lose <game>?", tap a scheduled one → scout the opponent.
- Tests: **55**.

### NEXT
- Game day (Sept 10): `chalk-watch` on `CHALK_WATCH_SEASON=2026`; live card via pulse `phase=live`; deviation once NFLData lands the plays.
- Fan consensus trend; moderation hide-by-hash; hashcash stamps if needed.
- Deploy: needs Mark on the VPS — DEPLOY.md is the whole procedure.

---

## 2026-09-04 — v0.4.0 · Sports-Rater fan layer

### SHIPPED

- **Identity without accounts** (`src/fans/identity.ts`): `fan_id = sha256(nickname:salt)` computed on the device (WebCrypto), salt in localStorage, handle `nick#xxxxxx`; server verifies shape + suffix only, stores nothing but handle + fan_id on writes. Deterministic 5×5 identicon SVG at `/api/v1/identicon/{fan_id}.svg`.
- **Fan writes** (`src/fans/fans.ts`): `sr_ratings` (0–100 per team/subject, replaces on re-rate, freezes CHALK's score at the moment), `sr_reactions` (like/agree/disagree on any football_* or sr_* record), `sr_posts` (≤280 chars, no links). Every write is `caused_by` its target's hash AND the fan's previous write; `sr_chain_tips` holds each fan's tip so the chain is O(1) to extend.
- **Reads**: `/feed` newest-first with reaction counts and identicons; `/fans/consensus` mean/median/distribution vs CHALK per subject; `/fans/{fan_id}` walks the chain tip→genesis verifying each `prev`.
- **Anti-spam**: token buckets — 20 burst / 1 per 10s per handle, 60 / 1 per 5s per address; 429 with Retry-After.
- **Client**: "rate as…" handle chip (create / verify my chain / forget device), **Rate it** on every rating tile (slider → saved → "fans 70 vs CHALK 48"), fans' mean on tiles, agree/disagree on every answer card (attached to the stored observation), take box + Fans tile with reactions and provenance.
- Tests: **54** (4 new: identity/identicon, rate limiter, validators, full chain/feed/consensus/TRACE integration on in-memory nedbd).

### VERIFIED ON THE REAL SYSTEM

- dad#… rated TB offense 70 against snapshot `rating_…` (CHALK 48) → consensus fans 70 vs 48 (+22, 1 fan); posted a take `caused_by` that snapshot; sarah#… disagreed; spoofed handle (`dad#000000`) rejected 400; feed shows both with identicons; dad's chain length 2, every link verified; `TRACE` from the take reaches `football_ratings` → `football_rating_definitions`; 21 rapid reactions → 20×201/200 then 429.

### DISCOVERED

1. Re-rating is a new version of the same id, so the fan's chain contains a hash that is now *history* (not the current version). The chain walk reports exactly that instead of pretending — same NEDB fact as the play-versions episode, now used on purpose.
2. Consensus is "latest rating per fan" for free, because ratings are keyed by fan+team+subject and NQL returns latest versions.

### NEXT

1. Live deviation card on game day (Sept 10) via `chalk watch --season 2026`.
2. Per-subject rating trends; fan consensus trend alongside.
3. Hashcash stamps if bots arrive; moderation = hide-by-hash list (never delete — history).
4. Sports-Rater domain deploy (sports-rater.com) on Mark's VPS behind nginx, nedbd as a tmux/systemd service.

---

## 2026-09-04 — v0.3.0 · the rating card, power rankings, scout card, watch loop

### SHIPPED

- **Six rating subjects** over a per-team **TeamProfile** surface computed from the play table (all-snaps bundle + third-down + red-zone + points per game): Offense v1 (EPA 30 · success 20 · explosive 15 · third-down 15 · red-zone TD 10 · turnovers 10), Defense v1 (mirror, directions flipped), Third Down v1, Red Zone v1 (TD rate 50 · EPA 30 · success 20), Explosiveness, Ball Security. Custom definitions accept a `subject`; metrics are validated against the subject's surface.
- **Power rankings** `GET /rankings` — every team under a definition, with movement vs the as-known-then snapshot one week earlier, risers/fallers. `chalk rankings`.
- **Home rating card** — six tiles, each tappable into "why" (routes to the `rating` intent with a `subject`), plus a **scout card** for the next opponent (pass %, EPA, shotgun %, top personnel, 3rd & 4–6 pass rate, weakest/strongest, one-tap full report / their defense).
- **`chalk watch --season N`** — the only polling loop: idempotent re-ingest + pulse tick on a cadence. Server watches ingest/pulse event counts and drops all in-process caches when they change (logged).
- Rating intent takes `subject`; rule planner routes "red zone rating", "grade the defense", "ball security badge", etc.
- Tests: **50** (4 new: profiles mirror offense/defense, all subjects compute, definitions/subject validation, planner routing).

### VERIFIED ON THE REAL SYSTEM (2025, 32 teams)

- TB card: Offense 48 (#19), Defense 45 (#19), Third Down 66 (#11), Red Zone 40 (#20), Explosiveness 67 (#11), Ball Security 73 (#9). Offense rankings: GB 89, BUF 88, LA 87, NE 77, CHI 74 … NYJ 14, CLE 7, LV 6; risers DAL +2.
- Scout card for TB's opener: CIN offense 1,049 snaps, 64.5% pass, shotgun 79.8%, 11 personnel 65.1%, **95% pass on 3rd & 4–6** (60 snaps), weakest goal-to-go.
- Live ask "What is Tampa's red zone rating and why?" → model plan `rating` subject `red_zone` → 40/100 #20 (149 red-zone snaps), weakest component success rate 38.9% vs league median 42.2% → GLM narration, **18/18 numbers verified in evidence**.
- Home warm-up now 11.6s cold (six ratings + scout), ~300ms warm.

### DISCOVERED

1. Rounded component scores can sum to 101 across two mirrored ratings; the exact scores sum to 100. Tests compare `score_exact`.
2. "42th percentile" — my deterministic statement, not the model's; fixed with a proper ordinal. The model echoes evidence text verbatim, which is exactly what we want, so the evidence text has to be right.

### NEXT

1. Live deviation card when `football_game_state.phase === "live"` (kickoff Sept 10; `chalk watch --season 2026`).
2. Rating trend for every subject (the trend engine is third-down only today).
3. Sports-Rater fan layer: `nick#hash` identity, fan ratings/likes `caused_by` engine snapshots, hash-chain feed (`sr_*`).
4. Player layer (rosters/snap counts) — only when Dad/Sarah ask.

---

## 2026-09-03/04 — v0.2.0 · CHALK Home (V3 layer over the v0.1.0 core)

### SHIPPED

- **Participation + charting join.** `football_play_context` — one row per play, `derived_from` the raw participation and charting rows: formation, shotgun/under-center, personnel string + parsed group (11/12/21…), defenders in box, pass rushers, blitzers, pressure, motion, play-action, screen, RPO, no-huddle, time-to-throw, air yards. `chalk ingest --season 2025 --context-only` pulled **92,446 raw rows → 47,424 context rows (97% of plays)**, 0 errors, 6.5 min.
- **Context patterns** (`engine/context.ts`): shotgun %, pass rate from shotgun / under center, personnel shares, motion %, play-action % of dropbacks, pressure % of dropbacks with success under pressure vs clean, box counts — every rate with its own denominator and coverage. Tendency answers now carry them; `unsupported` shrinks to coverage shells.
- **Trend engine** — Third Down Rating week over week, *as known then* (only plays through week N for the team and the league it is ranked against), provisional flags, biggest move, recent form (last 4 games vs season).
- **Opponent report** intent + `GET /reports/opponent` — six situations (early downs, 3rd&4-6, 3rd&7+, short yardage, red zone, trailing) each as tendency vs baseline with formation/personnel, plus their weak/strong spots from the scan. Rule planner routes "this week's opponent" via the schedule and "scout the Panthers" via the named team.
- **Badges** — 8 deterministic, versioned, league-relative definitions (top/bottom percentile with min samples and a min population). SF earns THIRD DOWN MONSTER (98th pct) / MONEY DOWN / EFFICIENT; TEN earns THIRD DOWN PROBLEM / STALLING; TB earns none — honest.
- **Home composite** `GET /teams/:team/home` — rating, trend, badges, form, last game with **deviation** (TB's last game: HIGH, driver pass_rate), next game with opponent snapshot, weakest/strongest situations, context coverage. Warmed at boot; ~300ms warm, ~10s cold.
- **Sports-Rater Home client** — team-colored accent (32-team palette), hero abbr + badges, rating ring, trend sparkline (provisional points hollow), form deltas, last game W/L line + deviation pill, next-up card with "Scout them", weak-spot rows that ask the question on tap, components; Coach view tables for patterns and opponent sections.
- Schedule rows: ingest now keeps unplayed games (null scores) so the next opponent resolves from the knowledge layer.
- Tests: **46** (8 new: personnel parsing, context join, patterns on the real game, trend as-known-then, recent form, badges, opponent report, planner routing).

### VERIFIED ON THE REAL SYSTEM

- Live ask "What does Tampa do on 3rd and medium?" → model plan `tendency` (distance 4-6) → 48 snaps in 19ms → statements: 79.2% pass vs 56.4% baseline; **shotgun 95.8% (+34 pts), pass from shotgun 80.4%, 11 personnel 83.3%, motion 54.2%, play-action 0/38, pressured 34.2% — success 30.8% under pressure vs 56% clean** → GLM-4-32B narration; every number in the prose present in the evidence (checked programmatically).
- `GET /reports/opponent?team=TB&opponent=CAR`: 1,059 snaps, 2,889 context rows; CAR in shotgun 59.9% (76.8% pass from gun), 11 personnel 66.6%, 3rd&7+ 84.8% pass at 97.8% shotgun, weakest very-long (−0.346 EPA/play), strongest 4th down.
- Trend TB 2025: 22 → 18 points after fixing the tail (weeks 1–18), w1 70 (provisional, 14 att) → w4 37 → w8 34 → w18 66, rank 10→12.

### DISCOVERED

1. **Model honesty path works**: before the 2026 schedule was ingested, "this week's opponent" produced an `unsupported` plan (no `next_opponent` in context) — correct, not a hallucinated opponent.
2. **PIN latency variance**: the same model answered in 11s and 55s within an hour. Inactivity-only deadline made this a non-event.
3. **Playoff weeks repeat a team's trend point** when the team is out — trend now stops at the team's last week.
4. `git stash && checkout` chains that abort leave edits in the stash. Check `git stash list` before trusting disk.

### NEXT

1. `chalk watch` (knowledge layer) — poll NFLData weekly ingest for 2026 once games land (Sept 10); pulse `--watch` during games; live deviation card wired to `football_game_state.phase === "live"`.
2. Rating subjects beyond third down (red zone, explosiveness, ball security) using the same population machinery; badges already show the shape.
3. Opponent report as a **Home card** ("This week: CAR — 3rd & 6 tendencies") — the Sarah screen proper.
4. Sports-Rater fan layer (identity, likes, feed) — `sr_*` collections `caused_by` engine records.
5. Player layer (rosters, snap counts) only if Dad/Sarah ask for it.

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
