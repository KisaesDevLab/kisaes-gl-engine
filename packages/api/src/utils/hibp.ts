// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import crypto from 'crypto';

// Have I Been Pwned — Pwned Passwords API (k-anonymity).
// https://haveibeenpwned.com/API/v3#PwnedPasswords
//
// The client hashes the password with SHA-1, sends the first 5 hex chars
// of that hash ("prefix"), and the API returns every full SHA-1 hash
// (minus the prefix) from their breach corpus that starts with those
// same 5 chars. No password leaves the server in plaintext or as a full
// hash — the server sees only the 5-char prefix, which maps to ~400–500
// candidate hashes. It's the only anonymous breach check worth trusting
// for server-side login flows.
//
// Network failure must NOT block sign-up. HIBP has had hour-long outages
// before (most recently 2024-11-15). Return `{ ok: true, breached: false,
// skipped: 'network_error' }` so the caller fails open — the user's
// worst-case outcome is a password we didn't check this time, which is
// identical to the pre-HIBP baseline.

export interface HibpCheckResult {
  /** true if the call succeeded (regardless of breach outcome). */
  ok: boolean;
  /** true only when the password was found in the breach corpus. */
  breached: boolean;
  /** Number of breaches containing this password (0 if not found). */
  count: number;
  /** Set on soft-failure paths so callers can log what happened. */
  skipped?: 'network_error' | 'disabled' | 'timeout';
}

const HIBP_URL = 'https://api.pwnedpasswords.com/range';
// HIBP's own SLO is sub-second; 3000ms is generous and still bounded.
// Set HIBP_DISABLED=1 to skip the check entirely (useful in test and
// airgapped environments).
const HIBP_TIMEOUT_MS = 3000;

function sha1Hex(input: string): string {
  return crypto.createHash('sha1').update(input, 'utf8').digest('hex').toUpperCase();
}

/**
 * Query HIBP's Pwned Passwords range endpoint for this password. Returns
 * a soft-success result on network failure so registration/password-
 * change paths don't hard-fail when HIBP is down.
 *
 * If `HIBP_DISABLED` is set (or `NODE_ENV === 'test'`), returns
 * `{ ok: true, breached: false, skipped: 'disabled' }` without a
 * network round-trip — matches every Vitest run without network access.
 */
export async function checkPasswordBreached(password: string): Promise<HibpCheckResult> {
  if (process.env['HIBP_DISABLED'] === '1' || process.env['NODE_ENV'] === 'test') {
    return { ok: true, breached: false, count: 0, skipped: 'disabled' };
  }

  const hash = sha1Hex(password);
  const prefix = hash.slice(0, 5);
  const suffix = hash.slice(5);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HIBP_TIMEOUT_MS);
  try {
    const res = await fetch(`${HIBP_URL}/${prefix}`, {
      headers: {
        // Required per HIBP terms — identifies the caller and opts into
        // the k-anonymity padding extension (response contains random
        // no-op entries, preventing prefix-based fingerprinting of the
        // exact password from network traffic).
        'Add-Padding': 'true',
        'User-Agent': 'vibe-mybooks',
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      return { ok: false, breached: false, count: 0, skipped: 'network_error' };
    }
    const body = await res.text();
    for (const line of body.split('\n')) {
      const [lineSuffix, countStr] = line.trim().split(':');
      if (lineSuffix === suffix) {
        const count = parseInt(countStr || '0', 10);
        // The padding extension inserts entries with `count=0`. Real
        // breached entries always have count >= 1, so a 0 here means
        // padding noise and must not trigger the breach path.
        if (count > 0) return { ok: true, breached: true, count };
      }
    }
    return { ok: true, breached: false, count: 0 };
  } catch (err) {
    const reason = err instanceof Error && err.name === 'AbortError' ? 'timeout' : 'network_error';
    return { ok: false, breached: false, count: 0, skipped: reason };
  } finally {
    clearTimeout(timer);
  }
}
