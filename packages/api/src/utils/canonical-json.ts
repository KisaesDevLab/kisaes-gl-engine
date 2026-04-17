// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

/**
 * Deterministic JSON serialization for content hashing.
 *
 * Object keys are sorted lexicographically; arrays keep their order;
 * strings, numbers, booleans, and null serialize identically to JSON.stringify
 * with no whitespace. Used to produce stable sha256 checksums for the
 * sentinel payload — see sentinel.service.ts F3.
 *
 * Does NOT support: functions, undefined, Dates, Maps, Sets, Symbols,
 * BigInts, or circular refs. Callers must pass plain JSON-compatible data.
 */
export function canonicalize(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('canonicalize: non-finite number');
    return JSON.stringify(value);
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) {
    return '[' + value.map((v) => canonicalize(v)).join(',') + ']';
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const parts: string[] = [];
    for (const k of keys) {
      const v = obj[k];
      if (v === undefined) continue;
      parts.push(JSON.stringify(k) + ':' + canonicalize(v));
    }
    return '{' + parts.join(',') + '}';
  }
  throw new Error(`canonicalize: unsupported type ${typeof value}`);
}
