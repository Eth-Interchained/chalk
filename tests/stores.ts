/**
 * Integration tests run against BOTH stores. CHALK_TEST_STORE=embedded uses the
 * in-process napi engine (in-memory); anything else spawns the bundled
 * nedbd-v2 in --memory mode and talks HTTP. `npm test` runs the suite twice.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { ChalkStore, resolveNedbdBinary, type Store } from "../src/store/nedb.ts";
import { EmbeddedStore } from "../src/store/embedded.ts";

export const STORE_KIND = process.env.CHALK_TEST_STORE === "embedded" ? "embedded" : "http";

export interface TestStore {
  store: Store;
  kind: "embedded" | "http";
  stop(): void;
  /** Reason to skip, or false. */
  skip: string | false;
}

export async function makeTestStore(db: string): Promise<TestStore> {
  if (STORE_KIND === "embedded") {
    let store: EmbeddedStore;
    try {
      store = EmbeddedStore.memory(db);
    } catch (e) {
      return { store: null as unknown as Store, kind: "embedded", stop() {}, skip: `embedded engine unavailable: ${(e as Error).message}` };
    }
    return { store, kind: "embedded", stop: () => store.close(), skip: false };
  }
  const bin = resolveNedbdBinary();
  if (!bin) return { store: null as unknown as Store, kind: "http", stop() {}, skip: `nedbd-v2 binary not available for ${process.platform}/${process.arch}` };
  const port = 17000 + Math.floor(Math.random() * 2000);
  const child: ChildProcess = spawn(bin, ["--memory", "--host", "127.0.0.1", "--port", String(port)], { stdio: ["ignore", "pipe", "pipe"] });
  const store = new ChalkStore({ url: `http://127.0.0.1:${port}`, db });
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await store.ping()) return { store, kind: "http", stop: () => child.kill("SIGTERM"), skip: false };
    await new Promise((r) => setTimeout(r, 150));
  }
  child.kill("SIGTERM");
  return { store: null as unknown as Store, kind: "http", stop() {}, skip: `nedbd-v2 did not come up on :${port}` };
}
