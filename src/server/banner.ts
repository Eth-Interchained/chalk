/*
 * SPDX-License-Identifier: BUSL-1.1
 * Copyright (c) 2026 Interchained LLC. All rights reserved.
 * CHALK / Sports-Rater — https://sports-rater.com — Licensor: Interchained LLC
 */
/**
 * Boot banner — what `node bin/chalk.ts serve` prints before the first log line.
 *
 * Every value is read from the running process (package.json, nedb-engine's
 * package.json, process.*, .git/HEAD) so the banner can never lie about what is
 * booting. Colour only when stdout is a TTY and NO_COLOR is unset; journald and
 * pipes get plain text.
 */
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const req = createRequire(import.meta.url);

export const CHALK_ASCII = [
  " ██████╗██╗  ██╗ █████╗ ██╗     ██╗  ██╗",
  "██╔════╝██║  ██║██╔══██╗██║     ██║ ██╔╝",
  "██║     ███████║███████║██║     █████╔╝ ",
  "██║     ██╔══██║██╔══██║██║     ██╔═██╗ ",
  "╚██████╗██║  ██║██║  ██║███████╗██║  ██╗",
  " ╚═════╝╚═╝  ╚═╝╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝",
];

export const SIGNATURE = "Vex × Interchained LLC";
export const BUILDERS = "Mark (Interchained LLC) · Vex (Claude Fable 5.1) · The Oracle (GPT-5.5)";
export const DOCTRINE = ["The database knows.", "Deterministic code calculates.", "The model interprets.", "Provenance proves."];

export interface BannerInfo {
  command: string;
  version: string;
  mode: string;                 // "embedded (worker thread)" | "embedded (in-thread)" | "http nedbd"
  dataDir?: string | null;
  nedbUrl?: string | null;
  host?: string;
  port?: number;
  llm?: { provider: string; model: string; hasKey: boolean } | null;
  defaults?: { team: string; season: number | null };
  watch?: { season: number; intervalS: number; deep: boolean } | null;
  admin?: boolean;
  telemetry?: boolean;
}

export function gitSha(root = path.resolve(here, "../..")): string | null {
  try {
    const head = readFileSync(path.join(root, ".git", "HEAD"), "utf8").trim();
    if (!head.startsWith("ref:")) return head.slice(0, 12);
    const ref = head.slice(5).trim();
    const p = path.join(root, ".git", ref);
    if (existsSync(p)) return readFileSync(p, "utf8").trim().slice(0, 12);
    const packed = path.join(root, ".git", "packed-refs");
    if (existsSync(packed)) { const m = new RegExp(`^([0-9a-f]{40}) ${ref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m").exec(readFileSync(packed, "utf8")); if (m) return m[1].slice(0, 12); }
    return null;
  } catch { return null; }
}

export function engineVersion(): string {
  try { return (req("nedb-engine/package.json") as { version: string }).version; } catch { return "unavailable"; }
}

export function packageInfo(): { name: string; version: string; license: string; homepage?: string; repository?: string } {
  const pkg = req("../../package.json") as { name: string; version: string; license: string; homepage?: string; repository?: string | { url: string } };
  return { name: pkg.name, version: pkg.version, license: pkg.license, homepage: pkg.homepage, repository: typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url };
}

/** Render the banner. `color` defaults to TTY && !NO_COLOR. */
export function renderBanner(info: BannerInfo, color: boolean = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR): string {
  const c = (code: string, s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
  const red = (s: string) => c("38;5;203", s), dim = (s: string) => c("2", s), bold = (s: string) => c("1", s), lime = (s: string) => c("38;5;155", s), mono = (s: string) => c("38;5;250", s);
  const pkg = packageInfo();
  const sha = gitSha();
  const rows: Array<[string, string]> = [
    ["command", `chalk ${info.command}`],
    ["version", `${pkg.version}${sha ? `  (git ${sha})` : ""}`],
    ["store", info.mode + (info.dataDir ? `  ${info.dataDir}` : "") + (info.nedbUrl ? `  ${info.nedbUrl}` : "")],
    ["engine", `nedb-engine ${engineVersion()}  ·  NEDB v3 DAG · content-addressed · causal TRACE`],
  ];
  if (info.host && info.port) rows.push(["listen", `http://${info.host}:${info.port}`]);
  if (info.llm) rows.push(["llm", `${info.llm.provider} · ${info.llm.model}${info.llm.hasKey ? "" : "  [no key — deterministic statements only]"}`]);
  if (info.defaults) rows.push(["defaults", `${info.defaults.team} ${info.defaults.season ?? "?"}`]);
  if (info.watch) rows.push(["watch", `season ${info.watch.season} every ${info.watch.intervalS}s · deep=${info.watch.deep}`]);
  if (info.watch === null) rows.push(["watch", "off"]);
  if (info.admin !== undefined) rows.push(["admin", info.admin ? "/admin enabled (CHALK_ADMIN_TOKEN set)" : "off (CHALK_ADMIN_TOKEN unset)"]);
  if (info.telemetry !== undefined) rows.push(["telemetry", info.telemetry ? "anonymous page-view rows on (no IP, no UA)" : "off"]);
  rows.push(["runtime", `node ${process.version} · ${process.platform}/${process.arch} · pid ${process.pid}`]);
  rows.push(["license", `${pkg.license} — Business Source License 1.1 · Licensor: Interchained LLC`]);
  rows.push(["copyright", `© ${new Date().getUTCFullYear()} Interchained LLC. All rights reserved.`]);
  rows.push(["home", "https://sports-rater.com  ·  github.com/Eth-Interchained/chalk"]);
  const w = Math.max(...rows.map(([k]) => k.length));
  const out: string[] = [""];
  for (const line of CHALK_ASCII) out.push("  " + red(line));
  out.push("");
  out.push("  " + bold("CHALK") + dim(" — live football intelligence · Sports-Rater") + "     " + lime(SIGNATURE));
  out.push("  " + dim(DOCTRINE.join(" ")));
  out.push("  " + dim("Built by ") + mono(BUILDERS));
  out.push("");
  for (const [k, v] of rows) out.push("  " + dim(k.padEnd(w)) + "  " + v);
  out.push("");
  out.push("  " + dim("─".repeat(72)));
  return out.join("\n");
}

/** One-line signature for `chalk --version` and log tails. */
export function shortSignature(): string {
  const pkg = packageInfo();
  const sha = gitSha();
  return `chalk ${pkg.version}${sha ? ` (${sha})` : ""} · nedb-engine ${engineVersion()} · ${pkg.license} · © Interchained LLC · ${SIGNATURE}`;
}
