// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { pgTable, uuid, timestamp, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { firms } from './firms.js';
import { tenants } from './auth.js';
import { accounts } from './accounts.js';

// Client rules overview — per-client account mappings for global_firm
// rules (migration 0236). A global rule's account targets are ids from the
// client it was written on (`source_account_id`); this row says which of
// `tenant_id`'s own accounts stands in for that source account. Read by
// rule-symbol-resolution.service before its system_tag fallback.
export const tenantFirmAccountMappings = pgTable('tenant_firm_account_mappings', {
  id: uuid('id').primaryKey().defaultRandom(),
  firmId: uuid('firm_id').notNull().references(() => firms.id, { onDelete: 'cascade' }),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  sourceAccountId: uuid('source_account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  createdBy: uuid('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  uniqueMapping: uniqueIndex('idx_tfam_firm_tenant_source').on(table.firmId, table.tenantId, table.sourceAccountId),
  tenantIdx: index('idx_tfam_tenant').on(table.tenantId),
}));
