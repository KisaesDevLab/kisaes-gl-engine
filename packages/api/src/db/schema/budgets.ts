// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { pgTable, uuid, varchar, text, integer, smallint, decimal, boolean, date, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';

export const budgets = pgTable('budgets', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id'),
  name: varchar('name', { length: 255 }).notNull(),
  fiscalYear: integer('fiscal_year').notNull(),
  isActive: boolean('is_active').default(true),
  // ADR 0XW — tag scope (null = company-wide), description, lifecycle.
  tagId: uuid('tag_id'),
  description: text('description'),
  periodType: varchar('period_type', { length: 20 }).notNull().default('monthly'),
  status: varchar('status', { length: 20 }).notNull().default('active'),
  // fiscal_year_start is authoritative going forward; legacy fiscal_year
  // stays for backward compat with the existing month_N code paths.
  fiscalYearStart: date('fiscal_year_start'),
  createdBy: uuid('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  tenantYearIdx: uniqueIndex('idx_budgets_tenant_year').on(table.tenantId, table.fiscalYear),
  tenantTagIdx: index('idx_budgets_tenant_tag').on(table.tenantId, table.tagId),
  tenantFyStartIdx: index('idx_budgets_tenant_fy_start').on(table.tenantId, table.fiscalYearStart),
}));

export const budgetLines = pgTable('budget_lines', {
  id: uuid('id').primaryKey().defaultRandom(),
  budgetId: uuid('budget_id').notNull(),
  accountId: uuid('account_id').notNull(),
  month1: decimal('month_1', { precision: 19, scale: 4 }).default('0'),
  month2: decimal('month_2', { precision: 19, scale: 4 }).default('0'),
  month3: decimal('month_3', { precision: 19, scale: 4 }).default('0'),
  month4: decimal('month_4', { precision: 19, scale: 4 }).default('0'),
  month5: decimal('month_5', { precision: 19, scale: 4 }).default('0'),
  month6: decimal('month_6', { precision: 19, scale: 4 }).default('0'),
  month7: decimal('month_7', { precision: 19, scale: 4 }).default('0'),
  month8: decimal('month_8', { precision: 19, scale: 4 }).default('0'),
  month9: decimal('month_9', { precision: 19, scale: 4 }).default('0'),
  month10: decimal('month_10', { precision: 19, scale: 4 }).default('0'),
  month11: decimal('month_11', { precision: 19, scale: 4 }).default('0'),
  month12: decimal('month_12', { precision: 19, scale: 4 }).default('0'),
}, (table) => ({
  budgetIdx: index('idx_bl_budget').on(table.budgetId),
  uniqueAcct: uniqueIndex('idx_bl_budget_account').on(table.budgetId, table.accountId),
}));

// ADR 0XW — normalized per-period budget cells. Shadows budget_lines
// during the dual-write window. Becomes authoritative in a later cutover.
export const budgetPeriods = pgTable('budget_periods', {
  id: uuid('id').primaryKey().defaultRandom(),
  budgetId: uuid('budget_id').notNull(),
  accountId: uuid('account_id').notNull(),
  periodIndex: smallint('period_index').notNull(),
  amount: decimal('amount', { precision: 19, scale: 4 }).notNull().default('0'),
  note: text('note'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  budgetAccountIdx: index('idx_budget_periods_budget_account').on(table.budgetId, table.accountId),
  uniqueCell: uniqueIndex('uq_budget_periods_budget_account_period').on(table.budgetId, table.accountId, table.periodIndex),
}));
