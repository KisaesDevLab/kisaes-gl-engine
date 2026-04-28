// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import {
  pgTable,
  uuid,
  varchar,
  text,
  boolean,
  integer,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { tenants } from './auth.js';

// VIBE_MYBOOKS_PRACTICE_BUILD_PLAN Phase 6 — Review Checks engine.
// Six tables: a registry of available checks (seeded), per-run
// metadata, the findings the bookkeeper triages, per-finding
// state-transition history, suppressions, and per-(tenant,
// company) parameter overrides.

export const checkRegistry = pgTable('check_registry', {
  checkKey: varchar('check_key', { length: 80 }).primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  handlerName: varchar('handler_name', { length: 80 }).notNull(),
  defaultSeverity: varchar('default_severity', { length: 10 }).notNull(),
  defaultParams: jsonb('default_params').notNull().default({}),
  category: varchar('category', { length: 20 }).notNull(),
  enabled: boolean('enabled').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const checkRuns = pgTable('check_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  companyId: uuid('company_id'),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  checksExecuted: integer('checks_executed').notNull().default(0),
  findingsCreated: integer('findings_created').notNull().default(0),
  truncated: boolean('truncated').notNull().default(false),
  error: text('error'),
}, (table) => ({
  tenantIdx: index('idx_check_runs_tenant').on(table.tenantId, table.startedAt),
}));

export const findings = pgTable('findings', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  companyId: uuid('company_id'),
  checkKey: varchar('check_key', { length: 80 }).notNull().references(() => checkRegistry.checkKey),
  transactionId: uuid('transaction_id'),
  vendorId: uuid('vendor_id'),
  severity: varchar('severity', { length: 10 }).notNull(),
  status: varchar('status', { length: 20 }).notNull().default('open'),
  assignedTo: uuid('assigned_to'),
  payload: jsonb('payload'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  resolutionNote: text('resolution_note'),
}, (table) => ({
  tenantStatusIdx: index('idx_findings_tenant_status').on(table.tenantId, table.status),
  tenantCheckIdx: index('idx_findings_tenant_check').on(table.tenantId, table.checkKey),
  tenantCompanyIdx: index('idx_findings_tenant_company').on(table.tenantId, table.companyId),
}));

export const findingEvents = pgTable('finding_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  findingId: uuid('finding_id').notNull().references(() => findings.id, { onDelete: 'cascade' }),
  fromStatus: varchar('from_status', { length: 20 }),
  toStatus: varchar('to_status', { length: 20 }).notNull(),
  userId: uuid('user_id'),
  note: text('note'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  findingIdx: index('idx_finding_events_finding').on(table.findingId, table.createdAt),
}));

export const checkSuppressions = pgTable('check_suppressions', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  companyId: uuid('company_id'),
  checkKey: varchar('check_key', { length: 80 }).notNull().references(() => checkRegistry.checkKey),
  matchPattern: jsonb('match_pattern').notNull(),
  reason: text('reason'),
  createdBy: uuid('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
}, (table) => ({
  tenantCheckIdx: index('idx_suppressions_tenant_check').on(table.tenantId, table.checkKey),
}));

export const checkParamsOverrides = pgTable('check_params_overrides', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  companyId: uuid('company_id'),
  checkKey: varchar('check_key', { length: 80 }).notNull().references(() => checkRegistry.checkKey),
  params: jsonb('params').notNull(),
}, (table) => ({
  // (tenant, company, check) is the resolution key. Drizzle's
  // unique with nullable companyId means one tenant-wide row +
  // one row per company.
  uniqIdx: uniqueIndex('uniq_check_params_overrides').on(table.tenantId, table.companyId, table.checkKey),
}));
