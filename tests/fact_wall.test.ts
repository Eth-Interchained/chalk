/*
 * SPDX-License-Identifier: BUSL-1.1
 * Copyright (c) 2026 Interchained LLC. All rights reserved.
 * CHALK / Sports-Rater — https://sports-rater.com — Licensor: Interchained LLC
 */
// The fact wall (Mark, 2026-09-04): "make sure the CHALK readings are not manipulated by fans — give them
// other knobs to turn but not the facts." Ratings, analyses, ingest, the planner and the explainer must
// never read a fan collection. Fan data decorates at the server-route layer only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SR_COLLECTIONS } from "../src/fans/fans.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FACT_SIDE = ["src/rating", "src/engine", "src/llm", "src/planner", "src/ingest", "src/model", "src/source"];

function walk(dir: string): string[] {
  let out: string[] = [];
  for (const f of readdirSync(dir)) { const p = path.join(dir, f); if (statSync(p).isDirectory()) out = out.concat(walk(p)); else if (/\.ts$/.test(f)) out.push(p); }
  return out;
}

test("fact wall: no fact-side module imports the fan layer or names a fan collection", () => {
  const offenders: string[] = [];
  for (const dir of FACT_SIDE) {
    const abs = path.join(root, dir);
    let files: string[] = [];
    try { files = walk(abs); } catch { continue; }
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      if (/from\s+["'][^"']*\/fans\//.test(src)) offenders.push(`${path.relative(root, f)}: imports src/fans`);
      for (const coll of SR_COLLECTIONS) if (src.includes(`"${coll}"`) || src.includes(`'${coll}'`)) offenders.push(`${path.relative(root, f)}: names ${coll}`);
      if (/\bsr_[a-z_]+\b/.test(src.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, ""))) offenders.push(`${path.relative(root, f)}: references an sr_* collection`);
    }
  }
  assert.deepEqual(offenders, [], "fan data leaked onto the fact side");
  assert.ok(SR_COLLECTIONS.length >= 7);
});
