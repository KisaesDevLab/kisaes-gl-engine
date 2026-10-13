// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Tax Estimator Phase 5 tables — annual settings, scenarios, adjustments, state rows,
// firm settings. SQL lives in migrations/parts/years.sql (assembled into 0201 by the
// orchestrator). Prior-year tax / AGI are tax return information (D9): *_encrypted text.

import {
  pgTable, uuid, varchar, text, boolean, integer, smallint, jsonb, numeric, char, timestamp, index, unique, uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { taxEstTaxpayers, taxEstPersons, taxEstLinks } from './tax-estimator-taxpayers.js';

export const taxEstYears = pgTable('tax_est_years', {
  id: uuid('id').primaryKey().defaultRandom(),
  taxpayerId: uuid('taxpayer_id').notNull().references(() => taxEstTaxpayers.id, { onDelete: 'cascade' }),
  taxYear: integer('tax_year').notNull(),
  priorYearTaxEncrypted: text('prior_year_tax_encrypted'),
  priorYearAgiEncrypted: text('prior_year_agi_encrypted'),
  priorYearTwelveMonths: boolean('prior_year_twelve_months').notNull().default(true),
  priorYearFiled: boolean('prior_year_filed').notNull().default(true),
  safeHarborRule: varchar('safe_harbor_rule', { length: 20 }),
  rateMode: varchar('rate_mode', { length: 10 }).notNull().default('brackets'),
  effectiveRateOverride: numeric('effective_rate_override', { precision: 7, scale: 6 }),
  deductionMode: varchar('deduction_mode', { length: 10 }).notNull().default('auto'),
  itemized: jsonb('itemized').$type<Record<string, number>>().notNull().default({}),
  sch1a: jsonb('sch1a').$type<Record<string, Record<string, number>>>().notNull().default({}),
  creditsNonrefundable: numeric('credits_nonrefundable', { precision: 19, scale: 4 }).notNull().default('0'),
  creditsRefundable: numeric('credits_refundable', { precision: 19, scale: 4 }).notNull().default('0'),
  /** Q44 (migration 0204): child and dependent care expenses paid (Form 2441). */
  careExpenses: numeric('care_expenses', { precision: 19, scale: 4 }).notNull().default('0'),
  hsaCoverage: jsonb('hsa_coverage').$type<Record<string, string>>().notNull().default({}),
  withholding: jsonb('withholding').$type<{ federal?: number; states?: Record<string, number> }>().notNull().default({}),
  // Phase 10b (migrations/parts/estimate.sql): per-person year inputs keyed by role,
  // §469(i)(5) MFS flag, Form 8960 allocable deductions, farmer gross-income figures.
  personInputs: jsonb('person_inputs').$type<Record<string, Record<string, number | string | null>>>().notNull().default({}),
  mfsLivedApartAllYear: boolean('mfs_lived_apart_all_year').notNull().default(false),
  niiAllocableDeductions: numeric('nii_allocable_deductions', { precision: 19, scale: 4 }),
  farmerGross: jsonb('farmer_gross').$type<Record<string, Record<string, Record<string, number>>>>().notNull().default({}),
  isFisherman: boolean('is_fisherman').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('uniq_tax_est_years_taxpayer_year').on(t.taxpayerId, t.taxYear),
]);

export const taxEstScenarios = pgTable('tax_est_scenarios', {
  id: uuid('id').primaryKey().defaultRandom(),
  taxpayerId: uuid('taxpayer_id').notNull().references(() => taxEstTaxpayers.id, { onDelete: 'cascade' }),
  taxYear: integer('tax_year').notNull(),
  name: varchar('name', { length: 120 }).notNull(),
  isBase: boolean('is_base').notNull().default(false),
  /** Q51 (migration 0211): shared in the client portal. Base is always shown; this is for what-ifs. */
  showInPortal: boolean('show_in_portal').notNull().default(false),
  sortOrder: integer('sort_order').notNull().default(0),
  sourceScenarioId: uuid('source_scenario_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('idx_tax_est_scenarios_taxpayer_year').on(t.taxpayerId, t.taxYear),
  uniqueIndex('uniq_tax_est_scenarios_one_base').on(t.taxpayerId, t.taxYear).where(sql`${t.isBase}`),
]);

export const taxEstAdjustmentTypes = pgTable('tax_est_adjustment_types', {
  id: uuid('id').primaryKey().defaultRandom(),
  firmId: uuid('firm_id'),
  code: varchar('code', { length: 40 }),
  name: varchar('name', { length: 120 }).notNull(),
  kind: varchar('kind', { length: 10 }).notNull(),
  affectsSe: boolean('affects_se').notNull().default(false),
  affectsQbi: boolean('affects_qbi').notNull().default(false),
  isCapitalGainLt: boolean('is_capital_gain_lt').notNull().default(false),
  isCapitalGainSt: boolean('is_capital_gain_st').notNull().default(false),
  isQualifiedDividend: boolean('is_qualified_dividend').notNull().default(false),
  isReitDividend: boolean('is_reit_dividend').notNull().default(false),
  isPtp: boolean('is_ptp').notNull().default(false),
  is1231: boolean('is_1231').notNull().default(false),
  isAboveTheLine: boolean('is_above_the_line').notNull().default(false),
  nonRecurring: boolean('non_recurring').notNull().default(false),
  defaultPct: numeric('default_pct', { precision: 7, scale: 4 }),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('idx_tax_est_adjustment_types_firm').on(t.firmId),
]);

export const taxEstAdjustments = pgTable('tax_est_adjustments', {
  id: uuid('id').primaryKey().defaultRandom(),
  scenarioId: uuid('scenario_id').notNull().references(() => taxEstScenarios.id, { onDelete: 'cascade' }),
  adjustmentTypeId: uuid('adjustment_type_id').notNull().references(() => taxEstAdjustmentTypes.id, { onDelete: 'restrict' }),
  personId: uuid('person_id').references(() => taxEstPersons.id, { onDelete: 'set null' }),
  linkId: uuid('link_id').references(() => taxEstLinks.id, { onDelete: 'set null' }),
  label: varchar('label', { length: 200 }).notNull().default(''),
  amount: numeric('amount', { precision: 19, scale: 4 }),
  pct: numeric('pct', { precision: 7, scale: 4 }),
  cadence: varchar('cadence', { length: 10 }).notNull(),
  startMonth: smallint('start_month').notNull().default(1),
  endMonth: smallint('end_month').notNull().default(12),
  glLinked: boolean('gl_linked').notNull().default(false),
  tenantId: uuid('tenant_id'),
  companyId: uuid('company_id'),
  accountId: uuid('account_id'),
  nonRecurring: boolean('non_recurring').notNull().default(false),
  memo: text('memo'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('idx_tax_est_adjustments_scenario').on(t.scenarioId),
]);

export const taxEstStateRows = pgTable('tax_est_state_rows', {
  id: uuid('id').primaryKey().defaultRandom(),
  scenarioId: uuid('scenario_id').notNull().references(() => taxEstScenarios.id, { onDelete: 'cascade' }),
  residency: varchar('residency', { length: 12 }).notNull(),
  state: char('state', { length: 2 }).notNull(),
  effectiveRate: numeric('effective_rate', { precision: 7, scale: 6 }).notNull(),
  base: varchar('base', { length: 16 }).notNull().default('federal_agi'),
  customBase: numeric('custom_base', { precision: 19, scale: 4 }),
  sourcedIncome: numeric('sourced_income', { precision: 19, scale: 4 }),
  sourcedManual: boolean('sourced_manual').notNull().default(false),
  creditOverride: numeric('credit_override', { precision: 19, scale: 4 }),
  memo: text('memo'),
  // Phase 10b gate inputs (D12b) and prior-year state figures (D9, *_encrypted).
  withholding: numeric('withholding', { precision: 19, scale: 4 }),
  otherCredits: numeric('other_credits', { precision: 19, scale: 4 }),
  grossIncome: numeric('gross_income', { precision: 19, scale: 4 }),
  priorYearGrossIncome: numeric('prior_year_gross_income', { precision: 19, scale: 4 }),
  nonWithheldIncome: numeric('non_withheld_income', { precision: 19, scale: 4 }),
  exemptions: numeric('exemptions', { precision: 19, scale: 4 }),
  stateDeductions: numeric('state_deductions', { precision: 19, scale: 4 }),
  priorYearTaxEncrypted: text('prior_year_tax_encrypted'),
  priorYearAgiEncrypted: text('prior_year_agi_encrypted'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('uniq_tax_est_state_rows_state').on(t.scenarioId, t.state),
  uniqueIndex('uniq_tax_est_state_rows_one_resident').on(t.scenarioId).where(sql`${t.residency} = 'resident'`),
]);

export const taxEstFirmSettings = pgTable('tax_est_firm_settings', {
  firmId: uuid('firm_id').primaryKey(),
  safeHarborDefault: varchar('safe_harbor_default', { length: 20 }).notNull().default('lesser_of'),
  disclaimerText: text('disclaimer_text'),
  portalShows: varchar('portal_shows', { length: 10 }).notNull().default('live'),
  /** D17 (migration 0202): default ON — non-admins see taxpayers only through a reachable linked tenant. */
  restrictTaxpayersToLinkedTenants: boolean('restrict_taxpayers_to_linked_tenants').notNull().default(true),
  updatedBy: uuid('updated_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
