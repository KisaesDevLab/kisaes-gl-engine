// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Tax Estimator Q52 — dashboard summaries (migration 0212_tax_est_dashboard_summaries).
// Firm-scoped (D1) like tax_est_snapshots. Read and written ONLY through
// services/tax-estimator/dashboard-summaries.service.ts.

import { pgTable, uuid, varchar, text, integer, char, timestamp, index, unique } from 'drizzle-orm/pg-core';
import { taxEstTaxpayers } from './tax-estimator-taxpayers.js';
import { taxEstScenarios } from './tax-estimator-years.js';

export const taxEstDashboardSummaries = pgTable('tax_est_dashboard_summaries', {
  id: uuid('id').primaryKey().defaultRandom(),
  firmId: uuid('firm_id').notNull(),
  taxpayerId: uuid('taxpayer_id').notNull().references(() => taxEstTaxpayers.id, { onDelete: 'cascade' }),
  taxYear: integer('tax_year').notNull(),
  scenarioId: uuid('scenario_id').notNull().references(() => taxEstScenarios.id, { onDelete: 'cascade' }),
  /** sha256 of the sorted `tenant_ids` — one row per distinct tenant set. */
  tenantSetKey: char('tenant_set_key', { length: 64 }).notNull(),
  /** Books tenants the estimate read (the tax_est_snapshots.tenant_ids rule). */
  tenantIds: uuid('tenant_ids').array().notNull().default([]),
  inputsHash: char('inputs_hash', { length: 64 }).notNull(),
  engineVersion: varchar('engine_version', { length: 40 }).notNull(),
  computedAt: timestamp('computed_at', { withTimezone: true }).notNull(),
  /** AES-256-GCM JSON (D9): DashboardSummaryPayload. */
  summaryEncrypted: text('summary_encrypted').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('uniq_tax_est_dashboard_summaries').on(t.firmId, t.taxpayerId, t.taxYear, t.tenantSetKey),
  index('idx_tax_est_dashboard_summaries_firm_year').on(t.firmId, t.taxYear, t.taxpayerId),
]);
