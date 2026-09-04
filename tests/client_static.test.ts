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
  assert.match(src, /if \(state\.view !== "feed"\) setView\("feed", \{ silent: true \}\);/);
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
