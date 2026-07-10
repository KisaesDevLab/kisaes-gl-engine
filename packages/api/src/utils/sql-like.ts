// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * Escape a value destined for a SQL LIKE/ILIKE pattern so its `%` and `_`
 * are treated literally rather than as wildcards.
 *
 * Model-derived strings (a hallucinated OCR vendor like "%" or "%Inc%") must
 * never be interpolated into an ILIKE pattern unescaped — a bare `%` matches
 * every row, silently linking a receipt/bill to an arbitrary contact.
 *
 * Uses PostgreSQL's default LIKE escape character (backslash). Drizzle's
 * `ilike(col, escapeLike(value))` emits `col ILIKE $1`, and Postgres applies
 * `\` as the escape by default, so no explicit `ESCAPE` clause is required.
 * Backslash itself is escaped first so a literal `\` in the input can't form
 * an unintended escape sequence.
 */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}
