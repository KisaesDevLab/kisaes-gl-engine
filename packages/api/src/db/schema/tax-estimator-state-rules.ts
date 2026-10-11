// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Tax Estimator Phase 2: GLOBAL (no tenant_id) state estimate rules. SQL lives in
// migrations/parts/state-rules.sql and is assembled into 0201_tax_estimator.sql by the orchestrator.

import { pgTable, uuid, varchar, text, jsonb, timestamp, integer, char, index, unique } from 'drizzle-orm/pg-core';

// Shipped seed rows, synced from code at startup.
export const stateEstimateRules = pgTable('state_estimate_rules', {
  id: uuid('id').primaryKey().defaultRandom(),
  state: char('state', { length: 2 }).notNull(),
  taxYear: integer('tax_year').notNull(),
  key: varchar('key', { length: 80 }).notNull(),
  value: jsonb('value').notNull(),
  status: varchar('status', { length: 20 }).notNull(),
  citation: text('citation').notNull().default(''),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('uniq_state_estimate_rules_state_year_key').on(t.state, t.taxYear, t.key),
  index('idx_state_estimate_rules_year').on(t.taxYear),
]);

// Super-admin overrides and provisional (created-from-prior) rows.
export const stateEstimateRuleOverrides = pgTable('state_estimate_rule_overrides', {
  id: uuid('id').primaryKey().defaultRandom(),
  state: char('state', { length: 2 }).notNull(),
  taxYear: integer('tax_year').notNull(),
  key: varchar('key', { length: 80 }).notNull(),
  value: jsonb('value').notNull(),
  status: varchar('status', { length: 20 }).notNull(),
  citation: text('citation').notNull().default(''),
  reason: text('reason').notNull(),
  createdFromYear: integer('created_from_year'),
  createdBy: uuid('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('uniq_state_estimate_rule_overrides_state_year_key').on(t.state, t.taxYear, t.key),
  index('idx_state_estimate_rule_overrides_year').on(t.taxYear),
]);
