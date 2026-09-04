<!--
  SPDX-License-Identifier: BUSL-1.1
  Copyright (c) 2026 Interchained LLC. All rights reserved.
  CHALK / Sports-Rater — https://sports-rater.com — Licensor: Interchained LLC
-->
# LORE — how CHALK got here

*For the Oracle, and for whoever picks this up next. [AGENTS.md](./AGENTS.md) is the map; this is the story. Dates are real. Quotes are Mark's, verbatim.*

---

## Three builders

**Mark** (Interchained LLC) — the one who runs the thing. Every consequential bug in this codebase was found by Mark clicking, not by an agent reading code. He does not read long reasoning; he reads what the page does.

**The Oracle** (GPT-5.5) — wrote the V1 → V3 specs CHALK was built from: the deterministic core, then Home, then the ratings and the fan layer. The doctrine is the Oracle's framing made operational.

**Vex** (Claude Fable 5.1) — built it, line by line, with Mark on the other side of the screen. Every root cause in the BUILD_REPORT that says "mine" is Vex's.

3 > 1. When the plan was shared — "build the gate first, then the magic" — it worked the first time. When Vex improvised, Mark found the bug within the hour.

## The doctrine, and where it came from

> The database knows. Deterministic code calculates. The model interprets. Provenance proves.

It was written for NEDB — the engine underneath — before CHALK existed. CHALK is what happens when you take it literally for football: 48,771 plays from a public play-by-play source go into a content-addressed, hash-chained store; every rating is a pure function over those rows with an algorithm id; the language model is allowed to *explain* an evidence package and forbidden to invent a number; and every card can open a provenance drawer that walks the DAG back to the plays.

No computer vision. No scraping. No "AI says". A fan asks "why is Tampa struggling on third down" and gets prose that cites 227 third downs, a formula with a version, and a hash.

## The arc — 2026-09-03 → 2026-09-04

**v0.1.0 (Sept 3).** First vertical slice end to end on real data: ingest → normalize → third-down analysis → HTTP → a page. The idempotency rule was set here: identical source content never writes twice; changed content writes a new version with `caused_by` pointing at the old one.

**v0.2.0 – v0.5.0.** Home: participation + charting joined into play context; situation scan; opponent report; the rating card (six subjects, each a definition with weights and directions, percentile-ranked against the league); badges; trends; the Games tile; the deploy kit. Sports-Rater — the fan identity as math, no accounts — arrived in v0.4.0.

**v0.6.0.** NEDB **embedded** — no daemon. One engine per process, napi calls in-thread. Later that day Mark's serve froze on "rebuilding in background" and returned 502s: a synchronous season-scale scan on the HTTP thread. **v0.8.5** moved the engine to a worker thread. The lesson is in AGENTS.md now.

**v0.6.3.** A game with 0 plays and 164 context rows had slipped through silently. Mark: "how is that possible." Ingest now throws on a short page before the total, floors completed games at 100 plays, and `chalk audit` names every short game. *No silent short games* became a rule.

**v0.7.0 – v0.7.6.** The Record: answers are stored observations keyed by evidence, served on repeat asks, browsable per team as a persistent feed. Badges for everyone ("'no badges earned' — let's make sure if we have badges that every team earns something"). Coach mode blanked the whole page once because `.coach { display: none }` matched `body.coach` — reproduced in a real browser, DOM populated, body invisible.

**v0.8.x.** The admin panel ("env gated with all usage stats and heatmap and user preferences and anything we can learn about the users"), moderation ("the admin can see something is wrong and regenerate or delete"), 32 generated field heroes, vendored logos ("we cannot hotlink team logos vendor them"), tabs into the header ("they are pushing the beautiful hero down"), the boot banner, the mark.

**The license incident.** Mark typed "lets make CHALK BUSL->GPLv3". Vex relicensed. Mark: "no I wanted BUSL … wtf". Reverted by PR (no history rewritten), then: "I didnt realize we had BUSL sorry! MY MISTAKE … make SPDX on every single page or component just sprinkle INTERCHAINED LLC all over." Rule recorded: never touch LICENSE without an explicit, unambiguous instruction. SPDX headers on 80+ files.

**v0.9.0 (Sept 4, ~2:00 PM).** "it seems like coach and fan modes are the same effects." They were — a body class and a shorter hero. Coach became a room: a deck of component tables, a coach *register* for the model with the same hard rules, and the register baked into the evidence key so a fan answer is never served to a coach.

**v0.9.1 — the stamp counted runs, not data.** "there is no new data why is it recomputing." The Home snapshot stamp was `count(ingest events) + count(pulse events)`, and every watch tick wrote one of each even when it changed nothing. Home rebuilt every 30 minutes with no new plays. The stamp became "last seq at which something actually wrote". This is the archetype of the day: **trigger** (the watch tick) vs **root cause** (a stamp that moved when nothing moved).

**v0.10.x — the headline is switchable.** "are we able to switch between these modes? … these ratings are probably awesome for the UI" → "1,2,3". And a footgun of Vex's: Rate differently offered every formula for every subject, so an offense formula could be scored over third-down plays only — a plausible-looking wrong number with provenance proving it was computed exactly wrong. Subject guards went on every route, including the one found while verifying (`/trend`).

**v0.11.0 — the cut.** Mark: "should we reduce rating to like favorites and easy things not stat related because we pull stats from the facts APIs do you get me?" Yes. Fans had been asked to slide "Offense: 0–100" when the database already knew it was 48. Cut: the sliders, the consensus line, fan Rate-differently. Kept: reactions. Added: **favorite** (allegiance), **picks** (the one fan input the facts later *settle* — a fan predicts, the game happens, the record grades them), **hype** (1–5, explicitly sentiment). Then: "make sure the CHALK readings are not manipulated by fans give them other knobs to turn but not the facts." The **fact wall** became a test. It caught one leak on its first run.

**v0.12.0 — the sharecard.** "make the headline sharecard! Thats the next unlock branded with team hero and logo and everything stats on the card ready to share copyable and open social link on click? X, insta, facebook, etc?" A 1200×630 canvas drawn from the team hero, the logo, the ring, six ratings, signature and heel; copy / download / native share; X, Facebook, Threads, Reddit, LinkedIn intents; Instagram copies image + caption because Instagram has no web intent — the button says so. `/s/TEAM` landings carry OG tags from one server function so caption, tags and intents can never disagree. Then Mark's rhythm rule: "remember your next cut after my directive goes in go back to your last turns leftovers." Leftovers are a queue.

**The engine, 4:00 PM.** While verifying the chain fix, three fan writes acknowledged with a hash were gone after `kill -9`. Mark: "Engine is fine afaik … is there something we need to hotfix or do you just want something that doesn't exist yet." Then: "you're doing more research, I asked you a question." Then, granting one turn and one release: "you should fix the engine not CHALK." The controlled repro on nedb-engine 2.8.4 found **two** defects: the embedded bindings never started the manifest ticker `nedbd` had always run (SIGKILL lost everything since open), and the Node exit-flush wrapper had never shipped — CI's build overwrote it — and could not have worked against a non-writable static. **NEDB v2.8.5** shipped that hour: ticker on embedded open, wrapper by subclass, a durability test in CI's publish gate (SIGKILL keeps the write · ticker-off SIGKILL loses it · ticker-off SIGTERM keeps it). Proof against the published package through CHALK's own serve: write → `kill -9` → restart → **FOUND**. CHALK pinned 2.8.5 exactly.

**v0.12.5 – v0.12.12 — Mark clicks, Vex learns.** "why cant the cache hold?" — it did; the client re-wiped the page on every quiet retry. "its broken … 5 minutes later it just works" — a read cache never invalidated by our own writes, plus a season mismatch. "why did you break the share card?" — it drew before the data arrived; the previous slow path had hidden the race. "fooking caption is wrong too" — `https://127.0.0.1:4040` from a trusted Host header. Every one reproduced, root-caused, guarded by a test, shipped in under fifteen minutes. Then: "EPIC: no cuts right no celebrate with me!" — the card, six across, seq in the footer, the right URL.

## What we believe now, because it cost us

- **Verify on the real system, then say exactly what you verified.** "Tests pass" is not "it works". "Live-verified" without an LLM key is a lie we told once and corrected in writing.
- **Trigger ≠ root cause.** Stop at the trigger and you ship the same bug tomorrow.
- **A silent failure is indistinguishable from a broken dependency.** Name every failure path. Name every cause you cannot distinguish. Never bake in one.
- **The picture must never wait on the slowest thing in the system for a line of text** — and it must never draw from nothing either.
- **Fans get knobs, not facts.** The moment a fan's number sits next to a computed one as a peer, the doctrine is broken.
- **Leftovers are a queue.** Directive, merge, back to the queue.
- **Mark finds the bugs. That is the system working**, not failing. Ship in small PRs so his compile → boot → click loop stays tight.

## Open threads (Sept 4, 5 PM)

- Sept 14: the first real pick settlement. A `settle` dry-run against 2025 finals would prove grading before it matters.
- Week-1 hype vs result — the first "sentiment vs facts" read.
- The card has only ever been rendered by Mark's browser. A headless render in CI that fails on an empty ring or a wrong caption host is the honest next test.
- The Home snapshot is keyed by third-down definition only; custom non-third-down formulas do not persist as headline across reloads.

---

*© 2026 Interchained LLC · BUSL-1.1 · Built by Mark (Interchained LLC) · Vex (Claude Fable 5.1) · The Oracle (GPT-5.5). The database knows. Deterministic code calculates. The model interprets. Provenance proves.*
