// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Parse a check number out of a bank-statement transaction description.
// Banks render check transactions many ways: "CHECK 1234", "CHECK #1234",
// "CHK 1234", "CK 1234", "CHECK NO. 1234", "DRAFT 1234", or a bare "#1234".
// Used to correlate a "CHECK ####" row with a payee read off the matching
// check-image thumbnail (STATEMENT_CHECK_PAYEE_V1).

// Reject implausible values: real check numbers are positive and well under
// the integer column's range. 7 digits covers any realistic sequence while
// rejecting account/routing/card numbers that survive description masking.
const MAX_CHECK_NUMBER = 9_999_999;

// Anchored prefixes (word boundary) followed by an optional "no"/"#" and the
// digits. Falls back to a bare "#1234". Case-insensitive.
const CHECK_PREFIX = /\b(?:check|chk|ck|draft)\b\s*(?:no\.?|number|#)?\s*0*(\d{1,7})\b/i;
const HASH_ONLY = /(?:^|\s)#\s*0*(\d{1,7})\b/;

export function parseCheckNumber(description: string | null | undefined): number | null {
  if (!description) return null;
  const m = CHECK_PREFIX.exec(description) ?? HASH_ONLY.exec(description);
  if (!m) return null;
  const n = Number.parseInt(m[1]!, 10);
  if (!Number.isFinite(n) || n <= 0 || n > MAX_CHECK_NUMBER) return null;
  return n;
}
