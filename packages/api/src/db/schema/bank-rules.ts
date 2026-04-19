// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { pgTable, uuid, varchar, text, decimal, boolean, integer, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';

export const bankRules = pgTable('bank_rules', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id'),
  companyId: uuid('company_id'),
  name: varchar('name', { length: 255 }).notNull(),
  priority: integer('priority').default(0),
  isActive: boolean('is_active').default(true),
  isGlobal: boolean('is_global').default(false),
  applyTo: varchar('apply_to', { length: 10 }).default('both').notNull(),
  bankAccountId: uuid('bank_account_id'),
  descriptionContains: varchar('description_contains', { length: 255 }),
  descriptionExact: varchar('description_exact', { length: 255 }),
  amountEquals: decimal('amount_equals', { precision: 19, scale: 4 }),
  amountMin: decimal('amount_min', { precision: 19, scale: 4 }),
  amountMax: decimal('amount_max', { precision: 19, scale: 4 }),
  assignAccountId: uuid('assign_account_id'),
  assignContactId: uuid('assign_contact_id'),
  assignAccountName: varchar('assign_account_name', { length: 255 }),
  assignContactName: varchar('assign_contact_name', { length: 255 }),
  assignMemo: varchar('assign_memo', { length: 500 }),
  // ADR 0XY: tag stamped onto every journal line produced when this
  // rule matches a bank feed categorization.
  assignTagId: uuid('assign_tag_id'),
  autoConfirm: boolean('auto_confirm').default(false),
  timesApplied: integer('times_applied').default(0),
  lastAppliedAt: timestamp('last_applied_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  tenantIdx: index('idx_br_tenant').on(table.tenantId),
  activeIdx: index('idx_br_active').on(table.tenantId, table.isActive),
  assignTagIdx: index('idx_bank_rules_assign_tag_id').on(table.assignTagId),
}));

export const globalRuleSubmissions = pgTable('global_rule_submissions', {
  id: uuid('id').primaryKey().defaultRandom(),
  submittedByUserId: uuid('submitted_by_user_id').notNull(),
  submittedByEmail: varchar('submitted_by_email', { length: 255 }),
  sourceTenantId: uuid('source_tenant_id'),
  sourceRuleId: uuid('source_rule_id'),
  status: varchar('status', { length: 20 }).default('pending').notNull(), // pending, approved, rejected
  name: varchar('name', { length: 255 }).notNull(),
  applyTo: varchar('apply_to', { length: 10 }).default('both').notNull(),
  descriptionContains: varchar('description_contains', { length: 255 }),
  descriptionExact: varchar('description_exact', { length: 255 }),
  amountEquals: decimal('amount_equals', { precision: 19, scale: 4 }),
  amountMin: decimal('amount_min', { precision: 19, scale: 4 }),
  amountMax: decimal('amount_max', { precision: 19, scale: 4 }),
  assignAccountName: varchar('assign_account_name', { length: 255 }),
  assignContactName: varchar('assign_contact_name', { length: 255 }),
  assignMemo: varchar('assign_memo', { length: 500 }),
  autoConfirm: boolean('auto_confirm').default(false),
  note: varchar('note', { length: 500 }),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

export const duplicateDismissals = pgTable('duplicate_dismissals', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id'),
  transactionIdA: uuid('transaction_id_a').notNull(),
  transactionIdB: uuid('transaction_id_b').notNull(),
  dismissedBy: uuid('dismissed_by'),
  dismissedAt: timestamp('dismissed_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  uniquePair: uniqueIndex('idx_dd_pair').on(table.tenantId, table.transactionIdA, table.transactionIdB),
}));
