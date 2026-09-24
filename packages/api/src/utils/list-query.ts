// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Small helpers for list routes that hand-parse req.query: whitelist a sort
// key, parse a comma-joined set, and turn a direction into SQL. An unknown
// value yields undefined (the list's default order / no filter) rather than
// an error — the zod-validated lists get the strict behaviour instead.

import { sql, type SQL } from 'drizzle-orm';

export function pickEnum<T extends string>(v: unknown, allowed: readonly T[]): T | undefined {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : undefined;
}

/** `a,b` → ['a','b'] limited to `allowed`; undefined when nothing survives. */
export function parseCsvSet<T extends string>(v: unknown, allowed: readonly T[]): T[] | undefined {
  if (typeof v !== 'string') return undefined;
  const set = new Set<string>(allowed);
  const out = v.split(',').map((s) => s.trim()).filter((s) => set.has(s)) as T[];
  return out.length > 0 ? [...new Set(out)] : undefined;
}

export function sortDirSql(dir: 'asc' | 'desc' | undefined, fallback: 'asc' | 'desc' = 'desc'): SQL {
  return (dir ?? fallback) === 'asc' ? sql`ASC` : sql`DESC`;
}
