// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

/**
 * Stdout audit trail for system-wide sentinel operations.
 *
 * `audit_log.tenant_id` is NOT NULL, so sentinel events (create, regenerate,
 * reset, mismatch detected) can't live there without a schema change. Phase A
 * logs to stdout with a stable prefix so an operator or log aggregator can
 * grep for installation-integrity events. Phase C can widen the schema and
 * migrate these to the real audit table.
 *
 * Matches CLAUDE.md rule #9 in spirit — every security-sensitive action
 * produces a permanent, greppable record — without blocking Phase A on a
 * migration.
 */
export type SentinelAuditEvent =
  | 'sentinel.create'
  | 'sentinel.regenerate'
  | 'sentinel.reset'
  | 'installation.mismatch_detected'
  | 'installation.host_id_changed'
  | 'installation.database_reset_detected'
  | 'installation.corrupt_sentinel_detected'
  | 'installation.decrypt_failed'
  | 'installation.orphaned_data_detected'
  // vibe-mybooks-compatibility-addendum §3.4 — MIGRATIONS_AUTO=false
  // operator-state events
  | 'installation.migrations_pending'
  | 'installation.database_ahead_of_code'
  // Phase B recovery events
  | 'recovery.key_regenerated'
  | 'recovery.key_used'
  | 'recovery.key_deleted';

export function sentinelAudit(event: SentinelAuditEvent, details: Record<string, unknown> = {}): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    kind: 'sentinel-audit',
    event,
    ...details,
  });
  console.log(`[sentinel-audit] ${line}`);
}
