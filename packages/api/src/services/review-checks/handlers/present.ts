// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Human-presentation helpers shared by check handlers. Every finding
// payload carries three reviewer-facing fields the drawer renders
// prominently:
//   summary    — the record under review ("2026-07-06 · Starbucks · $14.52")
//   reason     — why the check flagged it
//   suggestion — what an experienced accountant would do next
// Ids stay in the payload for deep links but are presented separately.

/** "$1,234.56" — tolerant of string numerics from SQL. */
export function money(v: unknown): string {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''));
  if (!Number.isFinite(n)) return String(v ?? '—');
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

/** Join the non-empty parts with " · ". */
export function summaryLine(...parts: Array<string | null | undefined>): string {
  return parts.filter((p) => p != null && String(p).trim() !== '').join(' · ');
}
