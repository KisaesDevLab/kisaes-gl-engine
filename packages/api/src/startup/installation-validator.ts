import type { SentinelHeader, SentinelPayload } from '../services/sentinel.service.js';

/**
 * Pure decision function — no IO, no DB, no crypto. The caller (preflight.ts)
 * gathers the current DB / sentinel / host-id state and passes it in; this
 * function maps those inputs to an action. Keeping it pure makes the 12-case
 * matrix testable without docker or a live database.
 *
 * See plans/serialized-watching-moler.md §Verification for the full
 * scenario table.
 */

/** Outcome of trying to read the sentinel file, as seen by the caller. */
export type SentinelReadResult =
  /** No file at /data/.sentinel. */
  | { kind: 'missing' }
  /** File is present but the bytes are unreadable before GCM is even attempted. */
  | { kind: 'corrupt'; code: 'MAGIC' | 'CRC' | 'TRUNCATED' | 'VERSION' }
  /** Header parsed OK, but GCM decryption failed (wrong key or tampered ciphertext). */
  | { kind: 'decrypt-failed'; header: SentinelHeader }
  /** Fully read and decrypted. */
  | { kind: 'full'; header: SentinelHeader; payload: SentinelPayload };

export interface ValidationInput {
  /** `system_settings.installation_id` value, or null if the row does not exist. */
  dbInstallationId: string | null;
  /** Contents of `/data/.host-id`, or null if the file does not exist. */
  currentHostId: string | null;
  /** Outcome of trying to read the sentinel. */
  sentinel: SentinelReadResult;
}

export type ValidationBlockedCode =
  | 'DATABASE_RESET_DETECTED'
  | 'INSTALLATION_MISMATCH'
  | 'SENTINEL_DECRYPT_FAILED'
  | 'SENTINEL_CORRUPT'
  | 'ORPHANED_DATA'
  | 'UNKNOWN';

export type ValidationResult =
  /** All three signals (DB, sentinel, host-id) agree — start normally. */
  | { status: 'ok'; installationId: string; hostId: string }
  /** No DB state, no sentinel, no volume-pinned host ID — genuinely fresh install. */
  | { status: 'fresh-install' }
  /**
   * DB is set up but the sentinel is missing (or the host-id does not match
   * the sentinel). The caller must regenerate the sentinel using current DB
   * state, taking the withSetupLock advisory lock first (F12).
   */
  | {
      status: 'regenerate-sentinel';
      reason: 'missing' | 'host-id-changed' | 'fresh-volume';
      dbInstallationId: string;
      previousHostId?: string;
    }
  /** Startup must not continue — serve a diagnostic page. */
  | {
      status: 'blocked';
      code: ValidationBlockedCode;
      header?: SentinelHeader;
      details: string;
    };

export function validateInstallation(input: ValidationInput): ValidationResult {
  const { dbInstallationId, currentHostId, sentinel } = input;

  switch (sentinel.kind) {
    case 'corrupt':
      // CRC / magic / version / truncation — the file bytes are unusable.
      // Distinct from DECRYPT_FAILED so the diagnostic page can give targeted
      // advice ("regenerate" vs "restore env").
      return {
        status: 'blocked',
        code: 'SENTINEL_CORRUPT',
        details: `sentinel file corrupt: ${sentinel.code}`,
      };

    case 'decrypt-failed':
      return {
        status: 'blocked',
        code: 'SENTINEL_DECRYPT_FAILED',
        header: sentinel.header,
        details: 'ENCRYPTION_KEY does not match the sentinel, or the ciphertext was tampered with',
      };

    case 'missing': {
      if (dbInstallationId === null) {
        // Nothing in DB, nothing in sentinel. If the host-id file already
        // exists, someone populated /data/ without going through setup —
        // orphaned data. Otherwise, genuinely fresh install.
        if (currentHostId !== null) {
          return {
            status: 'blocked',
            code: 'ORPHANED_DATA',
            details:
              'the storage volume contains a host ID but no database state and no sentinel — refusing to re-initialize',
          };
        }
        return { status: 'fresh-install' };
      }
      // DB has ID, sentinel missing — regenerate from DB state under the
      // setup advisory lock. This is the benign upgrade path (installation
      // predates sentinel support) and the "someone deleted /data/.sentinel"
      // recovery path.
      return {
        status: 'regenerate-sentinel',
        reason: 'missing',
        dbInstallationId,
        previousHostId: currentHostId ?? undefined,
      };
    }

    case 'full': {
      const sentinelInstall = sentinel.payload.installationId;
      const sentinelHost = sentinel.payload.hostId;

      // Case 2: primary threat. DB got wiped; sentinel survives. Block.
      if (dbInstallationId === null) {
        return {
          status: 'blocked',
          code: 'DATABASE_RESET_DETECTED',
          header: sentinel.header,
          details: `sentinel proves installation ${sentinelInstall} was previously set up, but the database has no installation_id row — refusing to re-initialize`,
        };
      }

      // Case 7: IDs don't match. Either the DB was swapped, or someone
      // restored a backup on the wrong server.
      if (dbInstallationId !== sentinelInstall) {
        return {
          status: 'blocked',
          code: 'INSTALLATION_MISMATCH',
          header: sentinel.header,
          details: `DB installation_id ${dbInstallationId} does not match sentinel ${sentinelInstall}`,
        };
      }

      // Case 8 / 9: installation IDs match. If the host-id file is missing
      // or differs from the sentinel, we're on a new storage volume — treat
      // as a legitimate cross-host restore and regenerate the sentinel with
      // a fresh host-id while keeping the installation_id.
      if (currentHostId === null) {
        return {
          status: 'regenerate-sentinel',
          reason: 'fresh-volume',
          dbInstallationId: sentinelInstall,
          previousHostId: sentinelHost,
        };
      }
      if (currentHostId !== sentinelHost) {
        return {
          status: 'regenerate-sentinel',
          reason: 'host-id-changed',
          dbInstallationId: sentinelInstall,
          previousHostId: sentinelHost,
        };
      }

      // Case 1: everything matches. Normal startup.
      return { status: 'ok', installationId: sentinelInstall, hostId: sentinelHost };
    }

    default: {
      const _exhaustive: never = sentinel;
      void _exhaustive;
      return { status: 'blocked', code: 'UNKNOWN', details: 'unreachable' };
    }
  }
}
