// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { pgTable, uuid, varchar, text, integer, boolean, decimal, date, timestamp, index } from 'drizzle-orm/pg-core';
import { tenants } from './auth.js';

// Accrual schedules (migration 0187, ACCRUALS_V1). A schedule spreads one
// amount across months and posts a journal entry per month when the
// reviewer clicks Post:
//   prepaid           Dr expense               Cr prepaid (balance acct)
//   deferred_revenue  Dr deferred revenue      Cr revenue
//   accrued_expense   Dr expense               Cr accrued liability
//   fixed_asset       Dr depreciation expense  Cr accumulated depreciation
export const accrualSchedules = pgTable('accrual_schedules', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  companyId: uuid('company_id'),
  kind: varchar('kind', { length: 20 }).notNull(),
  description: text('description').notNull(),
  contactId: uuid('contact_id'),
  sourceTransactionId: uuid('source_transaction_id'),
  /** Balance-sheet account the schedule draws down (or builds up). */
  balanceAccountId: uuid('balance_account_id').notNull(),
  /** P&L account recognized each month. */
  recognitionAccountId: uuid('recognition_account_id').notNull(),
  totalAmount: decimal('total_amount', { precision: 19, scale: 4 }).notNull(),
  startDate: date('start_date').notNull(),
  months: integer('months').notNull(),
  method: varchar('method', { length: 20 }).notNull().default('full_month'),
  /** Entries for months before this are posted in this month (catch-up). */
  postFrom: date('post_from').notNull(),
  status: varchar('status', { length: 20 }).notNull().default('active'),
  createdBy: uuid('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  tenantIdx: index('idx_accrual_schedules_tenant').on(t.tenantId, t.companyId, t.status),
}));

export const accrualEntries = pgTable('accrual_entries', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  scheduleId: uuid('schedule_id').notNull().references(() => accrualSchedules.id, { onDelete: 'cascade' }),
  /** The month the amount belongs to. */
  periodStart: date('period_start').notNull(),
  /** The month the entry posts in (later than periodStart for catch-up). */
  postPeriod: date('post_period').notNull(),
  amount: decimal('amount', { precision: 19, scale: 4 }).notNull(),
  isCatchUp: boolean('is_catch_up').notNull().default(false),
  status: varchar('status', { length: 20 }).notNull().default('draft'),
  transactionId: uuid('transaction_id'),
  postedBy: uuid('posted_by'),
  postedAt: timestamp('posted_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  schedIdx: index('idx_accrual_entries_schedule').on(t.scheduleId, t.periodStart),
  postIdx: index('idx_accrual_entries_post').on(t.tenantId, t.postPeriod, t.status),
}));
