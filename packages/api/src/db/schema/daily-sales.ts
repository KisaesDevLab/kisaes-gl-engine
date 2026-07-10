// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Daily Sales (POS X/Z report) templates + entries.
// See Build Plans/DAILY_SALES_POS_PLAN.md. Posting reuses ledger.postTransaction;
// these tables only hold the reusable template definition and the per-day entered
// totals (the posted journal entry remains the source of truth on the ledger).

import { pgTable, uuid, varchar, text, boolean, integer, decimal, timestamp, date, index } from 'drizzle-orm/pg-core';

export const dailySalesTemplates = pgTable('daily_sales_templates', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id'),
  name: varchar('name', { length: 255 }).notNull(),
  presetType: varchar('preset_type', { length: 20 }).notNull().default('custom'), // custom | restaurant | retail
  defaultTagId: uuid('default_tag_id'),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  tenantIdx: index('idx_dst_tenant').on(t.tenantId),
}));

export const dailySalesTemplateLines = pgTable('daily_sales_template_lines', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  templateId: uuid('template_id').notNull(),
  section: varchar('section', { length: 20 }).notNull(), // sales|tax|tips|discount|payment|payout|other
  label: varchar('label', { length: 120 }).notNull(),
  accountId: uuid('account_id'), // null until mapped (preset-seeded revenue/expense lines)
  normalSide: varchar('normal_side', { length: 6 }).notNull(), // debit | credit
  sortOrder: integer('sort_order').notNull().default(0),
  isRequired: boolean('is_required').notNull().default(false),
  allowTag: boolean('allow_tag').notNull().default(false),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  templateIdx: index('idx_dstl_template').on(t.tenantId, t.templateId),
}));

export const dailySalesEntries = pgTable('daily_sales_entries', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id'),
  templateId: uuid('template_id').notNull(),
  businessDate: date('business_date').notNull(),
  status: varchar('status', { length: 10 }).notNull().default('draft'), // draft | posted | void
  transactionId: uuid('transaction_id'), // posted journal entry
  tagId: uuid('tag_id'), // entry-level location/department
  overShortAmount: decimal('over_short_amount', { precision: 19, scale: 4 }).notNull().default('0'),
  totalSales: decimal('total_sales', { precision: 19, scale: 4 }).notNull().default('0'),
  totalTax: decimal('total_tax', { precision: 19, scale: 4 }).notNull().default('0'),
  totalPayments: decimal('total_payments', { precision: 19, scale: 4 }).notNull().default('0'),
  notes: text('notes'),
  postedAt: timestamp('posted_at', { withTimezone: true }),
  createdBy: uuid('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  tenantStatusIdx: index('idx_dse_tenant_status').on(t.tenantId, t.status),
  tenantDateIdx: index('idx_dse_tenant_date').on(t.tenantId, t.businessDate),
}));

export const dailySalesEntryValues = pgTable('daily_sales_entry_values', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  entryId: uuid('entry_id').notNull(),
  templateLineId: uuid('template_line_id').notNull(),
  amount: decimal('amount', { precision: 19, scale: 4 }).notNull().default('0'),
  tagId: uuid('tag_id'),
}, (t) => ({
  entryIdx: index('idx_dsev_entry').on(t.tenantId, t.entryId),
}));
