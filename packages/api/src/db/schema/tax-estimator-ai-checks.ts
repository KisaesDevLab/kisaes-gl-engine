// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// AI parameter check (migration 0205, OPEN-QUESTIONS Q48). GLOBAL like tax_parameters.
import { pgTable, uuid, varchar, text, jsonb, timestamp, integer, boolean, index } from 'drizzle-orm/pg-core';

export const taxParamAiCheckRuns = pgTable('tax_param_ai_check_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  taxYear: integer('tax_year').notNull(),
  scope: varchar('scope', { length: 20 }).notNull(),
  state: varchar('state', { length: 2 }),
  key: varchar('key', { length: 120 }),
  targets: jsonb('targets').notNull().default([]),
  status: varchar('status', { length: 20 }).notNull().default('queued'),
  total: integer('total').notNull().default(0),
  done: integer('done').notNull().default(0),
  counts: jsonb('counts').notNull().default({}),
  cancelRequested: boolean('cancel_requested').notNull().default(false),
  error: text('error'),
  model: varchar('model', { length: 100 }),
  createdBy: uuid('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  startedAt: timestamp('started_at', { withTimezone: true }),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('idx_tax_param_ai_check_runs_year').on(t.taxYear, t.createdAt),
]);

export const taxParamAiChecks = pgTable('tax_param_ai_checks', {
  id: uuid('id').primaryKey().defaultRandom(),
  runId: uuid('run_id').references(() => taxParamAiCheckRuns.id, { onDelete: 'set null' }),
  targetKind: varchar('target_kind', { length: 20 }).notNull(),
  key: varchar('key', { length: 120 }).notNull(),
  jurisdiction: varchar('jurisdiction', { length: 2 }).notNull(),
  taxYear: integer('tax_year').notNull(),
  storedValueSnapshot: jsonb('stored_value_snapshot'),
  verdict: varchar('verdict', { length: 20 }).notNull(),
  foundValue: jsonb('found_value'),
  quote: text('quote'),
  sourceUrl: text('source_url'),
  sourceTitle: text('source_title'),
  sourceDate: text('source_date'),
  sourceTaxYear: integer('source_tax_year'),
  rationale: text('rationale'),
  confidence: varchar('confidence', { length: 10 }),
  model: varchar('model', { length: 100 }),
  usage: jsonb('usage'),
  error: text('error'),
  details: jsonb('details').notNull().default({}),
  createdBy: uuid('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  appliedAt: timestamp('applied_at', { withTimezone: true }),
  appliedBy: uuid('applied_by'),
}, (t) => [
  index('idx_tax_param_ai_checks_row').on(t.taxYear, t.jurisdiction, t.key, t.createdAt),
  index('idx_tax_param_ai_checks_run').on(t.runId),
]);
