// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Tax Estimator tables — entity tax setup (features/tax-estimator/PHASES.md Phase 4,
// MODULE.md D3/D8). SQL lives in migrations/parts/entities.sql and is assembled
// into 0201_tax_estimator.sql by the orchestrator.
//
// Books-scoped: every row carries tenant_id + company_id. These rows are read
// across tenants only through the firm scope (D1); services verify the tenant
// against FirmScope.allowedTenantIds before touching them.

import { pgTable, uuid, varchar, text, boolean, integer, numeric, char, timestamp, index, unique } from 'drizzle-orm/pg-core';

export const taxEstEntitySettings = pgTable('tax_est_entity_settings', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id').notNull(),
  /** Used only when the company has no TB company_tax_profiles row (D3). */
  taxEntityType: varchar('tax_entity_type', { length: 20 }),
  /** Override of companies.accounting_method. */
  taxMethod: varchar('tax_method', { length: 10 }),
  isSstb: boolean('is_sstb').notNull().default(false),
  largeCorporation: boolean('large_corporation').notNull().default(false),
  farmerOverride: boolean('farmer_override'),
  rentalQbiTradeOrBusiness: boolean('rental_qbi_trade_or_business').notNull().default(false),
  stateSourcing: char('state_sourcing', { length: 2 }),
  updatedBy: uuid('updated_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('uniq_tax_est_entity_settings_company').on(t.tenantId, t.companyId),
]);

export const taxEstEntityYearInputs = pgTable('tax_est_entity_year_inputs', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id').notNull(),
  taxYear: integer('tax_year').notNull(),
  w2WagesOverride: numeric('w2_wages_override', { precision: 19, scale: 4 }),
  w2WagesOverrideReason: text('w2_wages_override_reason'),
  ubia: numeric('ubia', { precision: 19, scale: 4 }),
  /** Q41: count the >2% shareholder health add-on (W-2 box 1) as §199A W-2 wages. Default false = excluded (CPA decision). */
  includeSehiInW2Wages: boolean('include_sehi_in_w2_wages').notNull().default(false),
  updatedBy: uuid('updated_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('uniq_tax_est_entity_year_inputs').on(t.tenantId, t.companyId, t.taxYear),
]);

export const taxEstAccountTreatments = pgTable('tax_est_account_treatments', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id').notNull(),
  accountId: uuid('account_id').notNull(),
  /**
   * NULL = flag-only row (non_recurring without a treatment). One of the
   * shared ACCOUNT_TREATMENTS (CHECK in 0201): the D3 list + guaranteed_payment
   * + the character treatments (capital_gain_lt/st, section_1231, interest,
   * dividends_ordinary/qualified).
   */
  treatment: varchar('treatment', { length: 30 }),
  /** Percent 0..100; required for nondeductible_pct only. */
  pct: numeric('pct', { precision: 7, scale: 4 }),
  /** Person target: payments, guaranteed_payment (the partner), owner_sehi / owner_retirement (S corp officer), w2_wages. */
  paymentTaxpayerId: uuid('payment_taxpayer_id'),
  paymentPersonId: uuid('payment_person_id'),
  paymentJurisdiction: varchar('payment_jurisdiction', { length: 10 }),
  nonRecurring: boolean('non_recurring').notNull().default(false),
  updatedBy: uuid('updated_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('uniq_tax_est_account_treatments_account').on(t.tenantId, t.companyId, t.accountId),
  index('idx_tax_est_account_treatments_company').on(t.tenantId, t.companyId, t.treatment),
]);

export const taxEstTransactionFlags = pgTable('tax_est_transaction_flags', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  transactionId: uuid('transaction_id').notNull(),
  nonRecurring: boolean('non_recurring').notNull().default(true),
  updatedBy: uuid('updated_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('uniq_tax_est_transaction_flags').on(t.tenantId, t.transactionId),
]);
