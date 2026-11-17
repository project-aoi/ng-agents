import { createHash } from "node:crypto";

/** Deterministic JSON: object keys sorted, `undefined` members dropped (as JSON.stringify does). Used for hashing. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(normalize(value)) ?? "null";
}

function normalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => (v === undefined ? null : normalize(v)));
  if (value instanceof Set) return [...value].map(normalize).sort(compareJson);
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const v = (value as Record<string, unknown>)[key];
    if (v !== undefined && typeof v !== "function") out[key] = normalize(v);
  }
  return out;
}

function compareJson(a: unknown, b: unknown): number {
  const sa = JSON.stringify(a);
  const sb = JSON.stringify(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** JSON column helpers for SQLite TEXT columns. */
export function toJson(value: unknown): string {
  return JSON.stringify(value === undefined ? null : value);
}

export function fromJson<T>(text: string | null | undefined, fallback?: T): T {
  if (text === null || text === undefined) {
    if (fallback !== undefined) return fallback;
    return null as T;
  }
  return JSON.parse(text) as T;
}
