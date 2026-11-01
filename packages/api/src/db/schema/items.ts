// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { pgTable, uuid, varchar, text, decimal, boolean, integer, timestamp, date, index, uniqueIndex } from 'drizzle-orm/pg-core';

export const items = pgTable('items', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id'),
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  // A discount item without discountPercent: the amount off (U-39a).
  unitPrice: decimal('unit_price', { precision: 19, scale: 4 }),
  // Sales item kind (U-39a, item-kinds-sales-v1, migration 0243).
  itemType: varchar('item_type', { length: 20 }).$type<'service' | 'non_inventory' | 'other_charge' | 'discount' | 'subtotal'>().notNull().default('service'),
  // A discount item's percent off, 0 < p <= 100 (U-39a).
  discountPercent: decimal('discount_percent', { precision: 7, scale: 4 }),
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
  // U-132 (migration 0247): rows are never deleted. A void, unapply or edit
  // sets voidedAt; a bounce (returned_payment) sets reversedByTxnId. A live
  // application has both NULL.
  voidedAt: timestamp('voided_at', { withTimezone: true }),
  reversedByTxnId: uuid('reversed_by_txn_id'),
  // U-133 / U-134 (migration 0248): the write-off and the early-payment
  // discount settled with the cash (each Dr its account, Cr A/R).
  writeOffAmount: decimal('write_off_amount', { precision: 19, scale: 4 }).notNull().default('0'),
  writeOffAccountId: uuid('write_off_account_id'),
  discountAmount: decimal('discount_amount', { precision: 19, scale: 4 }).notNull().default('0'),
  discountAccountId: uuid('discount_account_id'),
  // A credit applied after its payment: when, and inside which payment
  // (NULL for POST /payments/:id/apply). NULL appliedDate = with the payment.
  appliedDate: date('applied_date'),
  appliedInTxnId: uuid('applied_in_txn_id'),
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
