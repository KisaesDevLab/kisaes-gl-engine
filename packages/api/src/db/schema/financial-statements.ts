// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Report-ready financial statements (migration 0189, FINANCIAL_STATEMENTS_V1).
// Library tables are firm-owned (exactly one of firm_id / tenant_id, like
// firm_tax_codes); layouts, reports and finalized versions are per company.

import { pgTable, uuid, varchar, text, boolean, date, timestamp, integer, bigint, jsonb, index, uniqueIndex, check, unique } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

const ZERO = sql`'00000000-0000-0000-0000-000000000000'::uuid`;

export const fsFirmProfiles = pgTable('fs_firm_profiles', {
  id: uuid('id').primaryKey().defaultRandom(),
  firmId: uuid('firm_id'),
  tenantId: uuid('tenant_id'),
  displayName: varchar('display_name', { length: 200 }),
  addressLine1: varchar('address_line1', { length: 200 }),
  addressLine2: varchar('address_line2', { length: 200 }),
  city: varchar('city', { length: 100 }),
  state: varchar('state', { length: 50 }),
  postalCode: varchar('postal_code', { length: 20 }),
  phone: varchar('phone', { length: 50 }),
  email: varchar('email', { length: 200 }),
  website: varchar('website', { length: 200 }),
  logoDataUri: text('logo_data_uri'),
  accountantSignature: varchar('accountant_signature', { length: 300 }),
  letterheadAlign: varchar('letterhead_align', { length: 10 }).notNull().default('left'),
  // Migration 0191: 'both' | 'logo' | 'text'; 'small' | 'medium' | 'content_width' | 'full_bleed'.
  letterheadContent: varchar('letterhead_content', { length: 10 }).notNull().default('both'),
  logoSize: varchar('logo_size', { length: 15 }).notNull().default('small'),
  updatedBy: uuid('updated_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check('chk_fs_firm_profiles_one_owner', sql`num_nonnulls(${t.firmId}, ${t.tenantId}) = 1`),
  uniqueIndex('uniq_fs_firm_profiles_owner').on(sql`COALESCE(${t.firmId}, ${ZERO})`, sql`COALESCE(${t.tenantId}, ${ZERO})`),
]);

export const fsReportLetters = pgTable('fs_report_letters', {
  id: uuid('id').primaryKey().defaultRandom(),
  firmId: uuid('firm_id'),
  tenantId: uuid('tenant_id'),
  name: varchar('name', { length: 200 }).notNull(),
  letterType: varchar('letter_type', { length: 30 }).notNull(),
  title: varchar('title', { length: 200 }),
  bodyHtml: text('body_html').notNull(),
  isActive: boolean('is_active').notNull().default(true),
  isDefault: boolean('is_default').notNull().default(false),
  sourceReportLetterId: uuid('source_report_letter_id'),
  sortOrder: integer('sort_order').notNull().default(0),
  createdBy: uuid('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check('chk_fs_report_letters_one_owner', sql`num_nonnulls(${t.firmId}, ${t.tenantId}) = 1`),
  index('idx_fs_report_letters_owner').on(t.firmId, t.tenantId),
]);

export const fsStylePresets = pgTable('fs_style_presets', {
  id: uuid('id').primaryKey().defaultRandom(),
  firmId: uuid('firm_id'),
  tenantId: uuid('tenant_id'),
  name: varchar('name', { length: 200 }).notNull(),
  styleJson: jsonb('style_json').notNull(),
  builtinKey: varchar('builtin_key', { length: 40 }),
  isDefault: boolean('is_default').notNull().default(false),
  sortOrder: integer('sort_order').notNull().default(0),
  createdBy: uuid('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check('chk_fs_style_presets_one_owner', sql`num_nonnulls(${t.firmId}, ${t.tenantId}) = 1`),
  index('idx_fs_style_presets_owner').on(t.firmId, t.tenantId),
]);

export const fsLayoutTemplates = pgTable('fs_layout_templates', {
  id: uuid('id').primaryKey().defaultRandom(),
  firmId: uuid('firm_id'),
  tenantId: uuid('tenant_id'),
  name: varchar('name', { length: 200 }).notNull(),
  description: text('description'),
  entityKind: varchar('entity_kind', { length: 20 }).notNull().default('any'),
  layoutJson: jsonb('layout_json').notNull(),
  builtinKey: varchar('builtin_key', { length: 40 }),
  isDefault: boolean('is_default').notNull().default(false),
  sortOrder: integer('sort_order').notNull().default(0),
  createdBy: uuid('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check('chk_fs_layout_templates_one_owner', sql`num_nonnulls(${t.firmId}, ${t.tenantId}) = 1`),
  index('idx_fs_layout_templates_owner').on(t.firmId, t.tenantId),
]);

export const fsCompanyLayouts = pgTable('fs_company_layouts', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id').notNull(),
  name: varchar('name', { length: 200 }).notNull(),
  layoutJson: jsonb('layout_json').notNull(),
  styleJson: jsonb('style_json').notNull(),
  sourceTemplateId: uuid('source_template_id'),
  sourceStylePresetId: uuid('source_style_preset_id'),
  createdBy: uuid('created_by'),
  updatedBy: uuid('updated_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
}, (t) => [
  index('idx_fs_company_layouts_company').on(t.tenantId, t.companyId),
]);

export const fsReports = pgTable('fs_reports', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id').notNull(),
  companyLayoutId: uuid('company_layout_id').notNull().references(() => fsCompanyLayouts.id),
  name: varchar('name', { length: 200 }).notNull(),
  periodEnd: date('period_end').notNull(),
  // Migration 0190: NULL = fiscal-year-to-date (reports created earlier).
  periodType: varchar('period_type', { length: 10 }),
  periodStart: date('period_start'),
  framework: varchar('framework', { length: 10 }).notNull(),
  bookBasis: varchar('book_basis', { length: 10 }).notNull(),
  columnsJson: jsonb('columns_json').notNull(),
  tagId: uuid('tag_id'),
  frontMatterJson: jsonb('front_matter_json').notNull(),
  status: varchar('status', { length: 10 }).notNull().default('draft'),
  currentVersionId: uuid('current_version_id'),
  createdBy: uuid('created_by'),
  updatedBy: uuid('updated_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
}, (t) => [
  index('idx_fs_reports_company').on(t.tenantId, t.companyId, t.periodEnd),
]);

export const fsReportVersions = pgTable('fs_report_versions', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id').notNull(),
  reportId: uuid('report_id').notNull().references(() => fsReports.id, { onDelete: 'restrict' }),
  versionNo: integer('version_no').notNull(),
  status: varchar('status', { length: 12 }).notNull().default('final'),
  periodEnd: date('period_end').notNull(),
  framework: varchar('framework', { length: 10 }).notNull(),
  bookBasis: varchar('book_basis', { length: 10 }).notNull(),
  glVersionStamp: bigint('gl_version_stamp', { mode: 'number' }).notNull(),
  modelJson: jsonb('model_json').notNull(),
  layoutJson: jsonb('layout_json').notNull(),
  styleJson: jsonb('style_json').notNull(),
  settingsJson: jsonb('settings_json').notNull(),
  frontMatterJson: jsonb('front_matter_json').notNull(),
  letterJson: jsonb('letter_json'),
  letterheadJson: jsonb('letterhead_json'),
  numbersHash: varchar('numbers_hash', { length: 64 }).notNull(),
  pdfStorageKey: text('pdf_storage_key').notNull(),
  pdfSha256: varchar('pdf_sha256', { length: 64 }).notNull(),
  pdfBytes: integer('pdf_bytes').notNull(),
  pageCount: integer('page_count').notNull(),
  validationOverride: boolean('validation_override').notNull().default(false),
  overrideReason: text('override_reason'),
  finalizedBy: uuid('finalized_by'),
  finalizedAt: timestamp('finalized_at', { withTimezone: true }).notNull().defaultNow(),
  supersededAt: timestamp('superseded_at', { withTimezone: true }),
  reopenedBy: uuid('reopened_by'),
  reopenedAt: timestamp('reopened_at', { withTimezone: true }),
  publishedInstanceId: uuid('published_instance_id'),
  publishedBy: uuid('published_by'),
  publishedAt: timestamp('published_at', { withTimezone: true }),
}, (t) => [
  unique('uniq_fs_report_versions_no').on(t.reportId, t.versionNo),
  index('idx_fs_report_versions_report').on(t.reportId),
]);

export const fsCashFlowOverrides = pgTable('fs_cash_flow_overrides', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id').notNull(),
  accountId: uuid('account_id'),
  groupingId: uuid('grouping_id'),
  classification: varchar('classification', { length: 30 }).notNull(),
  updatedBy: uuid('updated_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check('chk_fs_cf_overrides_target', sql`num_nonnulls(${t.accountId}, ${t.groupingId}) = 1`),
  uniqueIndex('uniq_fs_cf_overrides_target').on(t.companyId, sql`COALESCE(${t.accountId}, ${ZERO})`, sql`COALESCE(${t.groupingId}, ${ZERO})`),
]);
