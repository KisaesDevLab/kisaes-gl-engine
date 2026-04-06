import { db } from '../db/index.js';
import { auditLog as auditLogTable } from '../db/schema/audit-log.js';

export async function auditLog(
  tenantId: string,
  action: 'create' | 'update' | 'delete' | 'void' | 'login',
  entityType: string,
  entityId: string | null,
  before: unknown | null,
  after: unknown | null,
  userId?: string,
): Promise<void> {
  await db.insert(auditLogTable).values({
    tenantId,
    action,
    entityType,
    entityId,
    beforeData: before ? JSON.stringify(before) : null,
    afterData: after ? JSON.stringify(after) : null,
    userId,
  });
}
