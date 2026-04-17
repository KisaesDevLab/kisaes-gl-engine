// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { db, type DbOrTx } from '../db/index.js';
import { auditLog as auditLogTable } from '../db/schema/audit-log.js';

export async function auditLog(
  tenantId: string,
  action: 'create' | 'update' | 'delete' | 'void' | 'login',
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
    beforeData: before ? JSON.stringify(before) : null,
    afterData: after ? JSON.stringify(after) : null,
    userId,
  });
}
