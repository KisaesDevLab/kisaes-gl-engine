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
 */

const TTL_MS = 30 * 60 * 1000; // 30 minutes

interface Pending {
  recoveryKey: string;
  expiresAt: number;
}

const pending = new Map<string, Pending>();

function purgeExpired(now: number): void {
  for (const [id, p] of pending) {
    if (p.expiresAt <= now) pending.delete(id);
  }
}

export function stashPendingRecoveryKey(installationId: string, recoveryKey: string): void {
  pending.set(installationId, {
    recoveryKey,
    expiresAt: Date.now() + TTL_MS,
  });
}

export function peekPendingRecoveryKey(installationId: string): string | null {
  purgeExpired(Date.now());
  const entry = pending.get(installationId);
  return entry?.recoveryKey ?? null;
}

export function acknowledgePendingRecoveryKey(installationId: string): boolean {
  purgeExpired(Date.now());
  return pending.delete(installationId);
}

/** Test helper — clears the in-memory map. Not exported in production code paths. */
export function __clearPending(): void {
  pending.clear();
}
