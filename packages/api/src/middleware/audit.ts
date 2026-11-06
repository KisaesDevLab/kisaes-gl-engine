// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { db, type DbOrTx } from '../db/index.js';
import { auditLog as auditLogTable } from '../db/schema/audit-log.js';
import { stripSecretKeys } from '../utils/secret-keys.js';

/**
 * Writes one audit row. `before` / `after` are usually whole rows; any
 * secret-looking key in them (utils/secret-keys.ts: passwords, tokens,
 * encrypted blobs, hashes, remote-backup config) is stripped at every depth
 * before the insert, so the audit log never stores a credential.
 */
export async function auditLog(
  tenantId: string,
  // 'signoff' + 'override' added by the TB module (leadsheet sign-offs,
  // closing-date overrides) — QUESTIONS.md #5.
  // 'unsign' + 'invalidate' added by reconciliation sign-offs (migration 0214).
  action: 'create' | 'update' | 'delete' | 'void' | 'login' | 'download' | 'signoff' | 'override' | 'unsign' | 'invalidate',
  entityType: string,
  entityId: string | null,
  before: unknown | null,
  after: unknown | null,
  userId?: string,
  // Optional executor — pass an active transaction handle to make the
  // audit insert commit/rollback atomically with the operation it
  // describes. Without this, a financial change can succeed while the
  // audit row insert fails, leaving an unaudited change.
  executor?: DbOrTx,
): Promise<void> {
  const exec = executor ?? db;
  await exec.insert(auditLogTable).values({
    tenantId,
    action,
    entityType,
    entityId,
    beforeData: before ? JSON.stringify(stripSecretKeys(before)) : null,
    afterData: after ? JSON.stringify(stripSecretKeys(after)) : null,
    userId,
  });
}

/**
 * Writes many audit rows in batched multi-row inserts (500 per statement),
 * with the same secret stripping as auditLog. For bulk writers such as the
 * inventory costing walk (U-157 S13), where one posting can re-cost
 * thousands of documents.
 */
export async function auditLogMany(
  tenantId: string,
  rows: ReadonlyArray<{ action: Parameters<typeof auditLog>[1]; entityType: string; entityId: string | null; before: unknown | null; after: unknown | null }>,
  userId?: string,
  executor?: DbOrTx,
): Promise<void> {
  const exec = executor ?? db;
  for (let i = 0; i < rows.length; i += 500) {
    await exec.insert(auditLogTable).values(rows.slice(i, i + 500).map((r) => ({
      tenantId,
      action: r.action,
      entityType: r.entityType,
      entityId: r.entityId,
      beforeData: r.before ? JSON.stringify(stripSecretKeys(r.before)) : null,
      afterData: r.after ? JSON.stringify(stripSecretKeys(r.after)) : null,
      userId,
    })));
  }
}
