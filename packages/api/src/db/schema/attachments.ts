// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { pgTable, uuid, varchar, integer, text, decimal, date, timestamp, index, boolean } from 'drizzle-orm/pg-core';

export const attachments = pgTable('attachments', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id'),
  fileName: varchar('file_name', { length: 255 }).notNull(),
  filePath: varchar('file_path', { length: 500 }).notNull(),
  fileSize: integer('file_size'),
  mimeType: varchar('mime_type', { length: 100 }),
  attachableType: varchar('attachable_type', { length: 50 }).notNull(),
  attachableId: uuid('attachable_id').notNull(),
  ocrStatus: varchar('ocr_status', { length: 20 }),
  ocrVendor: varchar('ocr_vendor', { length: 255 }),
  ocrDate: date('ocr_date'),
  ocrTotal: decimal('ocr_total', { precision: 19, scale: 4 }),
  ocrTax: decimal('ocr_tax', { precision: 19, scale: 4 }),
  // Cloud storage fields
  storageKey: varchar('storage_key', { length: 500 }),
  storageProvider: varchar('storage_provider', { length: 30 }).default('local'),
  providerFileId: varchar('provider_file_id', { length: 500 }),
  localCachePath: varchar('local_cache_path', { length: 500 }),
  cacheExpiresAt: timestamp('cache_expires_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  tenantIdx: index('idx_attach_tenant').on(table.tenantId),
  refIdx: index('idx_attach_ref').on(table.attachableType, table.attachableId),
}));

export const recurringSchedules = pgTable('recurring_schedules', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id'),
  templateTransactionId: uuid('template_transaction_id').notNull(),
  frequency: varchar('frequency', { length: 20 }).notNull(),
  intervalValue: integer('interval_value').default(1),
  mode: varchar('mode', { length: 20 }).default('auto'),
  startDate: date('start_date').notNull(),
  endDate: date('end_date'),
  nextOccurrence: date('next_occurrence').notNull(),
  lastPostedAt: timestamp('last_posted_at', { withTimezone: true }),
  isActive: boolean('is_active').default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
});
