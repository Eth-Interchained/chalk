/**
 * Canonical hashing for source payloads and derived ids.
 *
 * source_hash = blake2b-256 over the canonical JSON serialization of a payload
 * (keys sorted recursively, no whitespace, -0 → 0, NaN/Infinity rejected).
 * Two responses that encode the same record hash identically regardless of
 * key order, so a re-ingest is a byte-level "did upstream change?" test.
 *
 * NEDB itself uses BLAKE2b for object hashes; we use the same family so a
 * reader sees one hash algorithm throughout the provenance graph.
 */
import { createHash } from "node:crypto";

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new TypeError("canonicalJson: non-finite number");
      return value === 0 ? 0 : value; // normalizes -0
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(sortKeys);
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(value as Record<string, unknown>).sort()) {
    const v = (value as Record<string, unknown>)[k];
    if (v !== undefined) out[k] = sortKeys(v);
  }
  return out;
}

/** blake2b-256 hex of the canonical JSON. */
export function hashPayload(value: unknown): string {
  return createHash("blake2b512").update(canonicalJson(value)).digest("hex").slice(0, 64);
}

/** Deterministic id from parts — `${prefix}_${blake2b(parts)[0:16]}`. */
export function deterministicId(prefix: string, parts: unknown): string {
  return `${prefix}_${hashPayload(parts).slice(0, 16)}`;
}
