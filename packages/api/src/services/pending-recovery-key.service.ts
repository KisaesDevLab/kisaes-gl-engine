// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * In-memory holding area for the recovery key produced by /initialize or
 * /restore/execute, until the operator clicks "I have saved this" on the
 * wizard screen. F22.
 *
 * Why server-side instead of just returning it in the response body?
 *   - If the operator closes the tab or the browser crashes between the
 *     /initialize response landing and the acknowledgement click, the key
 *     would be lost forever (it is never stored in plaintext on disk).
 *   - By caching the key for a short TTL on the server, the wizard can
 *     re-display it on a reload without ever rewriting .env.recovery with
 *     a new key — which is important because the existing .env.recovery
 *     was already written with THIS specific key.
 *
 * Expired entries are purged lazily on read. No timer — the TTL is short
 * enough that a forgotten entry sticks around at most a few extra minutes.
 * The process restart also wipes the map, and the admin Security page
 * "Generate new recovery key" action is always available as a fallback.
 *
 * NOT persisted anywhere. NOT logged. Removed the moment the operator
 * acknowledges or the TTL expires.
 *
 * Access control: the installationId is PUBLIC (GET /setup/status returns
 * it), so it cannot gate the key by itself — an unauthenticated caller who
 * read /status could otherwise fetch the key during the pending window.
 * stash() therefore mints a random claim token, returned only in the
 * /initialize response / restore run result (itself gated by the
 * unguessable runId). Reading or acknowledging the pending key requires
 * presenting that token; the wizard keeps it browser-side for reloads.
 */

import crypto from 'crypto';

const TTL_MS = 30 * 60 * 1000; // 30 minutes

interface Pending {
  recoveryKey: string;
  claimToken: string;
  expiresAt: number;
}

const pending = new Map<string, Pending>();

function purgeExpired(now: number): void {
  for (const [id, p] of pending) {
    if (p.expiresAt <= now) pending.delete(id);
  }
}

function tokenMatches(entry: Pending, claimToken: string): boolean {
  const expected = Buffer.from(entry.claimToken);
  const given = Buffer.from(claimToken);
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

/** Stash the key; returns the claim token required to read/acknowledge it. */
export function stashPendingRecoveryKey(installationId: string, recoveryKey: string): string {
  const claimToken = crypto.randomBytes(32).toString('hex');
  pending.set(installationId, {
    recoveryKey,
    claimToken,
    expiresAt: Date.now() + TTL_MS,
  });
  return claimToken;
}

/** True if an unexpired entry exists — safe to expose (boolean only). */
export function hasPendingRecoveryKey(installationId: string): boolean {
  purgeExpired(Date.now());
  return pending.has(installationId);
}

export function peekPendingRecoveryKey(installationId: string, claimToken: string): string | null {
  purgeExpired(Date.now());
  const entry = pending.get(installationId);
  if (!entry || !claimToken || !tokenMatches(entry, claimToken)) return null;
  return entry.recoveryKey;
}

export function acknowledgePendingRecoveryKey(installationId: string, claimToken: string): boolean {
  purgeExpired(Date.now());
  const entry = pending.get(installationId);
  if (!entry || !claimToken || !tokenMatches(entry, claimToken)) return false;
  return pending.delete(installationId);
}

/** Test helper — clears the in-memory map. Not exported in production code paths. */
export function __clearPending(): void {
  pending.clear();
}
