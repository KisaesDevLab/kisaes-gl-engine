// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Tax Estimator tables (features/tax-estimator/MODULE.md). Phases 1-12 add
// tables here and to migration 0201_tax_estimator.sql (one consolidated,
// additive migration; renumbered to the next free idx at merge, D6).

import { pgTable, uuid, varchar, text, jsonb, timestamp, integer, index, unique } from 'drizzle-orm/pg-core';

// Phase 1: GLOBAL (no tenant_id) shipped parameter rows, synced from code.
export const taxParameters = pgTable('tax_parameters', {
  id: uuid('id').primaryKey().defaultRandom(),
  taxYear: integer('tax_year').notNull(),
  key: varchar('key', { length: 120 }).notNull(),
  value: jsonb('value').notNull(),
  status: varchar('status', { length: 20 }).notNull(),
  citation: text('citation').notNull().default(''),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  // R7 in-app Verify: who verified the CURRENT value, when, and why (null = not verified in-app).
  verifiedBy: uuid('verified_by'),
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
  verificationNote: text('verification_note'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('uniq_tax_parameters_year_key').on(t.taxYear, t.key),
  index('idx_tax_parameters_year').on(t.taxYear),
]);

// Phase 1: GLOBAL super-admin overrides and provisional (created-from-prior) rows.
export const taxParameterOverrides = pgTable('tax_parameter_overrides', {
  id: uuid('id').primaryKey().defaultRandom(),
  taxYear: integer('tax_year').notNull(),
  key: varchar('key', { length: 120 }).notNull(),
  value: jsonb('value').notNull(),
  status: varchar('status', { length: 20 }).notNull(),
  reason: text('reason').notNull(),
  /** R6-06: a created year carries the prior year's citation ("Carried from Y: …") until the seed ships. */
  citation: text('citation').notNull().default(''),
  createdFromYear: integer('created_from_year'),
  createdBy: uuid('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  // R7 in-app Verify: who verified the CURRENT value, when, and why (null = not verified in-app).
  verifiedBy: uuid('verified_by'),
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
  verificationNote: text('verification_note'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('uniq_tax_parameter_overrides_year_key').on(t.taxYear, t.key),
  index('idx_tax_parameter_overrides_year').on(t.taxYear),
]);
