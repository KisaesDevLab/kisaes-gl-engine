// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

// Tolerant name matching for AI suggestions.
//
// The LLM returns free-text names (account_name, vendor_name, tag_name)
// that must map back to a real row. Exact case-insensitive equality drops
// near-misses silently ("Office Supplies " vs "office supplies",
// "Utilities - Electric" vs "Utilities Electric"), which surfaces to the
// user as "no suggestion". This module adds normalization + hardening tiers
// that recover the common variance:
//
//   1. canonical: NFKC + lowercase + trim + collapse internal whitespace
//   2. loose:     canonical + strip everything but [a-z0-9 ]
//   3. leading-number strip: a model that echoes the account number
//      ("6100 Office Supplies") is retried with the number removed, so the
//      digits don't defeat the loose match.
//   4. guarded unique-substring: if the model's tokens are a subset of
//      exactly ONE account name (e.g. "Supplies" ⊂ only "Office Supplies"),
//      match it. Ambiguous (>1 candidate) → no match, so this never
//      introduces a false positive between two similarly-named accounts.
//
// Each tier only runs if the earlier ones miss. NOTE: for account
// categorization this whole module is now a BACKWARD-COMPAT FALLBACK — the
// primary path resolves the model's bracketed `account_ref` by array index
// (see ai-categorization.service#resolveAccountRef). It stays the primary
// path for the free-form vendor/tag names.

export function normalizeForMatch(s: string): string {
  return s.normalize('NFKC').toLowerCase().trim().replace(/\s+/g, ' ');
}

export function normalizeLoose(s: string): string {
  return normalizeForMatch(s).replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Strip a leading numeric token (an account number a model echoed in front
 * of the name): "6100 Office Supplies" → "Office Supplies", "1099-Contractor"
 * → "Contractor". Leaves names that merely START with digits but aren't a
 * separated number token intact ("401k Match" stays "401k Match").
 */
export function stripLeadingNumericToken(s: string): string {
  return s.replace(/^\s*#?\d[\d.]*[\s\-–—]+/, '').trim();
}

/**
 * Find the row whose `field` best matches `target`. Exact-canonical first,
 * then punctuation-insensitive, then with a leading account-number token
 * stripped, then a guarded unique-substring tier. Returns undefined for a
 * blank target or no unambiguous match (caller then leaves the field
 * unmapped, same as before).
 */
export function matchByName<T>(
  rows: readonly T[],
  field: (row: T) => string,
  target: string | null | undefined,
): T | undefined {
  if (!target || !target.trim()) return undefined;

  // Try the raw target, then the same target with a leading numeric token
  // stripped (models sometimes echo the account number: "6100 Office
  // Supplies"). Dedupe so the strip pass is skipped when it's a no-op.
  const stripped = stripLeadingNumericToken(target);
  const candidates = stripped && stripped !== target ? [target, stripped] : [target];

  for (const cand of candidates) {
    const canon = normalizeForMatch(cand);
    const exact = rows.find((r) => normalizeForMatch(field(r)) === canon);
    if (exact) return exact;
    const loose = normalizeLoose(cand);
    if (loose) {
      const looseHit = rows.find((r) => normalizeLoose(field(r)) === loose);
      if (looseHit) return looseHit;
    }
  }

  // Guarded unique-substring tier: the model's tokens are a subset of the
  // tokens of exactly one row's name. Recovers a partial name ("Office" →
  // "Office Supplies") without risking a false match when two accounts share
  // the token (ambiguous → no match).
  const looseTarget = normalizeLoose(stripped || target);
  if (looseTarget.length >= 3) {
    const targetTokens = looseTarget.split(' ').filter(Boolean);
    if (targetTokens.length > 0) {
      const subsetMatches = rows.filter((r) => {
        const rowTokens = new Set(normalizeLoose(field(r)).split(' ').filter(Boolean));
        return targetTokens.every((t) => rowTokens.has(t));
      });
      if (subsetMatches.length === 1) return subsetMatches[0];
    }
  }
  return undefined;
}
