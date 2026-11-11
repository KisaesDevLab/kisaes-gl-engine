// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

// Saved report definitions (memorized reports) and their groups — U-118,
// capability report-defs-v1, migration 0274. Company-scoped. `kind` is
// 'standard' (a catalog report and its options) or, since migration 0276
// (report-defs-builder-v1), 'builder' (a Report Builder definition). Both
// tables soft-delete and carry a `version` (409 STALE_VERSION when stale).

import { pgTable, uuid, varchar, integer, jsonb, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { tenants } from './auth.js';
import { companies } from './company.js';

export const REPORT_DEFINITION_KINDS = ['standard', 'builder'] as const;
export type ReportDefinitionKind = (typeof REPORT_DEFINITION_KINDS)[number];

export const reportDefinitionGroups = pgTable('report_definition_groups', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  companyId: uuid('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 100 }).notNull(),
  sort: integer('sort').notNull().default(0),
  version: integer('version').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, (table) => ({
  nameUq: uniqueIndex('uq_report_definition_groups_name')
    .on(table.tenantId, table.companyId, sql`lower(${table.name})`).where(sql`${table.deletedAt} IS NULL`),
}));

export const reportDefinitions = pgTable('report_definitions', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  companyId: uuid('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
  groupId: uuid('group_id').references(() => reportDefinitionGroups.id, { onDelete: 'set null' }),
  name: varchar('name', { length: 200 }).notNull(),
  kind: varchar('kind', { length: 20 }).notNull().$type<ReportDefinitionKind>(),
  // standard: {schemaVersion, kind, reportKey, options}, ids only at fixed option paths;
  // builder: schema v1 (@kis-books/shared report-builder), ids only at filter ids and tagGroupId.
  definitionJson: jsonb('definition_json').notNull().$type<Record<string, unknown>>(),
  version: integer('version').notNull().default(1),
  // The author (Q-310). No FK: users are identity rows (tenant archives remap them).
  createdBy: uuid('created_by'),
  updatedBy: uuid('updated_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, (table) => ({
  nameUq: uniqueIndex('uq_report_definitions_name')
    .on(table.tenantId, table.companyId, sql`lower(${table.name})`).where(sql`${table.deletedAt} IS NULL`),
  groupIdx: index('idx_report_definitions_group').on(table.tenantId, table.companyId, table.groupId)
    .where(sql`${table.deletedAt} IS NULL`),
}));
