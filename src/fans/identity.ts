/*
 * SPDX-License-Identifier: BUSL-1.1
 * Copyright (c) 2026 Interchained LLC. All rights reserved.
 * CHALK / Sports-Rater — https://sports-rater.com — Licensor: Interchained LLC
 */
/**
 * Sports-Rater identity — no accounts (Mark, 2026-09-03: "no user account,
 * more feed-like, hash chain").
 *
 * The CLIENT computes  fan_id = sha256(`${nickname}:${salt}`)  with WebCrypto;
 * the salt never leaves the device (localStorage). The handle shown on every
 * post is `${nickname}#${fan_id.slice(0, 6)}`. The server stores only the
 * handle and fan_id on the fan's writes — there is no fan table, no profile,
 * nothing to breach. Identity is math.
 *
 * Verification the server CAN do: handle shape, and that the handle suffix is
 * the fan_id prefix. It cannot prove the fan owns the salt — that is the
 * accepted model (same as mantel). Anti-spam is a per-fan and per-IP token
 * bucket, escalating to hashcash-style stamps later if bots arrive.
 *
 * The identicon is a 5x5 mirrored grid derived from fan_id bytes, rendered as
 * SVG — same input, same picture, everywhere, forever.
 */
import { createHash } from "node:crypto";

export interface FanIdentity {
  fan_id: string;
  handle: string;
  nickname: string;
}

const NICK_RE = /^[A-Za-z0-9_][A-Za-z0-9_ .\-]{0,23}$/;
const FAN_ID_RE = /^[0-9a-f]{64}$/;

/** Server-side reference implementation of the client's derivation (tests + CLI). */
export function deriveFanId(nickname: string, salt: string): string {
  return createHash("sha256").update(`${nickname}:${salt}`, "utf8").digest("hex");
}

export function handleFor(nickname: string, fan_id: string): string {
  return `${nickname}#${fan_id.slice(0, 6)}`;
}

export interface IdentityCheck {
  ok: boolean;
  identity?: FanIdentity;
  errors: string[];
}

export function verifyIdentity(input: unknown): IdentityCheck {
  const errors: string[] = [];
  if (!input || typeof input !== "object") return { ok: false, errors: ["identity: object required"] };
  const o = input as Record<string, unknown>;
  const fan_id = typeof o.fan_id === "string" ? o.fan_id.toLowerCase() : "";
  const handle = typeof o.handle === "string" ? o.handle.trim() : "";
  if (!FAN_ID_RE.test(fan_id)) errors.push("fan_id: 64 hex chars (sha256 of nickname:salt)");
  const hash = handle.lastIndexOf("#");
  const nickname = hash > 0 ? handle.slice(0, hash) : "";
  const suffix = hash > 0 ? handle.slice(hash + 1) : "";
  if (!NICK_RE.test(nickname)) errors.push("handle: nickname 1-24 chars [A-Za-z0-9_ .-], then #xxxxxx");
  if (!/^[0-9a-f]{6}$/.test(suffix)) errors.push("handle: suffix must be 6 hex chars");
  if (!errors.length && suffix !== fan_id.slice(0, 6)) errors.push("handle suffix does not match fan_id");
  if (errors.length) return { ok: false, errors };
  return { ok: true, identity: { fan_id, handle: `${nickname}#${suffix}`, nickname }, errors: [] };
}

/** Deterministic identicon: 5x5 mirrored grid, two colors from the hash. */
export function identiconSvg(fan_id: string, size = 40): string {
  const bytes = Buffer.from(fan_id.slice(0, 32), "hex");
  const hue = (bytes[0] * 360) / 255;
  const hue2 = (hue + 150 + (bytes[1] % 60)) % 360;
  const cells: string[] = [];
  const s = size / 5;
  for (let y = 0; y < 5; y++) {
    for (let x = 0; x < 3; x++) {
      const bit = (bytes[2 + y] >> x) & 1;
      if (!bit) continue;
      const fill = ((bytes[7 + y] >> x) & 1) ? `hsl(${hue.toFixed(0)} 80% 60%)` : `hsl(${hue2.toFixed(0)} 70% 55%)`;
      cells.push(`<rect x="${(x * s).toFixed(2)}" y="${(y * s).toFixed(2)}" width="${s.toFixed(2)}" height="${s.toFixed(2)}" fill="${fill}"/>`);
      if (x < 2) cells.push(`<rect x="${((4 - x) * s).toFixed(2)}" y="${(y * s).toFixed(2)}" width="${s.toFixed(2)}" height="${s.toFixed(2)}" fill="${fill}"/>`);
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" rx="${(size / 5).toFixed(1)}" fill="#0f141b"/>${cells.join("")}</svg>`;
}

/** Token bucket per key (fan_id or ip). */
export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  private readonly capacity: number;
  private readonly refillPerMs: number;
  constructor(capacity: number, refillPerMs: number) {
    this.capacity = capacity;
    this.refillPerMs = refillPerMs;
  }
  take(key: string, now = Date.now()): { ok: boolean; retry_after_ms: number } {
    const b = this.buckets.get(key) ?? { tokens: this.capacity, at: now };
    b.tokens = Math.min(this.capacity, b.tokens + (now - b.at) * this.refillPerMs);
    b.at = now;
    if (b.tokens >= 1) {
      b.tokens -= 1;
      this.buckets.set(key, b);
      return { ok: true, retry_after_ms: 0 };
    }
    this.buckets.set(key, b);
    return { ok: false, retry_after_ms: Math.ceil((1 - b.tokens) / this.refillPerMs) };
  }
  /** Drop idle buckets so the map does not grow forever. */
  sweep(now = Date.now(), idleMs = 3_600_000): void {
    for (const [k, b] of this.buckets) if (now - b.at > idleMs) this.buckets.delete(k);
  }
}
