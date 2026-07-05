// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { pgTable, uuid, varchar, integer, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';

// Tenant-defined custom account detail types (migration 0114). Extends
// the built-in DETAIL_TYPES list from @kis-books/shared per tenant.
// `value` is the snake_case slug stored on accounts.detail_type.
export const tenantDetailTypes = pgTable('tenant_detail_types', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  accountType: varchar('account_type', { length: 20 }).notNull(),
  value: varchar('value', { length: 50 }).notNull(),
  label: varchar('label', { length: 100 }).notNull(),
  // Presentation order (migration 0117). NULL = unpositioned; sorts after
  // explicitly ordered rows (ASC NULLS LAST), tie-break by label.
  sortOrder: integer('sort_order'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  tenantTypeValueIdx: uniqueIndex('idx_tenant_detail_types_unique').on(table.tenantId, table.accountType, table.value),
  tenantIdx: index('idx_tenant_detail_types_tenant').on(table.tenantId),
}));
