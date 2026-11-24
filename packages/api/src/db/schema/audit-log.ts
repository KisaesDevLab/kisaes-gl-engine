// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

import { pgTable, uuid, varchar, text, jsonb, timestamp, index, bigserial } from 'drizzle-orm/pg-core';

export const auditLog = pgTable('audit_log', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id'),
  userId: uuid('user_id'),
  action: varchar('action', { length: 20 }).notNull(),
  entityType: varchar('entity_type', { length: 50 }).notNull(),
  entityId: uuid('entity_id'),
  beforeData: jsonb('before_data'),
  afterData: jsonb('after_data'),
  ipAddress: varchar('ip_address', { length: 45 }),
  userAgent: text('user_agent'),
  // U-297 (migration 0291): set only for an agent principal's changes —
  // origin names the connection ('mcp:<agent user id>'), actionId the agent
  // action the change belongs to. NULL for every human change.
  origin: varchar('origin', { length: 80 }),
  actionId: uuid('action_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  tenantIdx: index('idx_audit_tenant').on(table.tenantId),
  entityIdx: index('idx_audit_entity').on(table.tenantId, table.entityType, table.entityId),
  dateIdx: index('idx_audit_date').on(table.tenantId, table.createdAt),
}));
