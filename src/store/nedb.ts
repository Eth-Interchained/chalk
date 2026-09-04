/**
 * ChalkStore — CHALK's view of NEDB.
 *
 * Thin, deliberate wrapper over nedb-engine-client. Adds:
 *   - lineage-aware writes (causedBy hashes + evidence note on every derived put)
 *   - typed row reads (NEDB returns `_id/_hash/_seq/_coll/_caused_by` alongside data)
 *   - NQL string building with proper literal escaping
 *   - batch writes chunked to a sane size
 *   - a local-first boot helper that spawns the nedbd-v2 binary bundled in the
 *     nedb-engine npm package when no daemon is reachable
 *
 * Verified live against nedbd 2.8.2 (DAG engine):
 *   PUT returns { doc: { _hash, _seq, _id, _coll, data }, seq, head }
 *   caused_by on the body creates edges; `TRACE caused_by` walks them.
 *   Re-putting an identical doc creates a NEW version — idempotency is ours.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { NedbClient, NedbError, type BatchOp, type PutOptions } from "nedb-engine-client";

export interface NedbRow<T = Record<string, unknown>> {
  _id: string;
  _hash: string;
  _seq: number;
  _coll: string;
  _caused_by?: string[];
  data: T;
}

export interface Lineage {
  causedBy?: string[];
  evidence?: string;
  confidence?: number;
}

export interface StoreOptions {
  url: string;
  db: string;
  token?: string;
  readTimeoutMs?: number;
  writeTimeoutMs?: number;
}

export const DEFAULT_NEDB_URL = "http://127.0.0.1:7070";
export const DEFAULT_DB = "chalk";

/** Escape a string for use as an NQL literal. */
export function nqlStr(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Split a NEDB row into metadata + user data. */
export function splitRow<T = Record<string, unknown>>(row: Record<string, unknown>): NedbRow<T> {
  const { _id, _hash, _seq, _coll, _caused_by, ...data } = row as Record<string, unknown> & {
    _id: string;
    _hash: string;
    _seq: number;
    _coll: string;
    _caused_by?: string[];
  };
  return { _id, _hash, _seq, _coll, _caused_by, data: data as T };
}

export class ChalkStore {
  readonly client: NedbClient;
  readonly url: string;
  readonly db: string;

  constructor(opts: StoreOptions) {
    this.url = opts.url;
    this.db = opts.db;
    this.client = new NedbClient({
      url: opts.url,
      db: opts.db,
      token: opts.token,
      autoCreate: true,
      // Season-scale NQL scans over ~49k plays need more than the 3s default.
      readTimeoutMs: opts.readTimeoutMs ?? 120_000,
      writeTimeoutMs: opts.writeTimeoutMs ?? 120_000,
    });
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): ChalkStore {
    return new ChalkStore({
      url: env.NEDB_URL ?? DEFAULT_NEDB_URL,
      db: env.NEDB_DB ?? DEFAULT_DB,
      token: env.NEDBD_TOKEN || env.NEDB_TOKEN || undefined,
    });
  }

  /** Write a document with lineage. Returns the stored row (with _hash). */
  async put<T extends Record<string, unknown>>(
    coll: string,
    id: string,
    doc: T,
    lineage: Lineage = {},
  ): Promise<NedbRow<T>> {
    const opts: PutOptions = {};
    if (lineage.causedBy?.length) opts.causedBy = lineage.causedBy;
    if (lineage.evidence) opts.evidence = lineage.evidence;
    if (lineage.confidence !== undefined) opts.confidence = lineage.confidence;
    const res = await this.client.put(coll, id, doc, opts);
    const r = res.doc as unknown as { _id: string; _hash: string; _seq: number; _coll: string; data: T };
    return { _id: r._id, _hash: r._hash, _seq: r._seq, _coll: r._coll, data: r.data };
  }

  async get<T = Record<string, unknown>>(coll: string, id: string): Promise<NedbRow<T> | null> {
    const row = await this.client.get(coll, id);
    return row ? splitRow<T>(row) : null;
  }

  /**
   * Read-through query cache. 0 (default) = off. nedbd 2.8.2 evaluates every
   * NQL WHERE as a full collection scan (measured: 851ms for a 159-row
   * game_id lookup over 48k plays, eq index present), so the server enables a
   * short TTL. NEDB stays canonical: cached answers carry the seq/head they
   * were computed at, and every hit is observable via onCacheHit.
   */
  cacheTtlMs = 0;
  onCacheHit: ((info: { nql: string; ageMs: number; rows: number }) => void) | null = null;
  private readonly cache = new Map<string, { at: number; value: { rows: NedbRow[]; seq: number; head: string } }>();

  invalidateCache(): void {
    this.cache.clear();
  }

  async query<T = Record<string, unknown>>(nql: string): Promise<NedbRow<T>[]> {
    return (await this.queryAt<T>(nql)).rows;
  }

  /** Query returning rows + the seq/head the answer was computed at. */
  async queryAt<T = Record<string, unknown>>(nql: string): Promise<{ rows: NedbRow<T>[]; seq: number; head: string }> {
    if (this.cacheTtlMs > 0) {
      const hit = this.cache.get(nql);
      if (hit && Date.now() - hit.at < this.cacheTtlMs) {
        this.onCacheHit?.({ nql, ageMs: Date.now() - hit.at, rows: hit.value.rows.length });
        return hit.value as { rows: NedbRow<T>[]; seq: number; head: string };
      }
    }
    const res = await this.client.queryFull(nql);
    // Plain queries return the latest version per id; TRACE returns history
    // (prior versions of the same id are part of the answer). Neither is
    // post-processed here.
    const value = { rows: res.rows.map((r) => splitRow<T>(r)), seq: res.seq, head: res.head };
    if (this.cacheTtlMs > 0 && !/\bTRACE\b/i.test(nql)) {
      this.cache.set(nql, { at: Date.now(), value: value as { rows: NedbRow[]; seq: number; head: string } });
      if (this.cache.size > 200) {
        const oldest = [...this.cache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (oldest) this.cache.delete(oldest[0]);
      }
    }
    return value;
  }

  /**
   * Batched puts with per-op lineage. nedbd's /batch takes caused_by per op;
   * evidence/confidence are not part of the batch op shape, so lineage notes
   * for batched raw writes live in the document itself (ingest_version etc.).
   */
  async batchPut(
    ops: Array<{ coll: string; id: string; doc: Record<string, unknown>; causedBy?: string[] }>,
    chunk = 500,
  ): Promise<{ written: number; errors: Array<{ id: string; error: string }>; seq: number; head: string; hashes: Map<string, string> }> {
    let written = 0;
    const errors: Array<{ id: string; error: string }> = [];
    const hashes = new Map<string, string>();
    let seq = 0;
    let head = "";
    for (let i = 0; i < ops.length; i += chunk) {
      const slice: BatchOp[] = ops.slice(i, i + chunk).map((o) => ({
        op: "put",
        coll: o.coll,
        id: o.id,
        doc: o.doc,
        ...(o.causedBy?.length ? { caused_by: o.causedBy } : {}),
      }));
      const res = await this.client.batch(slice);
      seq = res.seq;
      head = res.head;
      for (const r of res.results as Array<{ op: string; id: string; seq?: number; hash?: string; error?: string }>) {
        if (r.error) errors.push({ id: r.id, error: r.error });
        else {
          written++;
          if (r.hash) hashes.set(r.id, r.hash);
        }
      }
    }
    return { written, errors, seq, head, hashes };
  }

  async head(): Promise<string> {
    return this.client.head();
  }
  async seq(): Promise<number> {
    return this.client.seq();
  }
  async verify() {
    return this.client.verify();
  }
  async health() {
    return this.client.health();
  }
  async ping(): Promise<boolean> {
    return this.client.ping();
  }
  /**
   * Idempotent database creation: list first, create only when absent.
   * POST /v1/databases is a create call — issuing it for a database the daemon
   * already has open returns 500 (the data dir is held by the daemon's own
   * lock), so the contract on our side is "check, then create".
   */
  async ensureDatabase(): Promise<void> {
    const existing = await this.client.listDatabases();
    if (existing.includes(this.db)) return;
    await this.client.createDatabase();
  }
  /** `TRACE caused_by` from a document: the row plus every ancestor. */
  async trace(coll: string, id: string, reverse = false): Promise<NedbRow[]> {
    return this.query(`FROM ${coll} WHERE _id = ${nqlStr(id)} TRACE caused_by${reverse ? " REVERSE" : ""}`);
  }
}

// ------------------------------------------------------------ local-first boot

export interface LocalNedbd {
  url: string;
  child: ChildProcess | null;
  spawned: boolean;
  dataDir: string;
}

/**
 * Local-first: if nothing answers at `url`, spawn the nedbd-v2 binary that
 * ships inside the nedb-engine npm package (same engine Mark runs in prod).
 * Returns the child so callers can stop it. Logs every decision — a silent
 * "no daemon" is indistinguishable from a broken install.
 */
export async function ensureNedbd(opts: {
  url: string;
  dataDir: string;
  log?: (line: string) => void;
  autostart?: boolean;
  dagV3?: boolean;
}): Promise<LocalNedbd> {
  const log = opts.log ?? (() => {});
  const client = new NedbClient({ url: opts.url, db: "_probe", autoCreate: false, readTimeoutMs: 2000 });
  if (await client.ping()) {
    log(`nedbd reachable at ${opts.url}`);
    return { url: opts.url, child: null, spawned: false, dataDir: opts.dataDir };
  }
  if (opts.autostart === false) {
    throw new Error(`nedbd not reachable at ${opts.url} and autostart disabled (CHALK_AUTOSTART_NEDB=0)`);
  }
  const u = new URL(opts.url);
  if (!["127.0.0.1", "localhost", "::1"].includes(u.hostname)) {
    throw new Error(`nedbd not reachable at ${opts.url}; refusing to autostart a daemon for a non-loopback URL`);
  }
  const bin = resolveNedbdBinary();
  if (!bin) {
    throw new Error(
      `nedbd not reachable at ${opts.url} and no bundled nedbd-v2 binary found for ${process.platform}/${process.arch}. ` +
        `Install nedb-engine (npm) or run nedbd yourself and set NEDB_URL.`,
    );
  }
  mkdirSync(opts.dataDir, { recursive: true });
  const args = ["--host", u.hostname === "localhost" ? "127.0.0.1" : u.hostname, "--port", u.port || "7070", "--data", opts.dataDir];
  if (opts.dagV3 !== false) args.unshift("--dag-v3");
  log(`spawning ${bin} ${args.join(" ")}`);
  const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
  child.stdout?.on("data", (d) => log(`[nedbd] ${String(d).trimEnd()}`));
  child.stderr?.on("data", (d) => log(`[nedbd!] ${String(d).trimEnd()}`));
  child.on("exit", (code, sig) => log(`[nedbd] exited code=${code} signal=${sig}`));
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await client.ping()) {
      log(`nedbd up at ${opts.url} (pid ${child.pid})`);
      return { url: opts.url, child, spawned: true, dataDir: opts.dataDir };
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  child.kill("SIGTERM");
  throw new Error(`spawned nedbd-v2 (pid ${child.pid}) but it never answered at ${opts.url} within 15s`);
}

export function resolveNedbdBinary(): string | null {
  const name =
    process.platform === "linux" && process.arch === "x64"
      ? "nedbd-v2-linux-x64"
      : process.platform === "win32" && process.arch === "x64"
        ? "nedbd-v2-win-x64.exe"
        : process.platform === "darwin" && process.arch === "arm64"
          ? "nedbd-v2-darwin-arm64"
          : process.platform === "darwin" && process.arch === "x64"
            ? "nedbd-v2-darwin-x64"
            : null;
  if (!name) return null;
  try {
    const req = createRequire(import.meta.url);
    const pkgPath = req.resolve("nedb-engine/package.json");
    const bin = path.join(path.dirname(pkgPath), name);
    return existsSync(bin) ? bin : null;
  } catch {
    return null;
  }
}

export { NedbError };
