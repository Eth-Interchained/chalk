import { test } from "node:test";
import assert from "node:assert/strict";
import { logoConfig, logoUrl, DEFAULT_LOGO_TEMPLATE, LOGO_DISCLAIMER } from "../src/server/logos.ts";
import * as fs from "node:fs";
const require_fs = () => fs;

test("logos: default on, vendored template, provider abbreviation map, env off switch, garbage rejected", () => {
  const cfg = logoConfig({});
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.url_template, DEFAULT_LOGO_TEMPLATE);
  assert.equal(logoUrl(cfg, "TB"), "/logos/tb.png");
  assert.equal(logoUrl(cfg, "was"), "/logos/was.png");
  assert.equal(logoUrl(cfg, "LA"), "/logos/la.png");
  assert.equal(logoUrl(cfg, "LAR"), "/logos/la.png"); // alias -> the Rams file
  assert.equal(logoUrl(cfg, "JAX"), "/logos/jax.png");
  assert.equal(logoUrl(cfg, "<img>"), null);
  assert.equal(logoUrl(cfg, null), null);
  const off = logoConfig({ CHALK_TEAM_LOGOS: "0" });
  assert.equal(off.enabled, false);
  assert.equal(logoUrl(off, "TB"), null);
  const custom = logoConfig({ CHALK_TEAM_LOGO_URL: "https://cdn.example/{abbr}.svg" });
  assert.equal(logoUrl(custom, "CIN"), "https://cdn.example/cin.svg");
  assert.match(LOGO_DISCLAIMER, /not affiliated/);
  assert.ok(cfg.disclaimer.length > 50);
});

test("logos: every team has a vendored file that the resolver points at", () => {
  const { readFileSync, existsSync, statSync } = require_fs();
  const src = readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
  const teams = [...src.matchAll(/\b([A-Z]{2,3}): \["[^"]+", "#[0-9A-Fa-f]{6}"\]/g)].map((m) => m[1]);
  const cfg = logoConfig({});
  const missing = teams.filter((t) => !existsSync(new URL(`../web${logoUrl(cfg, t)}`, import.meta.url)));
  assert.deepEqual(missing, [], `missing vendored logos: ${missing.join(", ")}`);
  for (const t of teams) { const sz = statSync(new URL(`../web${logoUrl(cfg, t)}`, import.meta.url)).size; assert.ok(sz > 3_000 && sz < 200_000, `${t} logo ${sz} bytes`); }
});
