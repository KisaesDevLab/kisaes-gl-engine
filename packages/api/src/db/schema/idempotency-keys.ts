// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { pgTable, uuid, varchar, char, smallint, boolean, jsonb, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { tenants, users } from './auth.js';
import { companies } from './company.js';

/**
 * Idempotency-Key records of the posting and master-data routes (migration
 * 0229, U-18, idempotency-v1). Inserted as 'committed' in the posting's own
 * database transaction, updated to 'done' with the response after the
 * commit; expire after 24 hours. Install-local: excluded from tenant
 * archives (job-bookkeeping in the portability plan).
 */
export const idempotencyKeys = pgTable('idempotency_keys', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  // NULL on tenant-wide routes (contacts, items, tags).
  companyId: uuid('company_id').references(() => companies.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  idempotencyKey: varchar('idempotency_key', { length: 64 }).notNull(),
  // 'POST /transactions/:id/void'
  route: varchar('route', { length: 120 }).notNull(),
  // Hex SHA-256 of the canonical request (utils/request-hash.ts).
  requestSha256: char('request_sha256', { length: 64 }).notNull(),
  state: varchar('state', { length: 16 }).notNull(),
  successStatus: smallint('success_status').notNull(),
  responseStatus: smallint('response_status'),
  responseBody: jsonb('response_body'),
  responseTruncated: boolean('response_truncated').notNull().default(false),
  entityType: varchar('entity_type', { length: 40 }),
  entityId: uuid('entity_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
}, (table) => ({
  keyIdx: uniqueIndex('uq_idempotency_keys_key').on(table.tenantId, table.userId, table.idempotencyKey),
  createdIdx: index('idx_idempotency_keys_created').on(table.createdAt),
}));
