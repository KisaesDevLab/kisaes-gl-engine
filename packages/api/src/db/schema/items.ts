// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { pgTable, uuid, varchar, text, decimal, boolean, integer, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';

export const items = pgTable('items', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id'),
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  unitPrice: decimal('unit_price', { precision: 19, scale: 4 }),
  incomeAccountId: uuid('income_account_id').notNull(),
  isTaxable: boolean('is_taxable').default(true),
  isActive: boolean('is_active').default(true),
  // ADR 0XY: default tag applied to new journal lines that reference this item.
  defaultTagId: uuid('default_tag_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  tenantIdx: index('idx_items_tenant').on(table.tenantId),
  activeIdx: index('idx_items_active').on(table.tenantId, table.isActive),
  nameIdx: uniqueIndex('idx_items_tenant_name').on(table.tenantId, table.name),
  defaultTagIdx: index('idx_items_default_tag_id').on(table.defaultTagId),
}));

export const paymentApplications = pgTable('payment_applications', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id'),
  paymentId: uuid('payment_id').notNull(),
  invoiceId: uuid('invoice_id').notNull(),
  amount: decimal('amount', { precision: 19, scale: 4 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  paymentIdx: index('idx_pa_payment').on(table.paymentId),
  invoiceIdx: index('idx_pa_invoice').on(table.invoiceId),
}));

export const depositLines = pgTable('deposit_lines', {
  id: uuid('id').primaryKey().defaultRandom(),
  depositId: uuid('deposit_id').notNull(),
  sourceTransactionId: uuid('source_transaction_id').notNull(),
  amount: decimal('amount', { precision: 19, scale: 4 }).notNull(),
  sortOrder: integer('sort_order').default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  depositIdx: index('idx_dl_deposit').on(table.depositId),
  sourceIdx: index('idx_dl_source').on(table.sourceTransactionId),
}));
