// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

/**
 * Well-known keys for the `system_settings` k/v table. Prefer these constants
 * over string literals so refactors are typecheck-safe.
 */
export const SystemSettingsKeys = {
  /**
   * The installation UUID generated during first-run setup. Written once and
   * never changed (rotation is a Phase B feature). Authoritative source for
   * "this DB has been set up" — used by installation-validator.ts to detect
   * database-reset scenarios where the encrypted sentinel file at
   * /data/.sentinel survived.
   */
  INSTALLATION_ID: 'installation_id',
} as const;

export type SystemSettingsKey = (typeof SystemSettingsKeys)[keyof typeof SystemSettingsKeys];
