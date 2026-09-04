/*
 * SPDX-License-Identifier: BUSL-1.1
 * Copyright (c) 2026 Interchained LLC. All rights reserved.
 * CHALK / Sports-Rater — https://sports-rater.com — Licensor: Interchained LLC
 */
/**
 * WorkerStore — the embedded NEDB engine on its own thread, same `Store`
 * surface as EmbeddedStore / ChalkStore. Every call is a message round trip
 * (~50–200 µs) — negligible next to the scans it keeps OFF the HTTP thread.
 *
 * Why this exists: napi calls are synchronous. `chalk serve` on the embedded
 * store froze for the whole of a cold Home build (~25 s on the VPS) and nginx
 * answered 502 meanwhile. With the engine in a worker, the HTTP thread answers
 * /health in milliseconds while a 25 s rebuild runs on the worker.
 *
 * Node 24 runs the .ts worker natively (type stripping); no build step.
 */
import { Worker } from "node:worker_threads";
import type { Lineage, NedbRow, Store } from "./nedb.ts";

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; method: string; started: number };

export class WorkerStore implements Store {
  readonly url: string;
  readonly db: string;
  readonly dataDir: string | null;
  private readonly worker: Worker;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private closed = false;
  private _cacheTtlMs = 0;
  onCacheHit: ((info: { nql: string; ageMs: number; rows: number }) => void) | null = null;

  private constructor(worker: Worker, url: string, db: string, dataDir: string | null) {
    this.worker = worker; this.url = url; this.db = db; this.dataDir = dataDir;
  }

  get cacheTtlMs(): number { return this._cacheTtlMs; }
  set cacheTtlMs(v: number) { this._cacheTtlMs = v; void this.call("setCacheTtlMs", [v]).catch((e) => process.stderr.write(`worker store: setCacheTtlMs failed: ${(e as Error).message}\n`)); }

  /** Open the durable store at dataDir on a worker thread. Resolves once the engine is open (or rejects with the engine's reason). */
  static open(dataDir: string, db = "chalk", log: (l: string) => void = (l) => process.stderr.write(`${l}\n`), opts: { cacheTtlMs?: number } = {}): Promise<WorkerStore> {
    return WorkerStore.spawn({ dataDir, db, cacheTtlMs: opts.cacheTtlMs }, log);
  }
  /** In-memory engine on a worker (tests). */
  static memory(db = "chalk_mem", log: (l: string) => void = () => {}): Promise<WorkerStore> {
    return WorkerStore.spawn({ dataDir: null, db }, log);
  }

  private static spawn(workerData: { dataDir: string | null; db: string; cacheTtlMs?: number }, log: (l: string) => void): Promise<WorkerStore> {
    return new Promise((resolve, reject) => {
      if (workerData.dataDir && process.env.NEDB_DAG_V3 === undefined) process.env.NEDB_DAG_V3 = "1"; // the worker inherits env
      const worker = new Worker(new URL("./embedded_worker.ts", import.meta.url), { workerData, env: process.env });
      let store: WorkerStore | null = null;
      worker.on("message", (m: { type?: string; id?: number; ok?: boolean; result?: unknown; error?: string; line?: string; info?: { nql: string; ageMs: number; rows: number }; url?: string; db?: string; dataDir?: string | null }) => {
        if (m.type === "ready") {
          store = new WorkerStore(worker, m.url!, m.db!, m.dataDir ?? null);
          if (workerData.cacheTtlMs) store._cacheTtlMs = workerData.cacheTtlMs;
          resolve(store);
          return;
        }
        if (m.type === "fatal") { reject(new Error(m.error)); return; }
        if (m.type === "log") { log(m.line!); return; }
        if (m.type === "cacheHit") { store?.onCacheHit?.(m.info!); return; }
        if (typeof m.id === "number" && store) store.settle(m.id, m);
      });
      worker.on("error", (e) => {
        if (!store) reject(e);
        else { log(`embedded worker crashed: ${e.message}`); store.failAll(e); }
      });
      worker.on("exit", (code) => {
        if (store && !store.closed) { log(`embedded worker exited with code ${code} — store is gone`); store.failAll(new Error(`embedded worker exited (${code})`)); }
      });
    });
  }

  private settle(id: number, m: { ok?: boolean; result?: unknown; error?: string }): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    if (m.ok) p.resolve(m.result); else p.reject(new Error(`${p.method}: ${m.error}`));
  }
  private failAll(e: Error): void { for (const [id, p] of this.pending) { this.pending.delete(id); p.reject(e); } }

  private call<T>(method: string, args: unknown[]): Promise<T> {
    if (this.closed) return Promise.reject(new Error(`worker store closed (${method})`));
    return new Promise<T>((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, method, started: Date.now() });
      this.worker.postMessage({ id, method, args });
    });
  }

  invalidateCache(): void { void this.call("invalidateCache", []).catch((e) => process.stderr.write(`worker store: invalidateCache failed: ${(e as Error).message}\n`)); }

  put<T extends Record<string, unknown>>(coll: string, id: string, doc: T, lineage: Lineage = {}): Promise<NedbRow<T>> { return this.call("put", [coll, id, doc, lineage]); }
  get<T = Record<string, unknown>>(coll: string, id: string): Promise<NedbRow<T> | null> { return this.call("get", [coll, id]); }
  query<T = Record<string, unknown>>(nql: string): Promise<NedbRow<T>[]> { return this.call("query", [nql]); }
  queryAt<T = Record<string, unknown>>(nql: string): Promise<{ rows: NedbRow<T>[]; seq: number; head: string }> { return this.call("queryAt", [nql]); }
  batchPut(ops: Array<{ coll: string; id: string; doc: Record<string, unknown>; causedBy?: string[] }>): Promise<{ written: number; errors: Array<{ id: string; error: string }>; seq: number; head: string; hashes: Map<string, string> }> { return this.call("batchPut", [ops]); }
  head(): Promise<string> { return this.call("head", []); }
  seq(): Promise<number> { return this.call("seq", []); }
  verify(): Promise<{ ok: boolean; seq: number; head: string; tamper_evident: boolean; objects_checked: number; tampered: string[] }> { return this.call("verify", []); }
  health(): Promise<{ ok: boolean; service: string; version: string; databases: string[]; encrypted: boolean; engine: string; embedded: true }> { return this.call("health", []); }
  ping(): Promise<boolean> { return this.closed ? Promise.resolve(false) : this.call("ping", []); }
  ensureDatabase(): Promise<void> { return this.call("ensureDatabase", []); }
  trace(coll: string, id: string, reverse = false): Promise<NedbRow[]> { return this.call("trace", [coll, id, reverse]); }
  /** The cache lives on the worker; its put/batchPut already invalidate. Exposed for Store parity. */
  invalidateCollection(coll: string): number { void this.call("invalidateCollection", [coll]).catch((e) => console.warn(`invalidateCollection(${coll}) on worker failed: ${(e as Error).message}`)); return 0; }
  get client() {
    return {
      createIndex: (coll: string, field: string, kind: "sorted" | "eq" = "eq") => this.call<{ ok: boolean }>("client.createIndex", [coll, field, kind]),
      queryFull: (nql: string) => this.call<{ rows: Array<Record<string, unknown>>; count: number; seq: number; head: string }>("client.queryFull", [nql]),
      listDatabases: () => this.call<string[]>("client.listDatabases", []),
    };
  }

  /** Flush + release the engine, then stop the thread. */
  async close(): Promise<void> {
    if (this.closed) return;
    try { await this.call("close", []); } catch (e) { process.stderr.write(`worker store: close failed: ${(e as Error).message}\n`); }
    this.closed = true;
    await this.worker.terminate();
  }
}
