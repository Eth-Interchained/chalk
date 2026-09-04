/*
 * SPDX-License-Identifier: BUSL-1.1
 * Copyright (c) 2026 Interchained LLC. All rights reserved.
 * CHALK / Sports-Rater — https://sports-rater.com — Licensor: Interchained LLC
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, statSync } from "node:fs";
import * as fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(here, "../web/app.js"), "utf8");

test("client: no module-level declaration shadows a window global (history/location/navigator/document/window/name/status)", () => {
  // v0.7.2 declared `const history = {...}` for feed pagination and silently broke history.replaceState in syncUrl — every team/season/mode change threw.
  const bad = [...src.matchAll(/^(?:const|let|var|function|class)\s+(history|location|navigator|document|window|name|status|top|parent|self|screen|event)\b/gm)].map((m) => m[1]);
  assert.deepEqual(bad, [], `shadowed globals: ${bad.join(", ")}`);
});

test("client: boot failures are surfaced, syncUrl uses the real History API", () => {
  assert.match(src, /boot\(\)\.catch\(/);
  assert.match(src, /history\.replaceState\(/);
});

test("client css: no bare class selector can hide <body> — the coach-view rule is scoped to .card", () => {
  const css = readFileSync(path.join(here, "../web/styles.css"), "utf8");
  // The body carries mode classes (mode-coach). No top-level selector for them may exist that sets display:none.
  assert.doesNotMatch(css, /^\.coach\s*\{/m, "bare .coach selector would match <body class=coach>");
  assert.doesNotMatch(css, /^\.mode-coach\s*\{[^}]*display:\s*none/m);
  assert.match(css, /^\.card \.coach \{ display: none/m);
  assert.match(src, /classList\.toggle\("mode-coach"/);
});

test("client: Feed is a first-class view — tabs in markup, setView wired, ask() lands in the feed, poll for other fans' answers", () => {
  const html = readFileSync(path.join(here, "../web/index.html"), "utf8");
  assert.match(html, /data-view="home"/); assert.match(html, /data-view="feed"/);
  // Tabs sit INSIDE the header bar, not in open space between header and hero.
  const header = html.slice(html.indexOf("<header"), html.indexOf("</header>"));
  assert.match(header, /class="views"/, "view tabs must live inside <header>");
  const afterHeader = html.slice(html.indexOf("</header>"));
  assert.doesNotMatch(afterHeader, /class="views"/);
  assert.match(html, /id="feedview"/);
  assert.match(src, /function setView\(/);
  assert.match(src, /function pollFeed\(/);
  assert.match(src, /function showCard\(card[^)]*\) \{\s*if \(state\.view !== "feed"\) \{ setView\("feed", \{ silent: true \}\); syncUrl\(\); \}/);
  const css = readFileSync(path.join(here, "../web/styles.css"), "utf8");
  assert.match(css, /main\.view-home #feedview \{ display: none; \}/);
  assert.match(css, /main\.view-feed #home \{ display: none; \}/);
  assert.match(css, /@keyframes holo/);
});

test("client: every team in TEAMS has a hero image under web/hero, and the hero markup/JS are wired", () => {
  const teams = [...src.matchAll(/\b([A-Z]{2,3}): \["[^"]+", "#[0-9A-Fa-f]{6}"\]/g)].map((m) => m[1]);
  assert.ok(teams.length >= 32, `parsed ${teams.length} teams from TEAMS`);
  const missing = teams.filter((t) => !existsSync(path.join(here, `../web/hero/${t}.jpg`)));
  assert.deepEqual(missing, [], `missing hero images: ${missing.join(", ")}`);
  for (const t of teams) { const sz = statSync(path.join(here, `../web/hero/${t}.jpg`)).size; assert.ok(sz > 60_000 && sz < 600_000, `${t}.jpg ${sz} bytes`); }
  const html = readFileSync(path.join(here, "../web/index.html"), "utf8");
  assert.match(html, /id="team-hero"/);
  assert.match(src, /function setHero\(/);
  assert.match(src, /setHero\(state\.team\)/);
});

test("every source, page, style and deploy file carries the SPDX BUSL-1.1 header and the Interchained LLC copyright", () => {
  const { readdirSync } = fs;
  const root = path.join(here, "..");
  const skip = new Set(["node_modules", ".git", "chalk-data", "hero", "logos"]);
  const files: string[] = [];
  const walk = (d: string) => { for (const e of readdirSync(d, { withFileTypes: true })) { if (skip.has(e.name)) continue; const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.(ts|js|mjs|css|html|md|conf|service|example)$/.test(e.name)) files.push(p); } };
  walk(root);
  assert.ok(files.length > 40, `walked ${files.length} files`);
  const missing = files.filter((f) => { const head = readFileSync(f, "utf8").slice(0, 600); return !/SPDX-License-Identifier: BUSL-1\.1/.test(head) || !/Interchained LLC/.test(head); });
  assert.deepEqual(missing.map((f) => path.relative(root, f)), [], "files without the header");
});

test("brand: favicon/app-icon set, manifest and header mark are present and consistent", () => {
  const root = path.join(here, "..");
  for (const f of ["web/icons/mark.svg", "web/icons/favicon.svg", "web/icons/mark-mono.svg", "web/favicon.ico", "web/site.webmanifest", "web/icons/icon-16.png", "web/icons/icon-32.png", "web/icons/icon-180.png", "web/icons/icon-192.png", "web/icons/icon-512.png", "web/icons/maskable-512.png"]) assert.ok(existsSync(path.join(root, f)), `missing ${f}`);
  const manifest = JSON.parse(readFileSync(path.join(root, "web/site.webmanifest"), "utf8"));
  assert.equal(manifest.short_name, "Sports-Rater");
  for (const ic of manifest.icons) assert.ok(existsSync(path.join(root, "web", ic.src)), `manifest icon ${ic.src}`);
  const svg = readFileSync(path.join(root, "web/icons/mark.svg"), "utf8");
  assert.match(svg, /Interchained LLC/); assert.match(svg, /<circle[^>]*fill="#ff4b3e"/i);
  for (const page of ["web/index.html", "web/admin.html"]) {
    const html = readFileSync(path.join(root, page), "utf8");
    assert.match(html, /rel="icon" href="\/icons\/favicon.svg"/); assert.match(html, /rel="apple-touch-icon"/); assert.match(html, /rel="manifest" href="\/site.webmanifest"/); assert.match(html, /class="brand-mark" src="\/icons\/mark.svg"/);
  }
});

test("coach mode is a real mode: deck markup, loader, ask carries mode, fan-layer controls hidden", () => {
  const html = readFileSync(path.join(here, "../web/index.html"), "utf8");
  assert.match(html, /id="coach-deck"/); assert.match(html, /id="coach-panels"/);
  assert.match(src, /async function loadCoachDeck\(/);
  assert.match(src, /mode: state\.coach \? "coach" : "fan"/);
  const css = readFileSync(path.join(here, "../web/styles.css"), "utf8");
  assert.match(css, /\.mode-coach #tile-feed, \.mode-coach #take/);
});

test("every card dropped into #feed goes through showCard (v0.9.2: League / Rate differently posted into the hidden Feed view)", () => {
  const js = readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
  const direct = js.split("\n").filter((l) => l.includes('$("#feed").prepend(') && !l.includes("function showCard") && !/^\s*\$\("#feed"\)\.prepend\(card\);\s*$/.test(l));
  assert.deepEqual(direct, [], "prepend into #feed outside showCard — the card is invisible from the Dashboard");
  assert.match(js, /function showCard\(card[^)]*\) \{\s*if \(state\.view !== "feed"\) \{ setView\("feed", \{ silent: true \}\); syncUrl\(\); \}/);
  for (const fn of ["rateDifferently", "showLeague", "openRecorded"]) {
    const body = js.slice(js.indexOf(`function ${fn}(`));
    assert.ok(body.slice(0, body.indexOf("\n}\n")).includes("showCard("), `${fn} must render via showCard`);
  }
});

test("coach deck renders progressively, names every failure, and cannot overflow its grid column (v0.9.3)", () => {
  const js = readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
  const css = readFileSync(new URL("../web/styles.css", import.meta.url), "utf8");
  const fn = js.slice(js.indexOf("async function loadCoachDeck("));
  const body = fn.slice(0, fn.indexOf("\n}\n"));
  assert.ok(body.includes("Promise.allSettled(jobs)"), "per-panel jobs settle independently — no all-or-nothing wave");
  assert.ok(!body.includes("Promise.all(["), "no Promise.all wave gating the whole deck");
  assert.ok(body.includes("ph.fail(e.message)"), "every failed request names itself in its panel");
  assert.ok(body.includes('console.warn(`coach deck: ${url} failed'), "failures are logged, not swallowed");
  assert.match(css, /\.coach-panels \.cpanel \{[^}]*min-width: 0/, "grid item needs min-width:0 or the table's intrinsic width overflows the column");
  assert.match(css, /\.coach-panels \.cpanel \.tbl \{[^}]*max-width: 100%/);
});

test("headline rating is switchable by subject (v0.10.0): picker markup, URL param, League and Rate differently follow the subject", () => {
  const js = readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
  const html = readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
  assert.ok(html.includes('id="headline-pick"') && html.includes('id="rc-label"') && html.includes('id="rc-why"'), "hero carries the picker, a dynamic label and a dynamic Why? button");
  assert.ok(js.includes("function setHeadline(") && js.includes("function renderHeadline(") && js.includes("function renderHeadlinePicker("));
  assert.match(js, /searchParams\.get\("headline"\)/, "headline is read from the URL");
  assert.match(js, /u\.searchParams\.set\("headline", state\.headline\)/, "headline is written to the URL");
  assert.ok(js.includes("/api/v1/rating-definitions?subject=${sj}"), "Rate differently only offers the active subject's formulas");
  assert.ok(js.includes("/api/v1/ratings/${subjectPath(sj)}/league?season="), "League follows the subject");
  assert.ok(js.includes("subject: sj, components, author"), "custom formulas are saved under the active subject");
  const server = readFileSync(new URL("../src/server/app.ts", import.meta.url), "utf8");
  assert.ok(server.includes('definitionSubjectMismatch(def, "third_down")'), "Home refuses a non-third-down definition");
  assert.match(server, /ratings\\\/\(offense\|defense\|red-zone\|red_zone\|explosiveness\|ball-security\|ball_security\)\\\/league\$/, "subject league route exists");
});

test("trend follows the headline (v0.10.1): one loader for chips and picker; applied formulas carry into the trend", () => {
  const js = readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
  assert.ok(js.includes("async function showTrendFor(subject, defId)"));
  assert.match(js, /if \(state\.home\) \{ renderHeadline\(state\.home\); showTrendFor\(sj\); \}/, "setHeadline drives the trend");
  assert.ok(js.includes("showTrendFor(sj, defId);"), "Rate differently on a non-third-down subject re-trends with that formula");
  assert.ok(js.includes("/trend?team=${state.team}&season=${state.season}${defId ? `&definition=${encodeURIComponent(defId)}` : \"\"}"), "per-subject trend route with optional definition");
  assert.ok(!js.includes("third downs${p.provisional"), "tooltip unit follows the subject, not hard-coded third downs");
  const server = readFileSync(new URL("../src/server/app.ts", import.meta.url), "utf8");
  const trendRoute = server.slice(server.indexOf("\\/trend$/)) && m === \"GET\") {"), server.indexOf("subjectTrend(lp.rows"));
  assert.ok(trendRoute.includes("definitionSubjectMismatch(def, subject"), "per-subject trend route refuses a definition of another subject");
});

test("the cut (v0.11.0): fans get knobs that are not facts — no Rate-it sliders, no consensus next to a fact; picks, hype, favorite present; Rate differently is coach-only", () => {
  const js = readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
  const css = readFileSync(new URL("../web/styles.css", import.meta.url), "utf8");
  const html = readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
  assert.ok(!js.includes("data-rate") && !js.includes("function rateTile") && !js.includes("loadConsensus") && !js.includes("/api/v1/fans/ratings"), "fan-guesses-a-fact UI is gone");
  assert.match(css, /body:not\(\.mode-coach\) #rate-differently \{ display: none !important; \}/, "Rate differently is an analyst tool: coach mode only");
  for (const fn of ["renderPick", "renderHype", "setFavorite", "renderLeaderboard"]) assert.ok(js.includes(`function ${fn}(`), fn);
  assert.ok(html.includes('id="fav"') && html.includes('id="leaderboard"'));
  assert.ok(js.includes("/api/v1/fans/picks") && js.includes("/api/v1/fans/hype") && js.includes("/api/v1/fans/favorites"));
  assert.ok(js.includes("it never touches a CHALK number"), "the wall is stated where the knob is");
});
