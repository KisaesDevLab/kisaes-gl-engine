// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import {
  pgTable,
  uuid,
  varchar,
  text,
  boolean,
  jsonb,
  date,
  timestamp,
  integer,
  index,
} from 'drizzle-orm/pg-core';
import { tenants } from './auth.js';
import { companies } from './company.js';

// VIBE_MYBOOKS_PRACTICE_BUILD_PLAN Phase 16 + 17 — Report Builder.
// Five tables. KPI library is seed data (16.2) loaded as static
// JSON; we don't materialize stock KPIs into per-tenant rows.

export const reportTemplates = pgTable('report_templates', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 200 }).notNull(),
  description: text('description'),
  // Layout block list — see ADR (TBD) for the block schema.
  layoutJsonb: jsonb('layout_jsonb').notNull().default([]),
  themeJsonb: jsonb('theme_jsonb').notNull().default({}),
  defaultPeriod: varchar('default_period', { length: 20 }).notNull().default('this_month'),
  isPracticeTemplate: boolean('is_practice_template').notNull().default(true),
  createdBy: uuid('created_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  tenantIdx: index('idx_report_templates_tenant').on(table.tenantId),
}));

export const reportInstances = pgTable('report_instances', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  templateId: uuid('template_id').references(() => reportTemplates.id, { onDelete: 'set null' }),
  companyId: uuid('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
  periodStart: date('period_start').notNull(),
  periodEnd: date('period_end').notNull(),
  // draft | review | published | archived
  status: varchar('status', { length: 20 }).notNull().default('draft'),
  // Frozen layout at instance creation — protects published reports
  // from later template edits.
  layoutSnapshotJsonb: jsonb('layout_snapshot_jsonb').notNull().default([]),
  // Computed numbers — KPI values, chart series, table rows. Means
  // the portal can render entirely client-side without recomputing.
  dataSnapshotJsonb: jsonb('data_snapshot_jsonb').notNull().default({}),
  pdfUrl: text('pdf_url'),
  version: integer('version').notNull().default(1),
  createdBy: uuid('created_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  publishedAt: timestamp('published_at', { withTimezone: true }),
}, (table) => ({
  tenantCompanyIdx: index('idx_report_instances_tenant_company').on(table.tenantId, table.companyId),
  statusIdx: index('idx_report_instances_status').on(table.tenantId, table.status),
  publishedIdx: index('idx_report_instances_published').on(table.companyId, table.publishedAt),
}));

export const kpiDefinitions = pgTable('kpi_definitions', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  // Stable lookup key (e.g. 'gross_margin_pct'). Practice-level
  // overrides of stock KPIs share the same key.
  key: varchar('key', { length: 80 }).notNull(),
  name: varchar('name', { length: 200 }).notNull(),
  category: varchar('category', { length: 40 }).notNull(),
  formulaJsonb: jsonb('formula_jsonb').notNull(),
  format: varchar('format', { length: 20 }).notNull(),
  thresholdJsonb: jsonb('threshold_jsonb'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  tenantKeyIdx: index('idx_kpi_definitions_tenant_key').on(table.tenantId, table.key),
}));

export const reportComments = pgTable('report_comments', {
  id: uuid('id').primaryKey().defaultRandom(),
  instanceId: uuid('instance_id').notNull().references(() => reportInstances.id, { onDelete: 'cascade' }),
  blockRef: varchar('block_ref', { length: 80 }),
  authorId: uuid('author_id').notNull(),
  body: text('body').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  instanceIdx: index('idx_report_comments_instance').on(table.instanceId, table.createdAt),
}));

export const reportAiSummaries = pgTable('report_ai_summaries', {
  id: uuid('id').primaryKey().defaultRandom(),
  instanceId: uuid('instance_id').notNull().references(() => reportInstances.id, { onDelete: 'cascade' }),
  blockRef: varchar('block_ref', { length: 80 }),
  promptTemplateId: uuid('prompt_template_id'),
  generatedText: text('generated_text').notNull(),
  editedText: text('edited_text'),
  modelUsed: varchar('model_used', { length: 80 }),
  generatedAt: timestamp('generated_at', { withTimezone: true }).notNull().defaultNow(),
  editedBy: uuid('edited_by'),
  editedAt: timestamp('edited_at', { withTimezone: true }),
}, (table) => ({
  instanceIdx: index('idx_report_ai_summaries_instance').on(table.instanceId),
}));
