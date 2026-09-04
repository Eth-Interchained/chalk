/*
 * SPDX-License-Identifier: BUSL-1.1
 * Copyright (c) 2026 Interchained LLC. All rights reserved.
 * CHALK / Sports-Rater — https://sports-rater.com — Licensor: Interchained LLC
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderBanner, shortSignature, CHALK_ASCII, SIGNATURE, DOCTRINE, engineVersion, packageInfo } from "../src/server/banner.ts";

test("banner: block letters, signature, doctrine, and metadata read from the real process; no ANSI when color is off", () => {
  const b = renderBanner({ command: "serve", version: "", mode: "embedded (worker thread)", dataDir: "/opt/chalk/chalk-data", host: "127.0.0.1", port: 4040, llm: { provider: "pin", model: "GLM-4-32B", hasKey: false }, defaults: { team: "TB", season: 2025 }, watch: { season: 2026, intervalS: 1800, deep: true }, admin: true, telemetry: true }, false);
  for (const line of CHALK_ASCII) assert.ok(b.includes(line), "ascii art present");
  assert.ok(b.includes(SIGNATURE)); assert.ok(b.includes("Interchained LLC")); assert.ok(b.includes("Vex"));
  for (const d of DOCTRINE) assert.ok(b.includes(d));
  assert.ok(b.includes(`version   ${packageInfo().version}`) || b.includes(packageInfo().version));
  assert.ok(b.includes(`nedb-engine ${engineVersion()}`));
  assert.ok(b.includes("http://127.0.0.1:4040"));
  assert.ok(b.includes("GLM-4-32B") && b.includes("[no key"));
  assert.ok(b.includes("season 2026 every 1800s · deep=true"));
  assert.ok(b.includes("/admin enabled"));
  assert.ok(b.includes(`node ${process.version}`) && b.includes(`pid ${process.pid}`));
  assert.ok(b.includes("BUSL-1.1") && b.includes("Licensor: Interchained LLC"));
  assert.ok(!/\x1b\[/.test(b), "no ANSI escapes when color is off");
  const colored = renderBanner({ command: "serve", version: "", mode: "x" }, true);
  assert.ok(/\x1b\[/.test(colored), "ANSI present when color is on");
  const sig = shortSignature();
  assert.match(sig, /^chalk \d+\.\d+\.\d+/); assert.ok(sig.includes(SIGNATURE)); assert.ok(sig.includes("BUSL-1.1"));
});
