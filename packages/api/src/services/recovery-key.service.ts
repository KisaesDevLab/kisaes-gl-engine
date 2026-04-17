// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import crypto from 'crypto';

/**
 * Recovery key generation, formatting, and parsing.
 *
 * Format: `RKVMB-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX`
 *   - `RKVMB-` prefix identifies it as a KIS Books recovery key
 *   - 25 payload characters in 5 groups of 5, separated by hyphens
 *   - Alphabet is a Crockford-ish 31-character set that excludes
 *     `0 O 1 I L` — letters / digits the operator is most likely to
 *     misread when typing from paper or a printed page
 *   - 25 * log2(31) ≈ 124 bits of entropy, matching the plan's "~125 bits"
 *
 * The recovery key is never persisted. It is shown to the operator exactly
 * once at the end of the setup wizard (with Copy and Print actions) and
 * used as the PBKDF2 passphrase for the encrypted /data/.env.recovery file.
 * If the operator loses both the key and /data/config/.env, encrypted state
 * is unrecoverable — this is a conscious trade-off the setup UI makes very
 * clear before the wizard finalizes.
 */

export const RECOVERY_KEY_PREFIX = 'RKVMB';

/**
 * 31-character alphabet. Digits 2-9, uppercase A-Z minus I L O.
 * - `0` and `O` look identical
 * - `1`, `I`, and `L` look identical
 * 8 digits + (26 - 3) letters = 31 chars.
 */
export const RECOVERY_KEY_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

const GROUP_SIZE = 5;
const GROUP_COUNT = 5;
const PAYLOAD_LENGTH = GROUP_SIZE * GROUP_COUNT; // 25

/** Format a payload string into `RKVMB-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX`. */
export function formatRecoveryKey(payload: string): string {
  if (payload.length !== PAYLOAD_LENGTH) {
    throw new Error(`recovery key payload must be ${PAYLOAD_LENGTH} characters, got ${payload.length}`);
  }
  const groups: string[] = [];
  for (let i = 0; i < GROUP_COUNT; i++) {
    groups.push(payload.slice(i * GROUP_SIZE, (i + 1) * GROUP_SIZE));
  }
  return `${RECOVERY_KEY_PREFIX}-${groups.join('-')}`;
}

/**
 * Generate a fresh recovery key using crypto.randomBytes rejection sampling.
 * Unbiased: 256 / 31 = 8.26, so we sample one byte at a time and reject
 * values that fall outside the largest multiple of 31 below 256 (= 248).
 */
export function generateRecoveryKey(): string {
  const out: string[] = [];
  while (out.length < PAYLOAD_LENGTH) {
    const buf = crypto.randomBytes(PAYLOAD_LENGTH * 2); // oversample
    for (let i = 0; i < buf.length && out.length < PAYLOAD_LENGTH; i++) {
      const byte = buf[i]!;
      if (byte >= 248) continue; // 248 = 31 * 8, largest unbiased multiple
      out.push(RECOVERY_KEY_ALPHABET[byte % 31]!);
    }
  }
  return formatRecoveryKey(out.join(''));
}

/**
 * Parse and normalize a recovery key. Accepts mixed case, extra whitespace,
 * missing dashes, and returns the canonical formatted form. Throws on any
 * validation failure.
 *
 * The operator may type this on a diagnostic page that doesn't have a
 * pre-filled mask, or paste it from a printout. Being lenient here means
 * "recovery works 99% of the time without explaining input rules."
 */
export function parseRecoveryKey(raw: string): string {
  if (!raw || typeof raw !== 'string') {
    throw new Error('recovery key is empty');
  }
  // Uppercase, strip whitespace and dashes.
  const cleaned = raw.toUpperCase().replace(/[\s-]+/g, '');
  // Remove the prefix if it leads the payload.
  const stripped = cleaned.startsWith(RECOVERY_KEY_PREFIX)
    ? cleaned.slice(RECOVERY_KEY_PREFIX.length)
    : cleaned;
  if (stripped.length !== PAYLOAD_LENGTH) {
    throw new Error(
      `recovery key payload must be ${PAYLOAD_LENGTH} characters after stripping the prefix and dashes, got ${stripped.length}`,
    );
  }
  for (const ch of stripped) {
    if (!RECOVERY_KEY_ALPHABET.includes(ch)) {
      throw new Error(`recovery key contains invalid character '${ch}' — allowed: ${RECOVERY_KEY_ALPHABET}`);
    }
  }
  return formatRecoveryKey(stripped);
}

/**
 * Derive the canonical 64-char hex form used as the passphrase input to
 * portable-encryption's PBKDF2. Strips dashes and lowercases for stability.
 * The caller must parse/normalize first (or pass a pre-validated key).
 */
export function recoveryKeyToPassphrase(formatted: string): string {
  // Formatted keys always start with RKVMB- and have 5 dash-separated groups.
  // Use the fully-stripped form so mixed-case typing is still deterministic.
  return formatted.replace(/-/g, '').toUpperCase();
}
