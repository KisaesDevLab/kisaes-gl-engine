// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { pgTable, uuid, varchar, decimal, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// Billable costs billed on invoices (U-128, billable-costs-v1, migration
// 0245). One row per cost line billed; active while releasedAt is null (one
// active row per source line, uq_bcl_active_source). Soft references (no
// FK): the source line keeps its id across source edits.
export const billableCostLinks = pgTable('billable_cost_links', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id'),
  sourceTransactionId: uuid('source_transaction_id').notNull(),
  sourceLineId: uuid('source_line_id').notNull(),
  invoiceId: uuid('invoice_id').notNull(),
  // round2(source cost), signed.
  costAmount: decimal('cost_amount', { precision: 19, scale: 4 }).notNull(),
  // A percent (10 = 10 %); 0 on a negative cost (Q-P20z).
  markupPercent: decimal('markup_percent', { precision: 9, scale: 4 }).notNull().default('0'),
  markupAmount: decimal('markup_amount', { precision: 19, scale: 4 }).notNull().default('0'),
  // The income account the markup posted to; kept on every edit.
  markupAccountId: uuid('markup_account_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid('created_by'),
  releasedAt: timestamp('released_at', { withTimezone: true }),
  releasedBy: uuid('released_by'),
  // removed | invoice_void | invoice_delete
  releaseReason: varchar('release_reason', { length: 20 }),
}, (table) => ({
  activeSourceIdx: uniqueIndex('uq_bcl_active_source').on(table.tenantId, table.sourceLineId).where(sql`released_at IS NULL`),
  invoiceIdx: index('idx_bcl_invoice').on(table.tenantId, table.invoiceId).where(sql`released_at IS NULL`),
}));
