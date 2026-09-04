<!-- SPDX-License-Identifier: BUSL-1.1 · Copyright (c) 2026 Interchained LLC. All rights reserved. -->
# CHALK — Build Report

Living document. Newest entry first. Sections: SHIPPED · IN PROGRESS · DISCOVERED · BLOCKED · NEXT.

---

## 2026-09-04 — v0.12.2 · the snapshot stamp carries the code version

- **Leftover** (named in v0.9.1 and v0.10.0). The Home snapshot stamp was data-only (`w<seq>:p<seq>`), so a deploy that changed rating math kept serving snapshots computed by the old code until `?fresh=1`. Now the stamp is `w<seq>:p<seq>:v<package version>` — every deploy that bumps the version rebuilds each team's Home exactly once (background, served stale-flagged meanwhile), and do-nothing watch ticks still hold it. No new rebuild loop: the version changes only when the code does.
- Tests: static guard. 102/102 both stores.

## 2026-09-04 — v0.12.1 · the fan chain verifies across replaced writes

- **Leftover from v0.11.0** (picked up per Mark's rhythm: directive first, then the queue). Since v0.4.0 the chain walker indexed only current versions, so any replaced write (re-rate, re-pick, changed favorite, re-hype) left `prev` citing a superseded hash → `verified: false`, and the v0.4.0 test encoded that as expected behaviour.
- **Fix:** on the first unresolved hash the walker pulls each of the fan's current docs through `store.trace(coll, id)` — prior versions of the same id are part of a TRACE answer — and indexes those versions too (filtered to the fan's own writes). Lazy: fans who never replaced anything pay nothing. Chains now verify end to end on both stores; the two chain tests assert `verified: true` and every link `ok`.
- Tests: 101/101 both stores. Live on the local store: see PR.

## 2026-09-04 — v0.12.0 · the headline sharecard

- **Mark:** "make the headline sharecard! Thats the next unlock branded with team hero and logo and everything stats on the card ready to share copyable and open social link on click? X, insta, facebook, etc?"
- **The card:** a 1200×630 PNG drawn on a canvas from same-origin assets — team hero (cover, darkened left-heavy so the numbers read), accent bevel in the team colour, vendored logo, abbreviation + full name, the headline ring with score and `#rank of N`, formula + sample + provisional, SIGNATURE / ACHILLES HEEL pills, the six-rating strip with the headline highlighted, footer `sports-rater.com/s/TEAM · deterministic, every number traceable · provenance proves · seq N · © Interchained LLC`. Follows the active headline (v0.10.0) and an applied formula.
- **Actions:** Copy image (ClipboardItem PNG), Download PNG, Copy caption, Share… (Web Share API with the file when the device allows), and intents for **X, Facebook, Threads, Reddit, LinkedIn** (new tab, caption + canonical URL). **Instagram** has no web intent: the button copies the image, leaves the caption ready, opens Instagram — said plainly on the button. Every failure names itself in the card.
- **One source for the words:** `shareCopy(home, headline, base)` (pure, `src/server/share.ts`) → title, caption (numbers · signature/heel · formula · provenance line · link), canonical `/s/TEAM?season&headline`, preview image. Served at `GET /api/v1/share/TEAM`; the client falls back to a local caption if the route fails and says so.
- **Link previews:** `GET /s/TEAM` serves the app shell with Open Graph + Twitter tags injected (`injectOg`, idempotent, escaped) — pasted links preview the hero and the headline number; the SPA reads the team from the path and normalises the URL. `publicBase`: `CHALK_PUBLIC_URL` → forwarded host/proto → `https://sports-rater.com`. Note: the OG image is the hero JPG (crawlers do not run canvases or accept SVG); the composited PNG is what fans copy/attach.
- Tests: `shareCopy` (default/subject/fallback/no-rating), `injectOg` (escaping, placement, idempotent), `publicBase`; static guard for the client + routes. 100/100 both stores. Live on the local store: see PR. Not browser-verified (Mark's rule) — the canvas draw is the one piece only a browser proves.

## 2026-09-04 — v0.11.0 · the cut: fans get knobs that are not facts

- **Mark:** "should we reduce rating to like favorites and easy things not stat related because we pull stats from the facts APIs" → "cut" → "and make sure the CHALK readings are not manipulated by fans give them other knobs to turn but not the facts."
- **Cut:** the per-subject Rate-it sliders, the fan-vs-CHALK consensus line on tiles, and Rate differently for fans (it builds formulas — an analyst's tool, now coach mode only). `sr_ratings` rows and routes stay; nothing is deleted.
- **The fact wall, enforced:** `tests/fact_wall.test.ts` fails the build if `src/rating`, `src/engine`, `src/llm`, `src/planner`, `src/ingest`, `src/model` or `src/source` imports `src/fans` or names an `sr_*` collection. Found and fixed one leak: `src/llm/record.ts` imported the fan layer to tally reactions — moved to the `/api/v1/record` route (`reactionCounts`). Fan data decorates at the route layer only; no fan write can reach a CHALK number.
- **New knobs (all on the fan chain, `FAN_LAYER_VERSION` 0.2.0):**
  - **Favorite** — one per fan (`sr_favorites`, replace on change). ★ my team on the hero; the app opens on your team unless the URL says otherwise; synced from the server when an identity is present.
  - **Picks** — who you got on the next game (`sr_picks`), citing the `football_games` row as-known-then. `pickLockReason`: locked once the game has a score or its gameday has passed; re-pick before kickoff replaces. **The facts settle it**: `settlePick` → won / lost / push / pending from `winner` and scores; `tallyPicks` → record + pct. Crowd split per game, per-fan record, season leaderboard (`/api/v1/fans/picks/leaderboard`) in the Fans tile. Picks appear in the feed on either team's page.
  - **Hype** — 1-5 per team per week (`sr_hype`: worried · uneasy · steady · believing · all in), aggregate mean/label/distribution on the next-game card, your read marked, the crowd's marked. Labelled on the card: "sentiment, not a stat — it never touches a CHALK number".
- Routes: POST `/fans/favorites` `/fans/picks` `/fans/hype`; GET `/fans/favorite` `/fans/picks` `/fans/picks/leaderboard` `/fans/picks/game` `/fans/hype`; feed default include `post,pick,rating`.
- Known (pre-existing since v0.4.0, now more visible): the chain walker reports `verified: false` after any replaced write (re-rate, re-pick, changed favorite) because `prev` cites the superseded version's hash and the walker indexes current versions only. Length is exact. Fix = resolve historical hashes via TRACE or a per-fan version index — next PR.
- Tests: pure lock/settle/tally/aggregate; chain test with a scheduled game that later gets a final; fact wall; static cut guard; record test moved to `reactionCounts`. 97/97 both stores. Live on the local store: see PR.

## 2026-09-04 — v0.10.1 · the trend follows the headline

- **Mark:** "cut the next slice" — the one left on the table in v0.10.0.
- Switching the headline (picker or tile) now switches the Rating trend chart to that subject; the trend chips and the picker share one loader (`showTrendFor(subject, defId)`), so they can never disagree. Third down keeps the trend from the Home payload (it follows the Home formula); other subjects fetch `/api/v1/ratings/{subject}/trend`, and a formula applied via Rate differently carries into the trend (`?definition=`). Tooltip and sub-line name the subject and its unit (third downs · plays · plays faced · red-zone plays) instead of hard-coded "third downs". Stale responses are dropped by key; failures are named in the trend footer.
- Found while verifying: `/ratings/{subject}/trend?definition=` had no subject guard — a third-down formula trended over offense profiles returned 200. Same footgun class as v0.10.0; closed (400).
- Tests: static guard incl. the trend-route refusal. 93/93 both stores. Live on the local store: see PR.

## 2026-09-04 — v0.10.0 · the headline rating is switchable

- **Mark:** "are we able to switch between these modes? … is the 3rd down default but these other categories are silently being left on the server hidden behind the server? because these ratings are probably awesome for the UI" → "1,2,3".
- **State before:** the six subject ratings were on the page (tiles + coach deck) but the hero ring was hard-wired to third down. **Footgun (mine):** Rate differently listed every saved definition regardless of `subject`, and `/teams/X/home?definition=` accepted any of them — picking "Sports-Rater Offense" scored an offense formula over third-down plays only. A plausible-looking wrong number with provenance proving it was computed exactly wrong.
- **1 · Fix:** `definitionSubjectMismatch(def, subject)` — Home, `/ratings/third-down`, `/ratings/third-down/league` and `/ratings/compare` return 400 for a non-third-down definition (the message points at the right subject route); `/rating-definitions?subject=` filters; Rate differently only offers the active subject's formulas and saves custom ones under that subject with only that subject's metrics.
- **2 · Feature:** headline picker on the hero (Third Down · Offense · Defense · Red Zone · Explosiveness · Ball Security), `?headline=offense` in the URL, tiles switch it on click and mark the active one. Switching is a re-render, not a rebuild: every subject's default rating is already in the Home payload (`ratings[]`), so the ring, rank and definition line paint instantly; the components table is one cheap `/ratings/{subject}` fetch. Third down keeps the full Home rating (trend follows the formula).
- **3 · Follow the subject:** label, Why? question (`SUBJECT_Q`), League (new `/api/v1/ratings/{subject}/league` from `rankings()` — score, sample, provisional, rank movement vs a week earlier; third down keeps its richer table), Rate differently (re-rates in place for non-third-down subjects; compare stays third-down only, as the engine's compare is).
- Not in this PR: the Home snapshot is still keyed by third-down definition only — a custom non-third-down formula is not persisted as the headline across reloads (URL carries the subject, not the formula). Trend chart stays third-down when another subject is the headline; the per-subject `/trend` route exists if we want it to follow.
- Tests: subject mismatch + filter helpers; static guard for picker/URL/League/Rate-differently/server refusal. 92/92 both stores. Live on the local store: see PR.

## 2026-09-04 — v0.9.3 · coach deck: clipped tables, smeared headers, all-or-nothing load

- **Mark:** coach mode "never fully loads properly" once (recovered after a reboot), and when it does "loads eventually but ugly" — screenshot: component tables cut off on both sides (C of COMPONENT, E of EPA, PTS column), panel titles and sub-lines smeared into two columns.
- **Clipping (root cause):** `.cpanel` is a grid item; grid items default to `min-width: auto`, so each panel grew to its table's intrinsic width instead of letting `.tbl`'s `overflow-x: auto` scroll. Two over-wide panels in a two-column grid overlapped each other and the deck edge. Fix: `min-width: 0` on the item, `max-width: 100%` on the table wrapper — the pro scrollbar now does its job.
- **Headers:** `.tile-h` is flex space-between (right for one-line tile titles, wrong for title + long sub). Coach panels get a stacked header: uppercase title with the score in mono accent, mono sub-line beneath.
- **Load (root cause of "never fully loads"):** two `Promise.all` waves — nothing painted until the slowest of nine store-bound requests returned (they queue on the single worker; during a Home rebuild that is seconds each) — and no try/catch around rendering, so any thrown render error left the skeleton bars forever. Third-down and scan failures were also skipped silently (my own rule, broken). Now every panel gets a placeholder immediately and fills in as its own request lands (`Promise.allSettled`); every failure is named in its panel and logged; the second scan panel says so when the shared scan request fails; the sub-line counts `ok/6 ratings`.
- **Not ours:** the console error Mark saw — `et.reportAllChanges … requestIdleCallback … Cannot read properties of undefined (reading 'startTime')` in `VM370` — is not in our client (zero matches for `reportAllChanges` / `startTime` / `requestIdleCallback`; we load exactly one script, `/app.js`). That stack is the web-vitals library inside an injected script: a browser extension or Cloudflare Web Analytics' RUM beacon. Live HTML served by the origin carries only `/app.js`, so if it recurs it is edge- or extension-injected. It cannot block our module either way.
- Tests: static guard — allSettled per-panel, no `Promise.all([` wave, failures named + logged, `min-width: 0` / `max-width: 100%` present. 90/90 both stores. Not browser-verified here (Mark's rule); verify: Coach → deck panels appear one by one, tables scroll inside their panel instead of clipping.

## 2026-09-04 — v0.9.2 · League and Rate differently posted into a hidden view

- **Mark:** "When I click 'League' label or even if I click 'Rate differently' nothing happens."
- **Root cause (mine):** every interactive card is prepended into `#feed`, which since the Dashboard | Feed split lives inside `#feedview` — `display: none` while the Dashboard shows. `ask()` and `openRecorded()` switched views first; **League, Rate differently, the Rate-it tile and the handle card did not**, so from the Dashboard their cards landed in an invisible container and `scrollIntoView` on a hidden node did nothing. Four dead buttons, one cause.
- **Fix:** one `showCard(card)` helper — switch to the Feed view (silent, URL synced), prepend, scroll — used by all six call sites. The boot-time "CHALK API unreachable" error now prepends into `<main>` (it must be visible whatever view is active). Coach mode still hides Rate differently by design (fan-layer control).
- Tests: static guard — no `$("#feed").prepend(` outside `showCard`; the four functions render via `showCard`. 89/89 both stores.

## 2026-09-04 — v0.9.1 · the data stamp counted runs, not data

- **Mark:** "it keeps flashing: Computing from the full season's plays — first look at this team since the data changed (~30s)… but theres no new data, the next game is like Sept. 14."
- **Trigger:** the in-process watch tick (every `CHALK_WATCH_INTERVAL`, default 1800 s). **Root cause:** the Home snapshot stamp was `count(football_ingest_events) + count(football_pulse_events)`. Every tick writes one row of each even when `plays_new=0 changed=0` (`run_id` includes `started_at`), so the stamp moved every 30 minutes, every snapshot read as stale, Home rebuilt on a timer (~30 s on the VPS) and the banner told fans the data had changed when nothing had.
- **Fix:** `dataStampFrom(ingestEvents, pulseEvents)` (pure, `src/server/home.ts`) = `w<seq>:p<seq>` — the highest `nedb_seq_after` of an ingest run that actually wrote or changed raw / normalized / context rows, and the highest `nedb_seq` of a pulse tick that wrote raw / game-state rows. Do-nothing ticks leave it alone. The watcher's "data changed" log line now names old → new stamp and how many runs/ticks are on record. Snapshots stamped by the old scheme read as stale exactly once after this deploy (one rebuild per team), then hold.
- Not in this PR (known): the stamp is still data-only — a deploy that changes rating math does not invalidate snapshots (`?fresh=1` or `HOME_SNAPSHOT_VERSION` bump). Also the watcher now reads the two event collections in full every 60 s; they grow by two rows per watch tick — fine for a season, revisit before it isn't.
- Also corrected the v0.9.0 entry below: it claimed the coach register was verified live on the local store; it was not (no LLM key locally).
- Tests: `dataStampFrom` / `ingestRunWrote` / `pulseTickWrote` — do-nothing ticks hold the stamp, writes move it, held stamp reads fresh.

## 2026-09-04 — v0.9.0 · Coach mode is a real mode

### SHIPPED
- **Mark:** "it seems like coach and fan modes are the same effects." They were: a body class, a shorter hero, and a table inside answer cards. Now Coach is a different room.
- **Coach deck** on the Dashboard (coach mode only): every rating's components table (weight, raw, league median, percentile, rank, points) for all six subjects; third down by distance; weakest / strongest situations from the scan with EPA vs team; this week's opponent by situation. Fetched from the existing deterministic endpoints, rendered as dense mono tables; fan-layer controls (Fans tile, Rate it, takes, Rate differently) hidden; hero shortened; mono numerals.
- **Coach register for GLM**: `EXPLAINER_SYSTEM_COACH` — same hard rules (numbers only from EVIDENCE, sample-honest), different room: lead with situation + number, cause the evidence shows, what to attack / what to fix, terse, no fan framing. Ask carries `mode`; the observation records `register`; **the evidence key includes the register** so a fan answer is never served from the record to a coach or vice versa. Regenerate preserves the original register. PROMPT_VERSION 0.5.0 (invalidates all prior record keys — every first ask streams fresh once).
- Badges: `coach read` on live coach answers and on recorded coach answers in the Feed.

### VERIFIED ON THE REAL SYSTEM
- Tests: prompt selection, key separation, static deck/mode wiring; 86/86 both stores. Live on the local store: all nine coach-deck endpoints answer 200 for TB 2025. NOT verified locally: `register: coach` on a stored observation — the local serve has no LLM key, so both asks skipped the explainer (the earlier version of this line claimed otherwise; corrected in v0.9.1). First proof is the first coach ask on the VPS.

---

## 2026-09-04 — v0.8.9 · the mark: a chalk tick, a red dot — favicon, app icons, header brand

- **Mark:** "custom favicon and iconic logo for me?" One vector we own (`web/icons/mark.svg`): near-black rounded tile, a bold chalk stroke (white → lime gradient, faint chalk-dust halo, grain) shaped as a tick that reads as both a yard-line mark and a rating check, and a single red dot — the "RATER" accent. `favicon.svg` (halo-free for 16 px), `mark-mono.svg`, PNG set 16/32/48/180/192/512 + maskable 512 rendered from the same geometry (supersampled), `favicon.ico` (16/32/48), `site.webmanifest`. Both pages link the set; the mark sits in the header before SPORTS RATER. `chalk.svg` aliases the mark for old links. Static test guards the whole set.

---

## 2026-09-04 — v0.8.8 · boot banner: CHALK in block letters, Vex × Interchained LLC, live metadata

- **Mark:** "the process loader needs ASCII: CHALK and our own signatures Vex × Interchained LLC and more metadata … so when I run `node bin/chalk.ts serve` I see nice art and more metadata about us builders." `src/server/banner.ts`: block-letter CHALK, signature `Vex × Interchained LLC`, builders line (Mark · Vex (Claude Fable 5.1) · The Oracle (GPT-5.5)), the four-line doctrine, then a metadata block read from the running process — command, version + git sha, store mode + data dir, nedb-engine version, listen address, LLM provider/model/key state, defaults, watch season/interval/deep, admin on/off, telemetry on/off, node/platform/pid, license + licensor, copyright, home/repo. ANSI colour only on a TTY without NO_COLOR; plain in journald. `chalk --version` prints the one-line signature.

---

## 2026-09-04 — v0.8.7 · WSH is a team; provenance drawer is a graph, not a dump

- **From Mark's live Feed paste:** the team picker shows `WSH` — NFLData's abbreviation for Washington is `WSH`, not `WAS`, so the Commanders had no name, color, logo or hero. `TEAMS` gains `WSH`; `web/logos/wsh.png` and `web/hero/WSH.jpg` added (aliases of the WAS assets); the asset tests cover the new key automatically.
- Provenance on a recorded card printed the whole record set — including up to 500 evidence ids — into the drawer. Both cards now share `renderProvenance()`: record counts by collection, one line per node (collection · label · hash prefix), an evidence-count line, and a link to the raw JSON.

---

## 2026-09-04 — v0.8.6 · Interchained LLC everywhere: SPDX BUSL-1.1 headers on every file, visible in the product

- **Mark:** "make SPDX on every single page or component, just sprinkle INTERCHAINED LLC all over." 80 files stamped (every .ts/.js/.css/.html/.md/.conf/.service/.example outside node_modules and the image dirs): `SPDX-License-Identifier: BUSL-1.1` · `Copyright (c) 2026 Interchained LLC. All rights reserved.` · `Licensor: Interchained LLC`. Shebang and doctype lines preserved.
- Visible in the product: site footer legal line (© Interchained LLC · BUSL-1.1 · Licensor), `<meta name="copyright">`/`author` on both pages, admin footer, `/api/v1/meta.license` (spdx/name/licensor/copyright), `x-powered-by: CHALK (Interchained LLC) · BUSL-1.1` on every JSON response, OpenAPI `info.license` + `contact`. `package.json` gains `author` and `copyright`.
- Guard: a static test walks the tree and fails the build on any source/page/style/deploy file missing the header.

---

## 2026-09-04 — license: CHALK stays BUSL-1.1

- Mark: CHALK stays under the Business Source License 1.1 (Interchained LLC, licensor). PR #30 relicensed to GPL-3.0-only on a misread of the ask; PR #31 reverts it in full — `LICENSE`, `package.json`, `package-lock.json`, README footer and OpenAPI `info.license` are BUSL-1.1 again. No code change.

---

## 2026-09-04 — v0.8.5 · embedded engine on a worker thread: the HTTP thread never blocks on a scan

### SHIPPED
- **Mark (VPS):** "logs say rebuilding in background but it's stalled there." Root cause: `NedbCore.query/put/verify` are SYNCHRONOUS napi calls. `buildHome` = ~8 season-scale scans ≈ 25 s on the VPS, and it ran on the HTTP thread — so "rebuilding in background" froze every request (the 502s and 4 s Home responses seen earlier were the same thing). Trigger: stale snapshot after two ingest ticks. Root cause: synchronous engine on the serving thread.
- `src/store/embedded_worker.ts` (worker entry: opens EmbeddedStore, answers `{id, method, args}`, forwards engine log lines and cache-hit events) + `src/store/worker_store.ts` (`WorkerStore implements Store`: promise-per-message proxy, ready/fatal handshake, crash/exit surfaced to every pending call, `close()` flushes then terminates). `chalk serve` boots the engine on the worker (`store: embedded NEDB at … (engine on a worker thread)`); one-shot CLI commands stay in-thread; `CHALK_EMBEDDED_WORKER=0` forces in-thread for serve. Shutdown awaits the flush.

### VERIFIED ON THE REAL SYSTEM
- Tests: full Store surface across the thread boundary (put/get/query/queryAt/batchPut with Map/head/seq/verify/trace/client.*, cache TTL + hit events + invalidate, error propagation, closed-store rejection); event-loop liveness under 30 concurrent scans; 81/81 both stores. Live on the local 48,771-play store: `/home?fresh=1` (≈11 s rebuild) running while `/health` answers in single-digit ms — before this change the same probe waited for the rebuild.

---

## 2026-09-04 — v0.8.4 · Dashboard | Feed tabs move into the header bar

### SHIPPED
- **Mark (with screenshot, hero live on the VPS):** the tabs floated in open space between the header and the hero, pushing the hero down. They now live in the sticky header as its middle column (brand | tabs | controls); the hero starts flush under the bar. Small screens: brand + controls on row one, tabs on row two — still inside the bar. Static test asserts the tabs are inside `<header>` and nowhere after it.

---

## 2026-09-04 — v0.8.3 · admin moderation: hide / unhide / regenerate — the human in the loop

### SHIPPED
- **Mark:** "admin should be able to regenerate or delete posts from the feed … if something errored we don't know how to programmatically determine that; the admin can see it." Today's CIN-defense answer that described the offense is the canonical case: plan ok, model answered, no error, no truncation — and wrong. Worse, the Record would have served it to every fan whose inputs matched, forever.
- `src/server/moderation.ts`: `football_moderation` rows (`mod:<coll>:<id>`, caused_by the target's hash, with reason/by/time). **Hide** removes an item from the Feed, the Record strip, the fan feed AND serve-from-record (`findObservation` / `listRecord` / `feed` consult the hidden set). **Unhide** writes a new version with `hidden:false`. Nothing is deleted; the chain and the evidence of what was said and why it was pulled both stay. Applies to CHALK answers, fan takes and fan ratings.
- **Regenerate** (`POST /api/v1/admin/regenerate {id, reason}`): re-plans, re-executes and re-explains the stored question live (non-streaming), stores the new observation beside the old, hides the old with reason `regenerated → <new id>`. Returns the new plan's intent/source/fallback flag, statements and answer so the admin can judge it on the spot.
- Admin panel: "Feed moderation" tile — Answers | Fan takes | Moderation log, show-hidden toggle, per-item reason field, Hide/Unhide, Regenerate, raw link. `GET /api/v1/admin/feed` lists recent answers/takes with hidden state + the log.

### VERIFIED ON THE REAL SYSTEM
- Tests: hide → gone from record/feed/serve-from-record; unhide → back; one moderation row with two versions; fan take hide; validation; missing target rejected. 78/78 both stores. Live: hide/unhide round trip on a local serve; regenerate needs the LLM key (VPS).

---

## 2026-09-04 — v0.8.2 · team logos vendored (no hotlinking)

### SHIPPED
- **Mark:** "we cannot hotlink team logos — vendor them." 32 logos pulled once, normalized to NFLData abbreviations, downsized to 256 px PNG (the UI renders ≤ 112 px), `web/logos/{abbr}.png`, 915 KB total; `lar.png` aliases the Rams. Default template `/logos/{abbr}.png`; no third-party CDN in the request path, no referer leak, no outage we do not own. `CHALK_TEAM_LOGO_URL` still swaps the source; `CHALK_TEAM_LOGOS=0` still turns the feature off. Disclaimer unchanged.

### VERIFIED ON THE REAL SYSTEM
- Tests: resolver points every TEAMS entry at an existing vendored file in a sane size range; alias LAR → la.png; 77/77 both stores.

---

## 2026-09-04 — v0.8.1 · team hero: 32 generated field atmospheres, full-bleed, bevelled, cut by the dashboard

### SHIPPED
- **Mark:** "a header hero under the nav, wide as the screen, gradient stroke, bevel embossed, cut off halfway, customized for each team with generated field images." 32 ultra-wide (21:9) images generated with Nano Banana 2 — empty stadium field at dusk in each team's palette and city atmosphere; **no logos, no players, no text, no marks** (we own them, and they stay clear of the trademark question the logos raise). Encoded 1800 px progressive JPEG q80, ~200 KB each, `web/hero/{ABBR}.jpg` (LAR aliases LA).
- `#team-hero`: full-bleed (`100vw`, escapes `main`), 50vh, gradient stroke drawn by a 2 px padded frame (accent → transparent → accent), inset bevel/emboss (light top lip, dark bottom lip, soft drop shadow), rounded bottom, vignette so the type over it stays legible; the dashboard rises over its lower half via a negative margin. Two stacked layers crossfade on team switch after preload; missing file ⇒ gradient fallback (logged, never a broken image). Hidden in Feed view; shorter in Coach mode and on phones.

### VERIFIED ON THE REAL SYSTEM
- Static test: every team in TEAMS has a hero file in a sane size range; markup + JS wired; 76/76. Visual spot-check of ARI.jpg (dusk field, mountains, lights, no marks). Post-deploy: browser check of hero + crossfade on team switch.

---

## 2026-09-04 — v0.8.0 · env-gated admin panel: usage, heatmaps, unanswered questions, fans, preferences, health

### SHIPPED
- **Mark:** "an admin panel env gated with all usage stats and heatmap and user preferences and anything we can learn about the users." Constraint kept: the footer promises no accounts / no personal data, so the panel learns from rows CHALK already writes for provenance (query_events, observations, sr_*, ingest/pulse events, home snapshots) plus one deliberately anonymous telemetry row per page view / tab / ask (`sr_telemetry`: team, season, mode, view, viewport bucket, fan handle if one exists — never IP or UA; `CHALK_TELEMETRY=0` disables; rate-limited per address like fan writes).
- `src/server/admin.ts` — `adminOverview(store, {season, windowDays})`: asks per day + hour×weekday heatmap, from-the-record hit rate, fallback / could-not-plan / error counts, intents, teams, team×intent matrix, p50/p95 end-to-end / LLM / engine latency; top questions and the **unanswered / unsupported / errored** list (the tool-gap radar — today's game_rank and CIN-defense bugs would both have appeared here); planner fallbacks with their rejection reasons; answers (complete/truncated/errored, models, reaction tallies, most-reacted); fans (total, active 7d, writes, top handles by chain length, consensus per subject, rating distribution); preferences (teams, seasons, modes, tabs, viewports, events, visit heatmap, returning handles); health (seq/head, ingest runs, pulse ticks, home snapshots + stamps, season audit).
- Gate: `CHALK_ADMIN_TOKEN` (≥16 chars, constant-time compare). Unset ⇒ `/admin`, `/admin.js`, `/admin.css`, `/api/v1/admin/*` are 404. Token lives in the admin tab's sessionStorage only.
- `web/admin.html|css|js`: tool-grade dense layout — KPI strip, sparkline, two heatmaps, bars, team×intent matrix, question lists with reasons, health.

### VERIFIED ON THE REAL SYSTEM
- Tests: auth matrix (exact match, short/unset refused), telemetry validation drops ip/ua and rejects garbage, full aggregation over a seeded store; 75/75 both stores. Live on the local serve: without the env `/admin` → 404; with it → 200, `/api/v1/admin/overview` 401 without bearer, 200 with; `POST /api/v1/telemetry` 202 and the row appears in preferences.

---

## 2026-09-04 — v0.7.6 · the Feed is a first-class view; holo shimmer; pro scrollbars

### SHIPPED
- **Mark:** "I don't see completions after a basic refresh … where's the Feed of live completions?" They were there — hydrated, 5 cards — 2,300 px below the fold under the whole dashboard grid (measured in a real browser). Dashboard stays as is; the Feed is now its own view.
- `Dashboard | Feed` tabs under the header (sticky, count badge = answers on record). Feed view = every completion for the team/season newest-first (hydrated, paginated, infinite scroll), suggestions row, and a 30 s poll (`pollFeed`) that prepends answers from other fans with a flash; ↻ refresh pulls now. `ask()` switches to the Feed so the streaming card is on screen; Record-strip taps open in the Feed. `view=` URL param round-trips.
- Holo shimmer: skeletons and loading overlays use a multi-hue gradient (accent / blue / accent / pink) at 1.6 s instead of flat gray.
- Pro scrollbars for coach tables, the Record strip and code blocks: thin, accent-gradient thumb, transparent track, right-edge fade on tables so horizontal overflow is legible.

### VERIFIED ON THE REAL SYSTEM
- Static tests (tabs, setView, ask→feed, CSS view gating, holo keyframes); 72/72. Browser check after Mark deploys: Feed tab shows the stored answers immediately; asking lands the card at the top of the Feed.

---

## 2026-09-04 — v0.7.5 · Coach mode blanked the page (body matched `.coach { display:none }`); dead mode button; client guards

### SHIPPED
- **Mark:** tapping the Fan/Coach toggle → URL gains `mode=coach`, screen goes black, no server error. Reproduced in a real browser against sports-rater.com: DOM fully populated (ring 66, 9 tiles, 6 rating cards, 5 history cards), screenshot solid #07090d, computed `body { display: none }`. Root cause: `applyMode` toggles class `coach` on `<body>`; `styles.css` had a bare `.coach { display: none }` intended for the coach-view box inside answer cards. Present since the toggle was added — every Coach-mode use ever hid the page. Fix: rule scoped to `.card .coach`; body class renamed `mode-coach`.
- Second live-reproduced bug: `Uncaught TypeError: history.replaceState is not a function` on every team/season/mode change — v0.7.2 declared a module-level `const history = {…}` for feed pagination, shadowing `window.history`. Renamed `hist`.
- Guards: `boot().catch` renders a visible failure card instead of a dark shell; `tests/client_static.test.ts` fails the build on any module-level declaration shadowing a window global and on any bare class selector that could hide `<body>`; `index.html`/`app.js`/`styles.css` now served `cache-control: no-cache` so a deploy can never leave a browser on last week's client.

### VERIFIED ON THE REAL SYSTEM
- Live site: removing the class in the browser flips `body` from `display: none` to `block` and the page paints — causal chain confirmed before the fix shipped. After Mark pulls: toggle Coach → page stays, URL updates, no console error.

---

## 2026-09-04 — v0.7.4 · badge taps always plan; rating subject aliases repaired; rule planner never throws

### SHIPPED
- **Mark:** tapping ACHILLES HEEL · SUCCESS RATE asked "Why does Tampa Bay have the achilles heel · success rate badge?" → `fallback` + "CHALK could not turn that into a football query — filters.subject: unknown \"success\"". The model wrote `subject: "success"` (a metric, not a subject) and the validator rejected it; the rule planner had no mapping for success/epa/badge names and, had it produced anything invalid, `mk()` threw straight out of the ask.
- `ratingSubjectFor(words)` maps metric words and every badge name to the subject whose components carry that metric (success/efficiency/EPA/steady/inconsistent → offense; converts/money down → third_down; big play/dink and dunk → explosiveness; protects the ball/loose ball/turnover → ball_security). Badge questions with an unrecognised word default to offense — a badge tap can never fail to plan.
- `normalizeRatingSubject` repairs model aliases ("success", "Success Rate", "turnovers", "third-down") in the validator instead of rejecting; unknown subjects get an error that lists the valid ones.
- `rulePlan` wraps its body: an invalid plan of its own making is logged and reported as "could not interpret", never an exception out of the ask handler.

### VERIFIED ON THE REAL SYSTEM
- Tests: the exact question → rating/offense; five badge names → subjects; alias repair; unknown subject error text; 68/68 both stores. Live: the exact question on the local store → `rating {TB, 2025, offense}` with the offense statements (success rate 27th percentile named as weakest component).

---

## 2026-09-04 — v0.7.3 · opponent_report: "the CIN defense" scouts the defense; model plans repaired instead of rejected

### SHIPPED
- **Mark:** "What should I know about the CIN defense?" → badges `opponent_report · rules · fallback`, log `planner: model plan rejected: opponent_report needs filters.opponent — falling back to rules`, and every statement described the CIN **offense**. Two bugs. (1) The validator rejected a model plan that had put CIN in `team` and left `opponent` empty — the model meant "scout CIN"; the validator now repairs it (non-default team with no opponent ⇒ that team is the opponent; then the schedule; only then an error that says why). (2) The rule planner flipped to defense only on the literal phrase "their defense"; "the CIN defense" / "defensive front" now scout the defense (an explicit "offense" mention still wins for offense questions).
- Prompt makes the team/opponent roles explicit with the exact example; PROMPT_VERSION 0.4.1. `opponent === team` is rejected with a named reason.

### VERIFIED ON THE REAL SYSTEM
- Tests: rule routing for defense/offense/next-opponent phrasings; validator repair of the exact rejected plan; schedule fallback; explicit errors; 67/67 both stores. Live: the exact question on the local store plans `opponent_report TB vs CIN side=defense` and the statements read "Offenses facing CIN …".

---

## 2026-09-04 — v0.7.2 · the feed is the record: persistent, paginated answer history

### SHIPPED
- **Mark:** "did you get around to making the requests and responses persistent … the entire history of completions present in the feed? Paginated, professional shimmers." Persistence was already true (query_events + observations); presence in the feed was not — the answer feed started empty on every load.
- `listRecord` paginates by NEDB seq (`beforeSeq` cursor, `next_before`, `total`); `GET /api/v1/record?team&season&limit&before`.
- Client: on load and on team/season change the feed hydrates with stored completions as full cards (`recordedCard`: statements, answer, `from the record · age`, agree/disagree on the observation, Provenance, Re-ask live), 10 per page, infinite scroll via IntersectionObserver on a "N older answers" sentinel, three skeleton cards while each page loads, empty state when nothing has been asked. Live asks prepend and are tagged with their observation id so hydration never duplicates them; Record-strip taps scroll to the card if it is already in the feed.

### VERIFIED ON THE REAL SYSTEM
- Tests: cursor pagination (page/next/exhausted, ordering, total); 66/66 both stores. Live: `/api/v1/record?team=TB&season=2025&limit=2` then `&before=` walks the 5 stored answers in order.

---

## 2026-09-04 — v0.7.1 · badges for everyone: tier-2 thresholds + SIGNATURE / ACHILLES HEEL identity badges

### SHIPPED
- **Mark:** "no badges earned — let's make sure every team earns something." Eight top/bottom-10% badges meant most teams (TB included) showed nothing.
- Tier 2 badges at the top/bottom quarter for the same five metrics (CONVERTS / STALLS ON THIRD, POSITIVE / NEGATIVE PLAYS, BIG PLAY THREAT / DINK AND DUNK, PROTECTS THE BALL / LOOSE BALL, STEADY / INCONSISTENT). One badge per metric+side: a tier-1 qualifier does not also get the tier-2 one.
- Identity badges, always awarded when the team has the minimum sample: **SIGNATURE · <trait>** (highest league-oriented percentile across EPA/play, success, explosiveness, ball security, third down) and **ACHILLES HEEL · <trait>** (lowest). Same population, same rank/percentile/sample fields, versioned 1.0.0; `kind` field (`tier | signature | heel`) on every EarnedBadge. Client sorts tiers first, styles identity badges dashed, and asks "signature strength / biggest weakness" questions on tap.

### VERIFIED ON THE REAL SYSTEM
- Tests: every team in a 12-team synthetic league earns ≥ 2 badges with exactly one signature and one heel on different metrics; no duplicate tier per metric+side; small-sample and tiny-league guards unchanged. Live: TB 2025 Home now carries badges (see PR body for the exact set).

---

## 2026-09-04 — v0.7.0 · The Record: answers served by provenance, browsable per team

### SHIPPED
- **Mark:** "are we caching the LLM responses and serving those too? … a mix of both." Before: every answer was stored as a `football_observations` row and never read back; every click was a fresh GLM stream.
- `src/llm/record.ts` — `evidenceKey(plan, pkg)`: hash of intent + filters + calculation hashes + evidence count + summary + prompt version. Same key ⇒ the explainer's inputs are byte-identical ⇒ the stored answer is correct by construction. Any data change alters the calculation hashes and the key. `findObservation` returns the latest complete (non-error, non-truncated) answer for a key. `listRecord` lists a team's answers newest-first with fan reaction tallies joined.
- Observations now carry `team`, `season`, `evidence_key`, `statements`. Ask flow: after the evidence event, a matching observation is served instantly (`from_record: true`, `recorded_at`); `live: true` in the body forces a fresh stream and stores a NEW observation beside the old — the record is append-only. Boot creates eq indexes on `observations.evidence_key` and `.team`.
- `GET /api/v1/record?team=TB&season=2025&limit=20`. Client: "The Record" strip on Home (horizontal cards: question, first statement, model, age, 👍/👎); tap → the stored answer opens as a card with agree/disagree (target the observation), Provenance, and **Re-ask live**. Live answers get a `from the record · 2h ago` badge when served from storage, plus Re-ask live.

### VERIFIED ON THE REAL SYSTEM
- Tests: key determinism/invalidation matrix; find latest-complete semantics (failed + truncated skipped); per-team listing order + reaction join; 66/66 both stores. Live: `/api/v1/record` on the local serve (no LLM key locally, so serve-from-record itself needs the VPS: first ask streams, second identical ask shows `from the record`).

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
