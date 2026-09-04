import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
