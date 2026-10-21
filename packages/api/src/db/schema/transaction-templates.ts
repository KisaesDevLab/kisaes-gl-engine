// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Memorized transactions that post nothing (ClientLedger U-62,
// templates-v1) and the occurrence log of the recurring runner (U-63,
// recurring-run-due-v1). Migration 0225. A template is a draft in its own
// tables, so no ledger query can see it; posting goes through the kind's
// create service (services/templates/replay.ts).

import { pgTable, uuid, varchar, integer, text, decimal, date, timestamp, index, boolean, uniqueIndex } from 'drizzle-orm/pg-core';

export const TEMPLATE_KINDS = ['check', 'expense', 'deposit', 'transfer', 'journal_entry', 'daily_sales', 'legacy'] as const;
export type TemplateKind = (typeof TEMPLATE_KINDS)[number];

export const OCCURRENCE_STATUSES = ['posted', 'skipped', 'dismissed', 'entered', 'claiming'] as const;
export type OccurrenceStatus = (typeof OCCURRENCE_STATUSES)[number];

export const templateGroups = pgTable('template_groups', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id'),
  name: varchar('name', { length: 100 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
});

export const templateTransactions = pgTable('template_transactions', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id'),
  name: varchar('name', { length: 255 }).notNull(),
  groupId: uuid('group_id').references(() => templateGroups.id, { onDelete: 'set null' }),
  kind: varchar('kind', { length: 20 }).notNull().$type<TemplateKind>(),
  // Opaque hint for the desktop form (card_charge, card_credit...), returned as stored.
  clientForm: varchar('client_form', { length: 30 }),
  // Bank / pay-from / deposit-to / transfer-from account.
  accountId: uuid('account_id'),
  // Transfer-to account.
  toAccountId: uuid('to_account_id'),
  // Payee / received-from (header).
  contactId: uuid('contact_id'),
  // Check amount, transfer amount. NULL for kinds whose total is derived.
  amount: decimal('amount', { precision: 19, scale: 4 }),
  memo: text('memo'),
  payeeNameOnCheck: varchar('payee_name_on_check', { length: 255 }),
  payeeAddress: text('payee_address'),
  printedMemo: varchar('printed_memo', { length: 255 }),
  printLater: boolean('print_later'),
  basis: varchar('basis', { length: 10 }),
  isAdjusting: boolean('is_adjusting'),
  cashBackAccountId: uuid('cash_back_account_id'),
  cashBackAmount: decimal('cash_back_amount', { precision: 19, scale: 4 }),
  cashBackMemo: text('cash_back_memo'),
  dailySalesTemplateId: uuid('daily_sales_template_id'),
  // The posted transaction the template was made from (from-transaction,
  // schedules that existed before 0225).
  sourceTransactionId: uuid('source_transaction_id'),
  version: integer('version').notNull().default(1),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  createdBy: uuid('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  scopeIdx: index('idx_template_transactions_scope').on(table.tenantId, table.companyId),
}));

export const templateTransactionLines = pgTable('template_transaction_lines', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id'),
  templateId: uuid('template_id').notNull().references(() => templateTransactions.id, { onDelete: 'cascade' }),
  lineOrder: integer('line_order').notNull(),
  accountId: uuid('account_id'),
  // Signed line amount (check, expense, deposit; a negative deposit line is a fee).
  amount: decimal('amount', { precision: 19, scale: 4 }),
  // Journal entry sides.
  debit: decimal('debit', { precision: 19, scale: 4 }).notNull().default('0'),
  credit: decimal('credit', { precision: 19, scale: 4 }).notNull().default('0'),
  description: text('description'),
  contactId: uuid('contact_id'),
  tagId: uuid('tag_id'),
  isBillable: boolean('is_billable').notNull().default(false),
  dailySalesLineId: uuid('daily_sales_line_id'),
}, (table) => ({
  templateIdx: index('idx_template_transaction_lines_template').on(table.tenantId, table.templateId, table.lineOrder),
}));

export const templateTransactionTags = pgTable('template_transaction_tags', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  templateId: uuid('template_id').notNull().references(() => templateTransactions.id, { onDelete: 'cascade' }),
  tagId: uuid('tag_id').notNull(),
}, (table) => ({
  uniq: uniqueIndex('uq_template_transaction_tags').on(table.templateId, table.tagId),
  tenantIdx: index('idx_template_transaction_tags_tenant').on(table.tenantId, table.templateId),
}));

export const templateOccurrences = pgTable('template_occurrences', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id'),
  templateId: uuid('template_id').notNull().references(() => templateTransactions.id, { onDelete: 'cascade' }),
  scheduleId: uuid('schedule_id'),
  occurrenceDate: date('occurrence_date').notNull(),
  status: varchar('status', { length: 12 }).notNull().$type<OccurrenceStatus>(),
  reason: varchar('reason', { length: 40 }),
  transactionId: uuid('transaction_id'),
  runId: uuid('run_id'),
  createdBy: uuid('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
}, (table) => ({
  uniq: uniqueIndex('uq_template_occurrences_date').on(table.templateId, table.occurrenceDate),
}));
