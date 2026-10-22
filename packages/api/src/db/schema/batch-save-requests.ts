// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { pgTable, uuid, varchar, integer, jsonb, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { tenants } from './auth.js';
import { companies } from './company.js';

/**
 * Idempotency-Key records for POST /batch/save (migration 0226, U-72):
 * written in the batch's own database transaction, so only a saved batch
 * leaves a row. Install-local: excluded from tenant archives
 * (job-bookkeeping in the portability plan).
 */
export const batchSaveRequests = pgTable('batch_save_requests', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  companyId: uuid('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
  idempotencyKey: varchar('idempotency_key', { length: 255 }).notNull(),
  // SHA-256 (hex) of the validated request body.
  requestSha256: varchar('request_sha256', { length: 64 }).notNull(),
  batchId: uuid('batch_id').notNull(),
  responseStatus: integer('response_status').notNull(),
  responseBody: jsonb('response_body').notNull(),
  userId: uuid('user_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  keyIdx: uniqueIndex('uq_batch_save_requests_key').on(table.tenantId, table.companyId, table.idempotencyKey),
  createdIdx: index('idx_batch_save_requests_created').on(table.tenantId, table.createdAt),
}));
