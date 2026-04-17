// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

// Coerce caller-supplied ?limit= / ?offset= values into safe bounds. Without
// these helpers, routes that parseInt() the raw query accept unbounded
// requests like ?limit=1e9, which at best waste DB work and at worst OOM
// the server when building large result sets in memory.

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

export function parseLimit(raw: unknown, defaultValue = DEFAULT_LIMIT, max = MAX_LIMIT): number {
  const n = typeof raw === 'string' ? parseInt(raw, 10) : typeof raw === 'number' ? raw : NaN;
  if (!Number.isFinite(n) || n <= 0) return defaultValue;
  return Math.min(Math.floor(n), max);
}

export function parseOffset(raw: unknown): number {
  const n = typeof raw === 'string' ? parseInt(raw, 10) : typeof raw === 'number' ? raw : NaN;
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}
