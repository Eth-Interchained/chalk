/*
 * SPDX-License-Identifier: BUSL-1.1
 * Copyright (c) 2026 Interchained LLC. All rights reserved.
 * CHALK / Sports-Rater — https://sports-rater.com — Licensor: Interchained LLC
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { shareCopy, injectOg, publicBase } from "../src/server/share.ts";
import type { HomePayload } from "../src/server/home.ts";

const home = {
  team: "TB", season: 2025,
  rating: { team: "TB", definition: "Sports-Rater Third Down", definition_id: "third_down_default@1.0.0", score: 66, rank: 11, of: 32, sample_size: 227, provisional: false, normalization: "percentile_rank@1.0.0", components: [] },
  rating_snapshot_id: "rs1", trend: null,
  badges: [{ id: "b1", version: "1", kind: "signature", name: "Ball Security", emoji: "", tone: "good", description: "", metric: "turnover_rate", value: 0.015, percentile: 73, rank: 9, of: 32, sample: 1065, qualification_rule: "" }, { id: "b2", version: "1", kind: "heel", name: "Success Rate", emoji: "", tone: "bad", description: "", metric: "success_rate", value: 0.42, percentile: 27, rank: 24, of: 32, sample: 1065, qualification_rule: "" }],
  form: null, last_game: null, next_game: null, weakest: [], strongest: [],
  ratings: [{ subject: "offense", label: "Offense", definition_id: "offense_default@1.0.0", definition_name: "Sports-Rater Offense", score: 48, rank: 19, of: 32, provisional: false, sample: 1065, snapshot_id: "s1", top_component: null }],
  scout: null, context_coverage: null, computed_at: { seq: 1, head: "h" },
} as unknown as HomePayload;

test("shareCopy: third-down default and a subject headline; unknown headline falls back; badges and formula in the caption", () => {
  const td = shareCopy(home, "third_down", "https://sports-rater.com");
  assert.equal(td.title, "TB Third Down 66/100 · #11 of 32 · 227 third downs — Sports-Rater");
  assert.equal(td.url, "https://sports-rater.com/s/TB?season=2025");
  assert.equal(td.image, "https://sports-rater.com/hero/TB.jpg");
  assert.match(td.text, /Tampa Bay Buccaneers 2025 — Third Down 66\/100/); assert.match(td.text, /Signature: Ball Security · Achilles heel: Success Rate/); assert.match(td.text, /Formula: Sports-Rater Third Down/); assert.ok(td.text.endsWith(td.url));
  const off = shareCopy(home, "offense", "https://sports-rater.com");
  assert.equal(off.score, 48); assert.equal(off.rank, 19); assert.equal(off.url, "https://sports-rater.com/s/TB?season=2025&headline=offense"); assert.match(off.text, /1065 plays/);
  assert.equal(shareCopy(home, "punting", "https://x").headline, "third_down");
  const prefixed = shareCopy({ ...home, badges: [{ ...home.badges[0], name: "SIGNATURE · BALL SECURITY" }, { ...home.badges[1], name: "ACHILLES HEEL · SUCCESS RATE" }] } as HomePayload, "third_down", "https://x");
  assert.match(prefixed.text, /Signature: Ball Security · Achilles heel: Success Rate/, "kind prefix on the badge name is not repeated");
  const none = shareCopy(home, "defense", "https://x"); assert.equal(none.score, null); assert.match(none.title, /no 2025 rating yet/);
});

test("injectOg: OG + Twitter tags before </head>, title replaced, attributes escaped, idempotent", () => {
  const html = `<!doctype html><html><head><meta charset="utf-8" /><title>Sports-Rater · CHALK</title></head><body></body></html>`;
  const c = shareCopy({ ...home, team: "TB" }, "third_down", "https://sports-rater.com");
  c.title = `TB "quotes" & <angles>`;
  const out = injectOg(html, c);
  assert.ok(out.includes(`<title>TB &quot;quotes&quot; &amp; &lt;angles&gt;</title>`));
  assert.ok(out.includes(`<meta property="og:image" content="https://sports-rater.com/hero/TB.jpg" />`));
  assert.ok(out.includes(`<meta name="twitter:card" content="summary_large_image" />`));
  assert.ok(out.indexOf("<!-- sharecard:og -->") < out.indexOf("</head>"));
  const twice = injectOg(out, c);
  assert.equal(twice.split("sharecard:og").length, out.split("sharecard:og").length, "re-injection replaces the block instead of stacking");
});

test("publicBase: env wins, then forwarded host/proto, then fallback", () => {
  assert.equal(publicBase({ CHALK_PUBLIC_URL: "https://sports-rater.com/" }, {}), "https://sports-rater.com");
  assert.equal(publicBase({}, { "x-forwarded-host": "sports-rater.com", "x-forwarded-proto": "https" }), "https://sports-rater.com");
  assert.equal(publicBase({}, { host: "127.0.0.1:4040" }), "https://127.0.0.1:4040");
  assert.equal(publicBase({}, {}), "https://sports-rater.com");
});
