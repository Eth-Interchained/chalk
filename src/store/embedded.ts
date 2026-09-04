/**
 * EmbeddedStore — NEDB in-process via the napi NedbCore (nedb-engine), no
 * daemon. Same Store surface as the HTTP ChalkStore so every engine above it
 * is untouched.
 *
 * Verified on nedb-engine 2.8.2 (2026-09-04): `put(coll, id, json)` reads a
 * top-level `caused_by: string[]` from the doc, strips it, and records the
 * causal edges — `TRACE caused_by` walks them exactly like the daemon. What
 * differs from the daemon and how this file papers over it:
 *   - 2.8.2's embedded serializer echoes `caused_by` back inside the data and
 *     does not project `_caused_by`; master (unreleased) projects `_caused_by`.
 *     We normalize on read: `_caused_by` = `_caused_by ?? caused_by`, and
 *     `caused_by` is removed from `data`, so rows look identical either way.
 *   - No batch call: in-process puts have no round trip, so batchPut is a loop.
 *   - `evidence`/`confidence` are HTTP-body extras; here they ride inside the
 *     document as `_evidence`/`_confidence`-free? No — we keep the document
 *     byte-identical to the HTTP path and drop them (they were advisory notes).
 *   - seq() is a BigInt on napi; we return a number.
 *   - One engine per data dir (the daemon's split-brain rule applies here too):
 *     the process that opens the dir owns it. `chalk serve` therefore runs the
 *     watch loop in-process, and the CLI refuses to open a dir the server holds.
 */
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { NedbRow, Lineage } from "./nedb.ts";

interface NedbCoreLike {
  createIndex(coll: string, field: string, kind: string): void;
  put(coll: string, id: string, docJson: string): string;
  delete(coll: string, id: string): void;
  get(coll: string, id: string): string | null;
  query(nql: string): string[];
  verify(): boolean;
  head(): string;
  seq(): bigint;
  flush(): void;
  tip(): string | null;
}

interface NedbCoreCtor {
  new (): NedbCoreLike;
  open(path: string): NedbCoreLike;
}

function loadCore(): NedbCoreCtor {
  const req = createRequire(import.meta.url);
  const mod = req("nedb-engine") as { NedbCore: NedbCoreCtor };
  if (!mod?.NedbCore) throw new Error("nedb-engine did not export NedbCore — is the native addon for this platform installed?");
  return mod.NedbCore;
}

function normalizeRow<T>(raw: Record<string, unknown>): NedbRow<T> {
  const { _id, _hash, _seq, _coll, _caused_by, caused_by, ...data } = raw as Record<string, unknown> & {
    _id: string; _hash: string; _seq: number | string; _coll: string; _caused_by?: string[]; caused_by?: string[];
  };
  const cb = Array.isArray(_caused_by) ? _caused_by : Array.isArray(caused_by) ? caused_by : undefined;
  return { _id, _hash, _seq: Number(_seq), _coll, ...(cb && cb.length ? { _caused_by: cb } : {}), data: data as T };
}

export class EmbeddedStore {
  readonly url: string;
  readonly db: string;
  readonly dataDir: string | null;
  private readonly core: NedbCoreLike;
  private closed = false;

  cacheTtlMs = 0;
  onCacheHit: ((info: { nql: string; ageMs: number; rows: number }) => void) | null = null;
  private readonly cache = new Map<string, { at: number; value: { rows: NedbRow[]; seq: number; head: string } }>();

  private constructor(core: NedbCoreLike, dataDir: string | null, db: string) {
    this.core = core;
    this.dataDir = dataDir;
    this.db = db;
    this.url = dataDir ? `embedded:${dataDir}` : "embedded:memory";
  }

  /**
   * Durable store at dataDir (one engine per dir).
   *
   * Layout pin: nedbd writes the v3 segment store under `--dag-v3`; the napi
   * engine reads whichever layout NEDB_DAG_V3 selects at open time. Opening a
   * v3 directory as v2 does not fail — it returns ZERO ROWS (observed
   * 2026-09-04 on a dir whose daemon had exited: MANIFEST seq 238,712 visible,
   * every query empty). CHALK always uses v3, so the env is pinned here unless
   * the operator set it explicitly.
   *
   * Lock guard: the engine core takes an exclusive flock on LOCK for the Db's
   * lifetime and refuses a second opener ("refusing a split-brain open") —
   * verified with a concurrent double open. This pre-check reads the pid the
   * core writes into LOCK and refuses a little earlier with a CHALK-specific
   * message; the core's flock remains the real wall. A stale LOCK (dead pid)
   * is reported and ignored — the flock died with that process.
   */
  static open(dataDir: string, db = "chalk", log: (l: string) => void = (l) => process.stderr.write(`${l}\n`)): EmbeddedStore {
    if (process.env.NEDB_DAG_V3 === undefined) process.env.NEDB_DAG_V3 = "1";
    mkdirSync(dataDir, { recursive: true });
    const lockPath = path.join(dataDir, "LOCK");
    if (existsSync(lockPath)) {
      const raw = readFileSync(lockPath, "utf8").trim();
      const pid = Number((raw.match(/\d+/) ?? [])[0]);
      if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
        let alive = false;
        try { process.kill(pid, 0); alive = true; } catch (e) { alive = (e as NodeJS.ErrnoException).code === "EPERM"; }
        if (alive) throw new Error(`data dir ${dataDir} is held by a live process (pid ${pid}, LOCK file) — one engine per directory; stop it or point CHALK_DATA elsewhere`);
        log(`embedded: previous holder of ${dataDir} (pid ${pid}) has exited — taking the lock (normal after any CLI run; the core leaves LOCK behind)`);
      } else if (raw) {
        log(`embedded: LOCK present at ${dataDir} but no pid could be read from it (${raw.slice(0, 40)}) — proceeding; if another engine has this dir open, reads will be wrong`);
      }
    }
    const Core = loadCore();
    const store = new EmbeddedStore(Core.open(dataDir), dataDir, db);
    // Cooperative flush on exit — libuv-friendly hooks, not a C signal handler.
    const flush = () => store.close();
    process.once("beforeExit", flush);
    process.once("SIGINT", () => { flush(); process.exit(130); });
    process.once("SIGTERM", () => { flush(); process.exit(143); });
    return store;
  }

  /** In-memory store (tests, scratch). */
  static memory(db = "chalk_mem"): EmbeddedStore {
    const Core = loadCore();
    return new EmbeddedStore(new Core(), null, db);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try { this.core.flush(); } catch (e) { process.stderr.write(`embedded store flush failed: ${(e as Error).message}\n`); }
  }

  invalidateCache(): void { this.cache.clear(); }

  async put<T extends Record<string, unknown>>(coll: string, id: string, doc: T, lineage: Lineage = {}): Promise<NedbRow<T>> {
    const body: Record<string, unknown> = { ...doc };
    delete body.caused_by; // never let a user field masquerade as lineage
    if (lineage.causedBy?.length) body.caused_by = lineage.causedBy;
    const out = JSON.parse(this.core.put(coll, id, JSON.stringify(body)));
    // Deliberately NOT clearing the read cache here: CHALK's own writes
    // (analyses, ratings, observations, fan rows) never change the play/game
    // tables the cached scans cover, and clearing on every put made Home
    // recompute on every request (measured 17.4s warm). Ingest/pulse writes
    // invalidate through the server's event watcher, same as the HTTP store.
    return normalizeRow<T>(out);
  }

  async get<T = Record<string, unknown>>(coll: string, id: string): Promise<NedbRow<T> | null> {
    const s = this.core.get(coll, id);
    return s ? normalizeRow<T>(JSON.parse(s)) : null;
  }

  async query<T = Record<string, unknown>>(nql: string): Promise<NedbRow<T>[]> {
    return (await this.queryAt<T>(nql)).rows;
  }

  async queryAt<T = Record<string, unknown>>(nql: string): Promise<{ rows: NedbRow<T>[]; seq: number; head: string }> {
    if (this.cacheTtlMs > 0) {
      const hit = this.cache.get(nql);
      if (hit && Date.now() - hit.at < this.cacheTtlMs) {
        this.onCacheHit?.({ nql, ageMs: Date.now() - hit.at, rows: hit.value.rows.length });
        return hit.value as { rows: NedbRow<T>[]; seq: number; head: string };
      }
    }
    const rows = this.core.query(nql).map((s) => normalizeRow<T>(JSON.parse(s)));
    const value = { rows, seq: Number(this.core.seq()), head: this.core.head() };
    if (this.cacheTtlMs > 0 && !/\bTRACE\b/i.test(nql)) this.cache.set(nql, { at: Date.now(), value: value as { rows: NedbRow[]; seq: number; head: string } });
    return value;
  }

  async batchPut(
    ops: Array<{ coll: string; id: string; doc: Record<string, unknown>; causedBy?: string[] }>,
  ): Promise<{ written: number; errors: Array<{ id: string; error: string }>; seq: number; head: string; hashes: Map<string, string> }> {
    let written = 0;
    const errors: Array<{ id: string; error: string }> = [];
    const hashes = new Map<string, string>();
    for (const o of ops) {
      try {
        const row = await this.put(o.coll, o.id, o.doc, { causedBy: o.causedBy });
        hashes.set(o.id, row._hash);
        written++;
      } catch (e) {
        errors.push({ id: o.id, error: (e as Error).message });
      }
    }
    return { written, errors, seq: Number(this.core.seq()), head: this.core.head(), hashes };
  }

  async head(): Promise<string> { return this.core.head(); }
  async seq(): Promise<number> { return Number(this.core.seq()); }
  async verify(): Promise<{ ok: boolean; seq: number; head: string; tamper_evident: boolean; objects_checked: number; tampered: string[] }> {
    const ok = this.core.verify();
    return { ok, seq: Number(this.core.seq()), head: this.core.head(), tamper_evident: ok, objects_checked: Number(this.core.seq()), tampered: [] };
  }
  async health(): Promise<{ ok: boolean; service: string; version: string; databases: string[]; encrypted: boolean; engine: string; embedded: true }> {
    const req = createRequire(import.meta.url);
    const pkg = req("nedb-engine/package.json") as { version: string };
    return { ok: true, service: "nedb-engine (embedded)", version: pkg.version, databases: [this.db], encrypted: false, engine: "dag", embedded: true };
  }
  async ping(): Promise<boolean> { return !this.closed; }
  async ensureDatabase(): Promise<void> { /* the data dir IS the database */ }
  async trace(coll: string, id: string, reverse = false): Promise<NedbRow[]> {
    const lit = `"${id.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    return this.query(`FROM ${coll} WHERE _id = ${lit} TRACE caused_by${reverse ? " REVERSE" : ""}`);
  }
  /** nedb-engine-client parity for the few call sites that reach `store.client`. */
  get client() {
    return {
      createIndex: async (coll: string, field: string, kind: "sorted" | "eq" = "eq") => { this.core.createIndex(coll, field, kind); return { ok: true }; },
      queryFull: async (nql: string) => { const r = await this.queryAt(nql); return { rows: r.rows.map((x) => ({ ...x.data, _id: x._id, _hash: x._hash, _seq: x._seq, _coll: x._coll })), count: r.rows.length, seq: r.seq, head: r.head }; },
      listDatabases: async () => [this.db],
    };
  }
}
