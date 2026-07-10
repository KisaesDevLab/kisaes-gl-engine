// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Report Packs — bulk multi-report combined PDF.
//
// Three tables:
//   report_packs       a saved definition: which reports, defaults, chrome
//   report_pack_items  the ordered list of reports in a pack (+ per-item opts)
//   report_pack_runs   one async render attempt → a transient PDF artifact
//
// Company is PINNED on the pack (company_id NOT NULL). The rendered PDF is a
// transient artifact written via the storage provider with an expires_at and
// swept by a TTL job — it is never stored durably.

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

export const reportPacks = pgTable('report_packs', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  companyId: uuid('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 200 }).notNull(),
  description: text('description'),
  // Relative period preset (see @kis-books/shared PeriodPreset). 'custom'
  // uses custom_range_start / custom_range_end.
  periodPreset: varchar('period_preset', { length: 20 }).notNull().default('this-month'),
  customRangeStart: date('custom_range_start'),
  customRangeEnd: date('custom_range_end'),
  // How the as-of date for as-of reports (Balance Sheet, aging) is derived:
  //   'range-end'  use the resolved range end
  //   'custom'     use as_of_custom
  asOfMode: varchar('as_of_mode', { length: 20 }).notNull().default('range-end'),
  asOfCustom: date('as_of_custom'),
  defaultBasis: varchar('default_basis', { length: 10 }).notNull().default('accrual'),
  defaultTagId: uuid('default_tag_id'),
  coverPage: boolean('cover_page').notNull().default(true),
  toc: boolean('toc').notNull().default(true),
  pageNumbers: boolean('page_numbers').notNull().default(true),
  // Optional per-page footer text printed on every page of the generated PDF.
  // Overrides the tenant's default report footer for this pack when set.
  pageFooter: varchar('page_footer', { length: 500 }),
  filenameTemplate: varchar('filename_template', { length: 255 }).notNull().default('{pack}-{date}'),
  // 'skip' → record the failed section and continue (final status 'partial');
  // 'fail' → abort the whole run on the first section error.
  onError: varchar('on_error', { length: 10 }).notNull().default('skip'),
  createdBy: uuid('created_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  // Soft-delete — live runs survive a pack delete.
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, (table) => ({
  tenantCompanyIdx: index('idx_report_packs_tenant_company').on(table.tenantId, table.companyId),
}));

export const reportPackItems = pgTable('report_pack_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  packId: uuid('pack_id').notNull().references(() => reportPacks.id, { onDelete: 'cascade' }),
  sortOrder: integer('sort_order').notNull(),
  // Report slug from REPORT_CATALOG (e.g. 'profit-loss').
  reportId: varchar('report_id', { length: 64 }).notNull(),
  optionsJson: jsonb('options_json').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  packOrderIdx: index('idx_report_pack_items_pack_order').on(table.packId, table.sortOrder),
}));

export const reportPackRuns = pgTable('report_pack_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  packId: uuid('pack_id').notNull().references(() => reportPacks.id, { onDelete: 'cascade' }),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  companyId: uuid('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
  rangeStart: date('range_start'),
  rangeEnd: date('range_end'),
  asOfDate: date('as_of_date'),
  // queued | running | succeeded | partial | failed
  status: varchar('status', { length: 12 }).notNull().default('queued'),
  progress: integer('progress').notNull().default(0),
  currentReportId: varchar('current_report_id', { length: 64 }),
  // Storage key of the transient PDF artifact (null once swept).
  transientKey: text('transient_key'),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  pageCount: integer('page_count'),
  byteSize: integer('byte_size'),
  errorJson: jsonb('error_json'),
  startedAt: timestamp('started_at', { withTimezone: true }),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  tenantPackIdx: index('idx_report_pack_runs_tenant_pack').on(table.tenantId, table.packId),
  expiresIdx: index('idx_report_pack_runs_expires').on(table.expiresAt),
}));
