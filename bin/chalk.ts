#!/usr/bin/env node
/**
 * chalk — CLI.
 *
 *   chalk ingest --season 2025 [--team TB] [--game 2025_18_CAR_TB] [--deep]
 *   chalk analyze --team TB --season 2025 [--game ID] [--side defense]
 *   chalk rate --team TB --season 2025 [--definition third_down_default@1.0.0]
 *   chalk scan --team TB --season 2025
 *   chalk serve [--port 4040] [--host 127.0.0.1]
 *   chalk verify
 *
 * Env: NEDB_URL (default http://127.0.0.1:7070), NEDB_DB (chalk), NEDBD_TOKEN,
 *      CHALK_DATA (./chalk-data, used when autostarting nedbd), CHALK_AUTOSTART_NEDB (1),
 *      CHALK_LLM_* (see src/llm/client.ts), CHALK_DEFAULT_TEAM (TB), CHALK_DEFAULT_SEASON.
 */
import path from "node:path";
import { ChalkStore, type Store, DEFAULT_NEDB_URL, DEFAULT_DB, ensureNedbd } from "../src/store/nedb.ts";
import { EmbeddedStore } from "../src/store/embedded.ts";
import { NFLDataSource } from "../src/source/nfldata.ts";
import { resolveWatchDeep } from "../src/ingest/watch_config.ts";
import { ingest } from "../src/ingest/ingest.ts";
import { auditSeason } from "../src/ingest/audit.ts";
import { runThirdDown, summarizeThirdDown } from "../src/engine/thirddown.ts";
import { rateThirdDown, loadDefinition, leagueThirdDown } from "../src/rating/league.ts";
import { THIRD_DOWN_DEFAULT_V1 } from "../src/rating/definitions.ts";
import { scanSituations } from "../src/engine/scan.ts";
import { compileNql, validateFilter } from "../src/engine/situation.ts";
import { startServer } from "../src/server/app.ts";
import { TheSportsDBSource } from "../src/source/pulse.ts";
import { pulseLoop, pulseTick } from "../src/ingest/pulse.ts";
import { rankings } from "../src/rating/rank.ts";
import { COLL } from "../src/store/collections.ts";
import type { Game, Play } from "../src/model/football.ts";

const argv = process.argv.slice(2);
const cmd = argv[0];
const flags = parseFlags(argv.slice(1));
const log = (l: string) => process.stderr.write(`${l}\n`);

function parseFlags(args: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      out[key] = next;
      i++;
    } else out[key] = true;
  }
  return out;
}
const str = (k: string, dflt?: string) => (typeof flags[k] === "string" ? (flags[k] as string) : dflt);
const num = (k: string, dflt?: number) => (typeof flags[k] === "string" ? Number(flags[k]) : dflt);

/**
 * Store selection:
 *   CHALK_STORE=embedded (default)  NEDB in-process via the napi engine at CHALK_DATA (./chalk-data).
 *                                   One engine per data dir: the process that opens it owns it.
 *   CHALK_STORE=http, or NEDB_URL   talk to a nedbd daemon (autostarts the bundled binary on loopback
 *   set                             when nothing answers, unless CHALK_AUTOSTART_NEDB=0).
 */
async function boot(): Promise<{ store: Store; stop: () => void; mode: "embedded" | "http" }> {
  const mode = (process.env.CHALK_STORE ?? (process.env.NEDB_URL ? "http" : "embedded")) as "embedded" | "http";
  const dataDir = path.resolve(process.env.CHALK_DATA ?? "./chalk-data");
  if (mode === "embedded") {
    let store: EmbeddedStore;
    try {
      store = EmbeddedStore.open(dataDir, process.env.NEDB_DB ?? DEFAULT_DB);
    } catch (e) {
      throw new Error(
        `could not open the embedded NEDB at ${dataDir}: ${(e as Error).message}\n` +
          `  If \`chalk serve\` (or a nedbd) already holds this directory, stop it first — one engine per data dir.\n` +
          `  To use a daemon instead: NEDB_URL=http://127.0.0.1:7070 (or CHALK_STORE=http).`,
      );
    }
    log(`store: embedded NEDB at ${dataDir}`);
    return { store, mode, stop: () => store.close() };
  }
  const url = process.env.NEDB_URL ?? DEFAULT_NEDB_URL;
  const local = await ensureNedbd({ url, dataDir, log, autostart: process.env.CHALK_AUTOSTART_NEDB !== "0" });
  const store = new ChalkStore({ url, db: process.env.NEDB_DB ?? DEFAULT_DB, token: process.env.NEDBD_TOKEN || undefined });
  log(`store: nedbd over HTTP at ${url}`);
  return {
    store,
    mode,
    stop: () => {
      if (local.child) {
        log("stopping autostarted nedbd");
        local.child.kill("SIGTERM");
      }
    },
  };
}

/** In-process watch: re-ingest a season (idempotent) + pulse tick on a cadence. The only polling loop. */
function startWatchLoop(store: Store, season: number, intervalS: number, deep: boolean, signal: AbortSignal): void {
  const source = new NFLDataSource({ onRequest: (i) => { if (i.status !== 200) log(`  watch HTTP ${i.status} ${i.url}`); } });
  const pulse = new TheSportsDBSource({});
  (async () => {
    while (!signal.aborted) {
      const t0 = Date.now();
      try {
        const r = await ingest({ store, source, scope: { season, deep }, log: () => {} });
        const knownGames = (await store.query<Game>(`FROM ${COLL.games}`)).map((g) => g.data);
        const pt = await pulseTick({ store, source: pulse, knownGames, log: () => {} });
        if (r.normalized_written || r.raw_changed || pt.raw_written || r.errors.length) store.invalidateCache();
        log(`watch ${season}: games_with_results=${r.games_fetched} plays_new=${r.normalized_written} changed=${r.raw_changed} errors=${r.errors.length} pulse_obs=${pt.observations} pulse_changed=${pt.raw_changed} live=${pt.live_games.length} seq=${pt.nedb_seq} ${Date.now() - t0}ms`);
      } catch (e) {
        log(`watch tick failed: ${(e as Error).message}`);
      }
      await new Promise((r) => setTimeout(r, intervalS * 1000));
    }
  })();
}

async function main() {
  switch (cmd) {
    case "ingest": {
      const { store, stop } = await boot();
      try {
        const source = new NFLDataSource({
          onRequest: (i) => {
            if (i.status !== 200) log(`  HTTP ${i.status} ${i.url}`);
          },
        });
        const t0 = Date.now();
        const r = await ingest({
          store,
          source,
          scope: { season: num("season"), week: num("week"), team: str("team"), gameId: str("game"), deep: flags.deep === true, contextOnly: flags["context-only"] === true },
          log,
          onProgress: (c) => {
            if (c.games_done % 10 === 0 || c.games_done === c.games_total) {
              log(`  ${c.games_done}/${c.games_total} games · ${c.plays_fetched} plays · raw+${c.raw_written} dup ${c.raw_duplicates} chg ${c.raw_changed} · norm+${c.normalized_written} · ${((Date.now() - t0) / 1000).toFixed(0)}s`);
            }
          },
        });
        const head = await store.head();
        const seq = await store.seq();
        process.stdout.write(
          [
            "",
            "CHALK ingest",
            `  run id                 ${r.run_id}`,
            `  source                 ${r.source}`,
            `  games fetched          ${r.games_fetched}`,
            `  plays fetched          ${r.plays_fetched}`,
            `  context rows fetched   ${r.context_fetched}`,
            `  context written        ${r.context_written} (skipped ${r.context_skipped})`,
            `  raw records written    ${r.raw_written}`,
            `  duplicates ignored     ${r.raw_duplicates}`,
            `  changed records        ${r.raw_changed}`,
            `  normalized written     ${r.normalized_written}`,
            `  normalized skipped     ${r.normalized_skipped}`,
            `  errors                 ${r.errors.length}`,
            `  duration               ${(r.duration_ms / 1000).toFixed(1)}s`,
            `  NEDB seq               ${seq}`,
            `  NEDB head              ${head}`,
            `  ingest event hash      ${r.event_hash}`,
            "",
          ].join("\n"),
        );
        if (r.errors.length) process.stdout.write(JSON.stringify(r.errors.slice(0, 20), null, 2) + "\n");
      } finally {
        stop();
      }
      return;
    }
    case "analyze": {
      const { store, stop } = await boot();
      try {
        const team = str("team", process.env.CHALK_DEFAULT_TEAM ?? "TB")!;
        const res = await runThirdDown(store, {
          team,
          season: num("season"),
          game_id: str("game"),
          side: (str("side") as "offense" | "defense") ?? "offense",
          exclude_garbage_time: flags["exclude-garbage-time"] === true,
        }, { log });
        process.stdout.write(JSON.stringify({ id: res.analysis.id, cached: res.cached, nql: res.nql, summary: summarizeThirdDown(res.analysis), stored_hash: res.stored?._hash ?? null }, null, 2) + "\n");
      } finally {
        stop();
      }
      return;
    }
    case "rate": {
      const { store, stop } = await boot();
      try {
        const team = str("team", process.env.CHALK_DEFAULT_TEAM ?? "TB")!;
        const season = num("season");
        if (!season) throw new Error("--season required");
        const def = (await loadDefinition(store, str("definition", THIRD_DOWN_DEFAULT_V1.id)!)) ?? THIRD_DOWN_DEFAULT_V1;
        const r = await rateThirdDown(store, team, season, def, (str("side") as "offense" | "defense") ?? "offense", log);
        if (!r) throw new Error(`no third-down data for ${team} ${season}`);
        process.stdout.write(JSON.stringify({ score: r.snapshot.score, rank: r.rank, of: r.population.length, provisional: r.snapshot.provisional, sample: r.snapshot.sample_size, components: r.snapshot.components, league: r.league, stored_hash: r.stored_hash }, null, 2) + "\n");
      } finally {
        stop();
      }
      return;
    }
    case "scan": {
      const { store, stop } = await boot();
      try {
        const team = str("team", process.env.CHALK_DEFAULT_TEAM ?? "TB")!;
        const v = validateFilter({ team, season: num("season"), game_id: str("game"), side: str("side") ?? "offense" });
        if (!v.ok) throw new Error(v.errors.join("; "));
        const { rows, seq, head } = await store.queryAt<Play>(compileNql(v.filter!));
        const scan = scanSituations(rows, v.filter!, { seq, head });
        process.stdout.write(JSON.stringify({ baseline: scan.baseline, weakest: scan.weakest.slice(0, 5).map((b) => ({ label: b.label, n: b.metrics.attempts, epa: b.metrics.epa_per_play, delta: b.epa_delta_vs_team })), strongest: scan.strongest.slice(0, 5).map((b) => ({ label: b.label, n: b.metrics.attempts, epa: b.metrics.epa_per_play, delta: b.epa_delta_vs_team })) }, null, 2) + "\n");
      } finally {
        stop();
      }
      return;
    }
    case "league": {
      const { store, stop } = await boot();
      try {
        const season = num("season");
        if (!season) throw new Error("--season required");
        const l = await leagueThirdDown(store, season, "offense", log);
        const rows = [...l.analyses.values()].map((a) => ({ team: a.filter.team, n: a.metrics.attempts, conv: a.metrics.conversion_rate, epa: a.metrics.epa_per_play })).sort((x, y) => (y.conv ?? 0) - (x.conv ?? 0));
        process.stdout.write(JSON.stringify(rows, null, 1) + "\n");
      } finally {
        stop();
      }
      return;
    }
    case "pulse": {
      const { store, stop } = await boot();
      try {
        const source = new TheSportsDBSource({ onRequest: (i) => log(`  pulse HTTP ${i.status} ${i.ms}ms ${i.url}`) });
        log(`pulse source ${source.id} (${source.premium ? "premium" : "free test key — livescore unavailable"})`);
        const knownGames = async () => (await store.query<Game>(`FROM ${COLL.games}`)).map((r) => r.data);
        if (flags.watch) {
          const interval = num("interval", 120) ?? 120;
          log(`pulse watch every ${interval}s — Ctrl-C to stop`);
          const ctl = new AbortController();
          process.on("SIGINT", () => { ctl.abort(); stop(); process.exit(0); });
          await pulseLoop({ store, source, intervalMs: interval * 1000, knownGames, log, signal: ctl.signal, onTick: (r) => process.stdout.write(JSON.stringify({ tick: r.tick_id, obs: r.observations, raw: r.raw_written, dup: r.raw_duplicates, chg: r.raw_changed, live: r.live_games, seq: r.nedb_seq }) + "\n") });
        } else {
          const r = await pulseTick({ store, source, knownGames: await knownGames(), log });
          process.stdout.write(JSON.stringify(r, null, 2) + "\n");
        }
      } finally {
        if (!flags.watch) stop();
      }
      return;
    }
    case "watch": {
      // Knowledge-layer + pulse loop: re-ingest the season (idempotent — only
      // new/changed games write) and take a pulse tick, on a cadence. This is
      // the only place polling lives (V3 §18, §20).
      const { store, stop } = await boot();
      const season = num("season");
      if (!season) throw new Error("--season required");
      const interval = num("interval", 1800) ?? 1800;
      const source = new NFLDataSource({ onRequest: (i) => { if (i.status !== 200) log(`  HTTP ${i.status} ${i.url}`); } });
      const pulse = new TheSportsDBSource({});
      const deep = resolveWatchDeep(flags.deep, process.env.CHALK_WATCH_DEEP);
      log(`watch season ${season} every ${interval}s (ingest + pulse, deep=${deep}) — Ctrl-C to stop`);
      const ctl = new AbortController();
      process.on("SIGINT", () => { ctl.abort(); stop(); process.exit(0); });
      while (!ctl.signal.aborted) {
        const t0 = Date.now();
        try {
          const r = await ingest({ store, source, scope: { season, deep }, log: () => {} });
          const knownGames = (await store.query<Game>(`FROM ${COLL.games}`)).map((g) => g.data);
          const pt = await pulseTick({ store, source: pulse, knownGames, log: () => {} });
          process.stdout.write(JSON.stringify({ at: new Date().toISOString(), season, games_with_results: r.games_fetched, plays_new: r.normalized_written, plays_dup: r.raw_duplicates, changed: r.raw_changed, errors: r.errors.length, pulse_obs: pt.observations, pulse_changed: pt.raw_changed, live: pt.live_games, seq: pt.nedb_seq, ms: Date.now() - t0 }) + "\n");
        } catch (e) {
          log(`watch tick failed: ${(e as Error).message}`);
        }
        await new Promise((r) => setTimeout(r, interval * 1000));
      }
      return;
    }
    case "rankings": {
      const { store, stop } = await boot();
      try {
        const season = num("season");
        if (!season) throw new Error("--season required");
        const def = (await loadDefinition(store, str("definition", "offense_default@1.0.0")!));
        if (!def) throw new Error("unknown definition");
        const r = await rankings(store, season, def, log);
        process.stdout.write(`${r.definition.name} v${r.definition.version} · ${season} through week ${r.through_week}\n`);
        for (const row of r.rows) process.stdout.write(`${String(row.rank).padStart(2)}. ${row.team.padEnd(4)} ${String(row.score ?? "—").padStart(3)}  ${row.movement === null ? "  " : row.movement > 0 ? `↑${row.movement}` : row.movement < 0 ? `↓${-row.movement}` : "—"}${row.provisional ? " *" : ""}\n`);
      } finally {
        stop();
      }
      return;
    }
    case "audit": {
      const season = num("season", Number(process.env.CHALK_DEFAULT_SEASON ?? 2025))!;
      const { store, stop } = await boot();
      try {
        const a = await auditSeason(store, season);
        const { per_game, ...rest } = a;
        process.stdout.write(JSON.stringify(flags.full === true ? a : rest, null, 2) + "\n");
        log(a.summary);
        if (!a.ok) process.exitCode = 2;
      } finally {
        stop();
      }
      return;
    }
    case "verify": {
      const { store, stop } = await boot();
      try {
        process.stdout.write(JSON.stringify(await store.verify(), null, 2) + "\n");
      } finally {
        stop();
      }
      return;
    }
    case "serve": {
      const { store, stop, mode } = await boot();
      const server = await startServer({
        store,
        host: str("host", process.env.HOST ?? "127.0.0.1")!,
        port: num("port", Number(process.env.PORT ?? 4040))!,
        log,
      });
      // In-process watch loop — mandatory in embedded mode (nothing else can
      // open the data dir), optional in http mode (a separate `chalk watch`
      // process works there too).
      const watchSeason = num("watch-season", process.env.CHALK_WATCH_SEASON ? Number(process.env.CHALK_WATCH_SEASON) : undefined);
      const watchCtl = new AbortController();
      if (watchSeason) {
        const interval = num("watch-interval", Number(process.env.CHALK_WATCH_INTERVAL ?? 1800))!;
        const deep = resolveWatchDeep(flags.deep, process.env.CHALK_WATCH_DEEP);
        log(`watch: season ${watchSeason} every ${interval}s in-process (${mode} store, deep=${deep} — context ${deep ? "included" : `skipped because CHALK_WATCH_DEEP=${JSON.stringify(process.env.CHALK_WATCH_DEEP)}`})`);
        startWatchLoop(store, watchSeason, interval, deep, watchCtl.signal);
      } else {
        log(`watch: off (set CHALK_WATCH_SEASON or --watch-season to re-ingest + pulse on a cadence)`);
      }
      const shutdown = () => {
        log("shutting down");
        watchCtl.abort();
        server.close();
        stop();
        process.exit(0);
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
      return;
    }
    default:
      process.stdout.write(`chalk — football intelligence engine\n\nusage:\n  chalk ingest --season 2025 [--team TB] [--game ID] [--deep]\n  chalk analyze --team TB --season 2025 [--game ID] [--side defense]\n  chalk rate --team TB --season 2025 [--definition ID]\n  chalk scan --team TB --season 2025\n  chalk league --season 2025\n  chalk pulse [--watch] [--interval 120]      near-live game state (TheSportsDB)\n  chalk watch --season 2026 [--interval 1800] re-ingest (deep by default; CHALK_WATCH_DEEP=0 to skip context) + pulse on a cadence\n  chalk rankings --season 2025 [--definition offense_default@1.0.0]\n  chalk audit --season 2025 [--full]        per-game play/context counts; names short or context-less games\n  chalk verify\n  chalk serve [--port 4040] [--host 127.0.0.1]\n`);
      process.exit(cmd ? 1 : 0);
  }
}

main().catch((e) => {
  log(`chalk: ${(e as Error).stack ?? (e as Error).message}`);
  process.exit(1);
});
