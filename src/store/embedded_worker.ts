/*
 * SPDX-License-Identifier: BUSL-1.1
 * Copyright (c) 2026 Interchained LLC. All rights reserved.
 * CHALK / Sports-Rater — https://sports-rater.com — Licensor: Interchained LLC
 */
/**
 * Worker-thread entry for the embedded NEDB engine.
 *
 * `NedbCore.query()` / `put()` / `verify()` are SYNCHRONOUS napi calls: each one
 * blocks the JavaScript thread it runs on. On the HTTP thread that meant a
 * cold Home build (~8 season-scale scans, ~25 s on the VPS) froze every request
 * — nginx 502s, "rebuilding in background" that was really the foreground.
 * Here the engine lives on its own thread; the main thread talks to it over
 * messages (see WorkerStore) and stays free to serve HTTP.
 *
 * One engine per data dir still holds: this worker IS the engine for the dir.
 */
import { parentPort, workerData } from "node:worker_threads";
import { EmbeddedStore } from "./embedded.ts";

interface Req { id: number; method: string; args: unknown[] }

if (!parentPort) throw new Error("embedded_worker must run as a worker_thread");
const port = parentPort;
const wd = workerData as { dataDir: string | null; db: string; cacheTtlMs?: number };

let store: EmbeddedStore;
try {
  store = wd.dataDir
    ? EmbeddedStore.open(wd.dataDir, wd.db, (line) => port.postMessage({ type: "log", line }))
    : EmbeddedStore.memory(wd.db);
  if (wd.cacheTtlMs) store.cacheTtlMs = wd.cacheTtlMs;
  store.onCacheHit = (info) => port.postMessage({ type: "cacheHit", info });
  port.postMessage({ type: "ready", url: store.url, db: store.db, dataDir: store.dataDir });
} catch (e) {
  port.postMessage({ type: "fatal", error: (e as Error).message });
  throw e;
}

port.on("message", async (m: Req) => {
  const { id, method, args } = m;
  try {
    let result: unknown;
    switch (method) {
      case "put": result = await store.put(args[0] as string, args[1] as string, args[2] as Record<string, unknown>, args[3] as Record<string, unknown>); break;
      case "get": result = await store.get(args[0] as string, args[1] as string); break;
      case "query": result = await store.query(args[0] as string); break;
      case "queryAt": result = await store.queryAt(args[0] as string); break;
      case "batchPut": result = await store.batchPut(args[0] as Array<{ coll: string; id: string; doc: Record<string, unknown>; causedBy?: string[] }>); break;
      case "head": result = await store.head(); break;
      case "seq": result = await store.seq(); break;
      case "verify": result = await store.verify(); break;
      case "health": result = await store.health(); break;
      case "ping": result = await store.ping(); break;
      case "ensureDatabase": result = await store.ensureDatabase(); break;
      case "trace": result = await store.trace(args[0] as string, args[1] as string, args[2] as boolean | undefined); break;
      case "client.createIndex": result = await store.client.createIndex(args[0] as string, args[1] as string, args[2] as "sorted" | "eq" | undefined); break;
      case "client.queryFull": result = await store.client.queryFull(args[0] as string); break;
      case "client.listDatabases": result = await store.client.listDatabases(); break;
      case "invalidateCache": store.invalidateCache(); result = null; break;
      case "setCacheTtlMs": store.cacheTtlMs = Number(args[0]); result = null; break;
      case "close": store.close(); result = null; break;
      default: throw new Error(`embedded_worker: unknown method ${method}`);
    }
    port.postMessage({ id, ok: true, result });
  } catch (e) {
    port.postMessage({ id, ok: false, error: (e as Error).message, stack: (e as Error).stack });
  }
});
