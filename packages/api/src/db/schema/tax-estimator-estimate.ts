// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Tax Estimator Phase 10b tables — estimated-tax payment ledger and Schedule AI
// period snapshots. SQL lives in migrations/parts/estimate.sql (assembled into 0201).
// Both are firm-scoped (D1): firm_id + taxpayer; tenant_id names a books tenant.

import { pgTable, uuid, varchar, text, integer, smallint, jsonb, numeric, char, date, bigint, timestamp, index, unique } from 'drizzle-orm/pg-core';
import { taxEstTaxpayers } from './tax-estimator-taxpayers.js';
import { taxEstScenarios } from './tax-estimator-years.js';

export const taxEstPayments = pgTable('tax_est_payments', {
  id: uuid('id').primaryKey().defaultRandom(),
  firmId: uuid('firm_id').notNull(),
  taxpayerId: uuid('taxpayer_id').notNull().references(() => taxEstTaxpayers.id, { onDelete: 'cascade' }),
  taxYear: integer('tax_year').notNull(),
  scenarioId: uuid('scenario_id').references(() => taxEstScenarios.id, { onDelete: 'cascade' }),
  jurisdiction: varchar('jurisdiction', { length: 8 }).notNull(),
  paymentDate: date('payment_date'),
  amount: numeric('amount', { precision: 19, scale: 4 }).notNull(),
  source: varchar('source', { length: 24 }).notNull(),
  tenantId: uuid('tenant_id'),
  transactionId: uuid('transaction_id'),
  memo: text('memo'),
  createdBy: uuid('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('idx_tax_est_payments_firm_taxpayer_year').on(t.firmId, t.taxpayerId, t.taxYear),
]);

export const taxEstSchAiSnapshots = pgTable('tax_est_sch_ai_snapshots', {
  id: uuid('id').primaryKey().defaultRandom(),
  firmId: uuid('firm_id').notNull(),
  taxpayerId: uuid('taxpayer_id').notNull().references(() => taxEstTaxpayers.id, { onDelete: 'cascade' }),
  taxYear: integer('tax_year').notNull(),
  periodIndex: smallint('period_index').notNull(),
  periodEnd: date('period_end').notNull(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id').notNull(),
  throughMonth: char('through_month', { length: 7 }).notNull(),
  glVersionStamp: bigint('gl_version_stamp', { mode: 'number' }).notNull().default(0),
  figures: jsonb('figures').$type<Record<string, unknown>>().notNull(),
  capturedBy: uuid('captured_by'),
  capturedAt: timestamp('captured_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('uniq_tax_est_sch_ai_snapshots').on(t.taxpayerId, t.taxYear, t.periodIndex, t.tenantId, t.companyId),
  index('idx_tax_est_sch_ai_snapshots_firm').on(t.firmId, t.taxpayerId, t.taxYear),
]);
