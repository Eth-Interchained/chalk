import { test } from "node:test";
import assert from "node:assert/strict";
import { logoConfig, logoUrl, DEFAULT_LOGO_TEMPLATE, LOGO_DISCLAIMER } from "../src/server/logos.ts";

test("logos: default on, ESPN template, provider abbreviation map, env off switch, garbage rejected", () => {
  const cfg = logoConfig({});
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.url_template, DEFAULT_LOGO_TEMPLATE);
  assert.equal(logoUrl(cfg, "TB"), "https://a.espncdn.com/i/teamlogos/nfl/500/tb.png");
  assert.equal(logoUrl(cfg, "was"), "https://a.espncdn.com/i/teamlogos/nfl/500/wsh.png");
  assert.equal(logoUrl(cfg, "LA"), "https://a.espncdn.com/i/teamlogos/nfl/500/lar.png");
  assert.equal(logoUrl(cfg, "JAX"), "https://a.espncdn.com/i/teamlogos/nfl/500/jax.png");
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
