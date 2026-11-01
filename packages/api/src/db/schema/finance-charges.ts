// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { pgTable, uuid, char, date, timestamp, integer, decimal, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// Finance charges (U-141, migration 0251). A run (the Idempotency-Key
// entity) assesses clients for a month; one live assessment per client and
// month (partial unique index); its sources record the days charged through.

export const financeChargeRuns = pgTable('finance_charge_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id').notNull(),
  assessmentDate: date('assessment_date').notNull(),
  period: char('period', { length: 7 }).notNull(),
  createdBy: uuid('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const financeChargeAssessments = pgTable('finance_charge_assessments', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  runId: uuid('run_id').notNull(),
  companyId: uuid('company_id').notNull(),
  contactId: uuid('contact_id').notNull(),
  period: char('period', { length: 7 }).notNull(),
  assessmentDate: date('assessment_date').notNull(),
  invoiceId: uuid('invoice_id').notNull(),
  voidedAt: timestamp('voided_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  liveIdx: uniqueIndex('uq_fc_assessment_live').on(t.companyId, t.contactId, t.period).where(sql`voided_at IS NULL`),
  invoiceIdx: index('idx_fc_assessment_invoice').on(t.tenantId, t.invoiceId),
  runIdx: index('idx_fc_assessment_run').on(t.runId),
}));

export const financeChargeSources = pgTable('finance_charge_sources', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  assessmentId: uuid('assessment_id').notNull(),
  companyId: uuid('company_id').notNull(),
  invoiceId: uuid('invoice_id').notNull(),
  open: decimal('open', { precision: 19, scale: 4 }).notNull(),
  fromDate: date('from_date').notNull(),
  throughDate: date('through_date').notNull(),
  days: integer('days').notNull(),
  amount: decimal('amount', { precision: 19, scale: 4 }).notNull(),
}, (t) => ({
  invoiceIdx: index('idx_fc_sources_invoice').on(t.companyId, t.invoiceId),
  assessmentIdx: index('idx_fc_sources_assessment').on(t.assessmentId),
}));
