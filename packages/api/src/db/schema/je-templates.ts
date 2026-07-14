// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Journal-entry templates (migration 0134) — the JE analog of the
// Daily Sales template builder: a reusable skeleton of lines (label,
// account, debit/credit side, required flag). No entries table:
// "using" a template pre-fills the Journal Entry form and posting
// goes through the normal ledger path.

import { pgTable, uuid, varchar, text, boolean, integer, timestamp, index } from 'drizzle-orm/pg-core';

export const jeTemplates = pgTable('je_templates', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id'),
  name: varchar('name', { length: 255 }).notNull(),
  memo: text('memo'),
  defaultTagId: uuid('default_tag_id'),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  tenantIdx: index('idx_jet_tenant').on(t.tenantId),
}));

export const jeTemplateLines = pgTable('je_template_lines', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  templateId: uuid('template_id').notNull(),
  label: varchar('label', { length: 120 }).notNull(),
  accountId: uuid('account_id'),
  normalSide: varchar('normal_side', { length: 6 }).notNull(), // debit | credit
  sortOrder: integer('sort_order').notNull().default(0),
  isRequired: boolean('is_required').notNull().default(false),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  templateIdx: index('idx_jetl_template').on(t.tenantId, t.templateId),
}));
