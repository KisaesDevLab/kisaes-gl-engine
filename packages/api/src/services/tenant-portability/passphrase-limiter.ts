// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * Per-user limiter on archive passphrase attempts (M3). Every import
 * attempt costs a PBKDF2 derivation (~1 s of CPU) and a wrong passphrase
 * is the only signal an offline guess gets, so after MAX_FAILURES wrong
 * passphrases inside WINDOW_MS the user waits: 429 PASSPHRASE_RATE_LIMITED
 * before any derivation runs. A correct passphrase clears the counter.
 * In-memory, per process (the desktop has one).
 */

import { ArchiveError } from './errors.js';

let maxFailures = 5;
let windowMs = 15 * 60 * 1000;

const failures = new Map<string, number[]>();

function recent(userId: string, now: number): number[] {
  const list = (failures.get(userId) ?? []).filter((t) => now - t < windowMs);
  if (list.length === 0) failures.delete(userId);
  else failures.set(userId, list);
  return list;
}

/** 429 PASSPHRASE_RATE_LIMITED when the user has exhausted their attempts in the window. */
export function assertPassphraseAttemptAllowed(userId: string, now = Date.now()): void {
  const list = recent(userId, now);
  if (list.length >= maxFailures) {
    const retryAfterSec = Math.max(1, Math.ceil((list[0]! + windowMs - now) / 1000));
    throw new ArchiveError('PASSPHRASE_RATE_LIMITED', 'Too many wrong passphrases. Wait before trying again.', { retryAfterSec });
  }
}

export function recordPassphraseFailure(userId: string, now = Date.now()): void {
  failures.set(userId, [...recent(userId, now), now]);
}

export function clearPassphraseFailures(userId: string): void {
  failures.delete(userId);
}

/** Test hooks. */
export function _configurePassphraseLimiterForTests(opts: { maxFailures?: number; windowMs?: number }): void {
  if (opts.maxFailures !== undefined) maxFailures = opts.maxFailures;
  if (opts.windowMs !== undefined) windowMs = opts.windowMs;
}

export function _resetPassphraseLimiterForTests(): void {
  maxFailures = 5;
  windowMs = 15 * 60 * 1000;
  failures.clear();
}
