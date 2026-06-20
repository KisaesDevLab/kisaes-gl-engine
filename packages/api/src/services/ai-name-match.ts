// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

// Tolerant name matching for AI suggestions.
//
// The LLM returns free-text names (account_name, vendor_name, tag_name)
// that must map back to a real row. Exact case-insensitive equality drops
// near-misses silently ("Office Supplies " vs "office supplies",
// "Utilities - Electric" vs "Utilities Electric"), which surfaces to the
// user as "no suggestion". This module adds two normalization tiers that
// recover the common variance WITHOUT the false-positive risk of
// substring or edit-distance matching:
//
//   1. canonical: NFKC + lowercase + trim + collapse internal whitespace
//   2. loose:     canonical + strip everything but [a-z0-9 ]
//
// Tier 2 only runs if tier 1 misses, so a punctuation-only difference is
// matched but two genuinely different names are not.

export function normalizeForMatch(s: string): string {
  return s.normalize('NFKC').toLowerCase().trim().replace(/\s+/g, ' ');
}

export function normalizeLoose(s: string): string {
  return normalizeForMatch(s).replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Find the row whose `field` best matches `target`. Exact-canonical first,
 * then punctuation-insensitive. Returns undefined for a blank target or no
 * match (caller then leaves the field unmapped, same as before).
 */
export function matchByName<T>(
  rows: readonly T[],
  field: (row: T) => string,
  target: string | null | undefined,
): T | undefined {
  if (!target || !target.trim()) return undefined;
  const canon = normalizeForMatch(target);
  const exact = rows.find((r) => normalizeForMatch(field(r)) === canon);
  if (exact) return exact;
  const loose = normalizeLoose(target);
  if (!loose) return undefined;
  return rows.find((r) => normalizeLoose(field(r)) === loose);
}
