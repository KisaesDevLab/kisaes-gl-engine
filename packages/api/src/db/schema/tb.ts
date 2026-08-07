// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Trial Balance module tables (docs/tb/BUILD_PLAN.md §4, ADR-TB-01…06).
// "Entity" in the plan = a `companies` row (CLAUDE.md rule TB2). Balances
// are never stored here (rule TB1) — these tables hold tax-code metadata,
// assignments, workpaper annotations, tax-only (RJE) entries, and the
// glVersionStamp counters that make computed-balance caching exact.

import { pgTable, uuid, varchar, text, decimal, boolean, date, timestamp, integer, bigint, jsonb, index, uniqueIndex, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// ─── Seed code library (global, ADR-TB-05) ──────────────────────────

// One row per imported seed file. Global (no tenant scope): the tax-code
// crosswalk is system-wide reference data, admin-managed.
export const taxCodeSeedVersions = pgTable('tax_code_seed_versions', {
  id: uuid('id').primaryKey().defaultRandom(),
  taxYear: integer('tax_year').notNull(),
  version: integer('version').notNull(),
  label: varchar('label', { length: 200 }),
  sourceFileHash: varchar('source_file_hash', { length: 64 }).notNull(),
  rowCount: integer('row_count').notNull().default(0),
  importedBy: uuid('imported_by'),
  importedAt: timestamp('imported_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('uniq_tax_code_seed_versions').on(t.taxYear, t.version),
]);

export const taxCodes = pgTable('tax_codes', {
  id: uuid('id').primaryKey().defaultRandom(),
  versionId: uuid('version_id').notNull().references(() => taxCodeSeedVersions.id, { onDelete: 'cascade' }),
  returnForm: varchar('return_form', { length: 10 }).notNull(),
  activityType: varchar('activity_type', { length: 20 }).notNull(),
  code: varchar('code', { length: 50 }).notNull(),
  description: text('description').notNull().default(''),
  sortOrder: integer('sort_order').notNull().default(0),
  isM1Adjustment: boolean('is_m1_adjustment').notNull().default(false),
  notes: text('notes'),
  ultrataxCode: varchar('ultratax_code', { length: 50 }),
  cchCode: varchar('cch_code', { length: 50 }),
  lacerteCode: varchar('lacerte_code', { length: 50 }),
  gosystemCode: varchar('gosystem_code', { length: 50 }),
  genericCode: varchar('generic_code', { length: 50 }),
}, (t) => [
  uniqueIndex('uniq_tax_codes_version_form_activity_code').on(t.versionId, t.returnForm, t.activityType, t.code),
  index('idx_tax_codes_version_form').on(t.versionId, t.returnForm),
]);

// Firm/tenant custom codes (rule TB8). Scoped to EITHER a firm (shared
// across the firm's client tenants) OR a single tenant (standalone
// installs without a firms row) — exactly one owner. Never touched by
// seed imports (standing invariant #5).
export const firmTaxCodes = pgTable('firm_tax_codes', {
  id: uuid('id').primaryKey().defaultRandom(),
  firmId: uuid('firm_id'),
  tenantId: uuid('tenant_id'),
  code: varchar('code', { length: 60 }).notNull(),
  description: text('description').notNull().default(''),
  returnForm: varchar('return_form', { length: 10 }).notNull(),
  activityType: varchar('activity_type', { length: 20 }).notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
  isM1Adjustment: boolean('is_m1_adjustment').notNull().default(false),
  ultrataxCode: varchar('ultratax_code', { length: 50 }),
  cchCode: varchar('cch_code', { length: 50 }),
  lacerteCode: varchar('lacerte_code', { length: 50 }),
  gosystemCode: varchar('gosystem_code', { length: 50 }),
  genericCode: varchar('generic_code', { length: 50 }),
  isActive: boolean('is_active').notNull().default(true),
  createdBy: uuid('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check('chk_firm_tax_codes_one_owner', sql`num_nonnulls(${t.firmId}, ${t.tenantId}) = 1`),
  check('chk_firm_tax_codes_namespace', sql`${t.code} LIKE 'FIRM:%'`),
  uniqueIndex('uniq_firm_tax_codes_owner_code').on(
    sql`COALESCE(${t.firmId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
    sql`COALESCE(${t.tenantId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
    t.returnForm, t.activityType, t.code,
  ),
]);

// ─── Per-company tax profile & activity units (ADR-TB-02, D11) ──────

export const companyTaxProfiles = pgTable('company_tax_profiles', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id').notNull(),
  returnForm: varchar('return_form', { length: 10 }).notNull(),
  // NULL = float to the latest seed version for the tax year (ADR-TB-05).
  pinnedSeedVersionId: uuid('pinned_seed_version_id').references(() => taxCodeSeedVersions.id),
  sCorpElectionDate: date('s_corp_election_date'),
  // Schedule M-2 equity-account role map (9.4): { accountId:
  // 'retained' | 'distributions' | 'contributions' | 'other' }.
  equityRoles: jsonb('equity_roles'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('uniq_company_tax_profiles_company').on(t.companyId),
  index('idx_company_tax_profiles_tenant').on(t.tenantId),
]);

export const activityUnits = pgTable('activity_units', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id').notNull(),
  activityType: varchar('activity_type', { length: 20 }).notNull(),
  instanceNumber: integer('instance_number').notNull().default(1),
  displayName: varchar('display_name', { length: 200 }).notNull(),
  isDefault: boolean('is_default').notNull().default(false),
  // Soft archive (plan 3.2): units with history are archived, never deleted.
  archivedAt: timestamp('archived_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('uniq_activity_units_live').on(t.companyId, t.activityType, t.instanceNumber).where(sql`${t.archivedAt} IS NULL`),
  // Exactly-one-default invariant (per live units); service enforces the
  // "at least one" half.
  uniqueIndex('uniq_activity_units_default').on(t.companyId).where(sql`${t.isDefault} AND ${t.archivedAt} IS NULL`),
  index('idx_activity_units_tenant_company').on(t.tenantId, t.companyId),
]);

export const tagActivityMap = pgTable('tag_activity_map', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id').notNull(),
  tagId: uuid('tag_id').notNull(),
  activityUnitId: uuid('activity_unit_id').notNull().references(() => activityUnits.id, { onDelete: 'restrict' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // One tag → one unit (a unit may own many tags).
  uniqueIndex('uniq_tag_activity_map_tag').on(t.companyId, t.tagId),
  index('idx_tag_activity_map_unit').on(t.activityUnitId),
  index('idx_tag_activity_map_tenant_company').on(t.tenantId, t.companyId),
]);

// ─── Account → tax code assignments ─────────────────────────────────

// Current assignment per (company, account[, activity unit]) — persistent
// year-over-year (D8), no per-year history. Discriminated code reference:
// exactly one of seed_code_ref / firm_code_id. seed_code_ref is the STABLE
// identity (return_form, activity_type, code) rather than a tax_codes.id
// so re-pinning to a newer seed version never orphans assignments.
export const accountTaxAssignments = pgTable('account_tax_assignments', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id').notNull(),
  accountId: uuid('account_id').notNull(),
  // NULL = account-level assignment (single-unit accounts, ADR-TB-02).
  activityUnitId: uuid('activity_unit_id').references(() => activityUnits.id, { onDelete: 'restrict' }),
  seedCode: varchar('seed_code', { length: 50 }),
  seedActivityType: varchar('seed_activity_type', { length: 20 }),
  firmCodeId: uuid('firm_code_id').references(() => firmTaxCodes.id, { onDelete: 'restrict' }),
  // Provenance for the AI-assignment flow (6C): 'manual' | 'ai'.
  source: varchar('source', { length: 10 }).notNull().default('manual'),
  aiConfidence: integer('ai_confidence'),
  effectiveTaxYear: integer('effective_tax_year'),
  assignedBy: uuid('assigned_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check('chk_account_tax_assignments_one_code', sql`(${t.seedCode} IS NOT NULL AND ${t.seedActivityType} IS NOT NULL AND ${t.firmCodeId} IS NULL) OR (${t.seedCode} IS NULL AND ${t.seedActivityType} IS NULL AND ${t.firmCodeId} IS NOT NULL)`),
  uniqueIndex('uniq_account_tax_assignments').on(
    t.companyId, t.accountId,
    sql`COALESCE(${t.activityUnitId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
  ),
  index('idx_account_tax_assignments_tenant_company').on(t.tenantId, t.companyId),
]);

// ─── Groupings / leadsheets / tickmarks / notes (Phase 7) ───────────

export const tbGroupings = pgTable('tb_groupings', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id').notNull(),
  parentId: uuid('parent_id'),
  name: varchar('name', { length: 200 }).notNull(),
  // Leadsheet designation, e.g. 'A' Cash, 'B' AR … (seeded defaults).
  leadsheetCode: varchar('leadsheet_code', { length: 10 }),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('idx_tb_groupings_tenant_company').on(t.tenantId, t.companyId),
  index('idx_tb_groupings_parent').on(t.parentId),
]);

export const tbGroupingAccounts = pgTable('tb_grouping_accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id').notNull(),
  groupingId: uuid('grouping_id').notNull().references(() => tbGroupings.id, { onDelete: 'cascade' }),
  accountId: uuid('account_id').notNull(),
}, (t) => [
  // An account lives in at most one grouping per company.
  uniqueIndex('uniq_tb_grouping_accounts_account').on(t.companyId, t.accountId),
  index('idx_tb_grouping_accounts_grouping').on(t.groupingId),
]);

// Firm-level tickmark library (tenant-scoped; seeded standards F, ✓, PY …).
export const tbTickmarks = pgTable('tb_tickmarks', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  symbol: varchar('symbol', { length: 8 }).notNull(),
  description: varchar('description', { length: 300 }).notNull(),
  color: varchar('color', { length: 20 }),
  sortOrder: integer('sort_order').notNull().default(0),
  isActive: boolean('is_active').notNull().default(true),
}, (t) => [
  uniqueIndex('uniq_tb_tickmarks_symbol').on(t.tenantId, t.symbol),
]);

export const tbTickmarkApplications = pgTable('tb_tickmark_applications', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id').notNull(),
  taxYear: integer('tax_year').notNull(),
  accountId: uuid('account_id').notNull(),
  // Which workpaper column the mark annotates: unadjusted|aje|adjusted|tax_rje|tax.
  column: varchar('column', { length: 20 }).notNull(),
  tickmarkId: uuid('tickmark_id').notNull().references(() => tbTickmarks.id, { onDelete: 'cascade' }),
  note: text('note'),
  appliedBy: uuid('applied_by'),
  appliedAt: timestamp('applied_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('idx_tb_tickmark_apps_lookup').on(t.companyId, t.taxYear, t.accountId),
  index('idx_tb_tickmark_apps_tenant').on(t.tenantId),
]);

export const tbNotes = pgTable('tb_notes', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id').notNull(),
  taxYear: integer('tax_year').notNull(),
  // NULL = TB-level note (not tied to one account).
  accountId: uuid('account_id'),
  body: text('body').notNull(),
  authorId: uuid('author_id'),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  resolvedBy: uuid('resolved_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('idx_tb_notes_lookup').on(t.companyId, t.taxYear),
  index('idx_tb_notes_tenant').on(t.tenantId),
]);

// Preparer/reviewer sign-offs per grouping (D18, plan 7.6–7.8).
export const tbLeadsheetSignoffs = pgTable('tb_leadsheet_signoffs', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id').notNull(),
  taxYear: integer('tax_year').notNull(),
  groupingId: uuid('grouping_id').notNull().references(() => tbGroupings.id, { onDelete: 'cascade' }),
  role: varchar('role', { length: 10 }).notNull(), // preparer | reviewer
  userId: uuid('user_id').notNull(),
  signedAt: timestamp('signed_at', { withTimezone: true }).notNull().defaultNow(),
  // Staleness detection (7.7): compare against the live stamp.
  glVersionStampAtSignoff: bigint('gl_version_stamp_at_signoff', { mode: 'number' }).notNull(),
  invalidatedAt: timestamp('invalidated_at', { withTimezone: true }),
}, (t) => [
  // One live sign-off per (grouping, tax year, role); re-signs invalidate first.
  uniqueIndex('uniq_tb_leadsheet_signoffs_live').on(t.groupingId, t.taxYear, t.role).where(sql`${t.invalidatedAt} IS NULL`),
  index('idx_tb_leadsheet_signoffs_lookup').on(t.companyId, t.taxYear),
]);

// ─── Tax RJEs (ADR-TB-03, rule TB4 — never touch the GL) ────────────

export const tbTaxEntries = pgTable('tb_tax_entries', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id').notNull(),
  taxYear: integer('tax_year').notNull(),
  // Auto-sequenced per (company, taxYear): shown as RJE-001.
  entryNumber: integer('entry_number').notNull(),
  memo: text('memo'),
  createdBy: uuid('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('uniq_tb_tax_entries_number').on(t.companyId, t.taxYear, t.entryNumber),
  index('idx_tb_tax_entries_tenant').on(t.tenantId),
]);

export const tbTaxEntryLines = pgTable('tb_tax_entry_lines', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  entryId: uuid('entry_id').notNull().references(() => tbTaxEntries.id, { onDelete: 'cascade' }),
  accountId: uuid('account_id').notNull(),
  activityUnitId: uuid('activity_unit_id').references(() => activityUnits.id, { onDelete: 'restrict' }),
  debit: decimal('debit', { precision: 19, scale: 4 }).notNull().default('0'),
  credit: decimal('credit', { precision: 19, scale: 4 }).notNull().default('0'),
  description: text('description'),
  lineOrder: integer('line_order').notNull().default(0),
}, (t) => [
  index('idx_tb_tax_entry_lines_entry').on(t.entryId),
  index('idx_tb_tax_entry_lines_account').on(t.accountId),
]);

// ─── Workflow status & sequences ────────────────────────────────────

export const tbStatus = pgTable('tb_status', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id').notNull(),
  taxYear: integer('tax_year').notNull(),
  workflowState: varchar('workflow_state', { length: 20 }).notNull().default('open'), // open | in_review | complete
  completedBy: uuid('completed_by'),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('uniq_tb_status').on(t.companyId, t.taxYear),
  index('idx_tb_status_tenant').on(t.tenantId),
]);

// AJE display-number sequence per (company, fiscal year) — D17. Rows are
// claimed with SELECT … FOR UPDATE inside the posting transaction so
// concurrent AJEs can't collide.
export const tbAjeSequences = pgTable('tb_aje_sequences', {
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id').notNull(),
  fiscalYear: integer('fiscal_year').notNull(),
  nextNumber: integer('next_number').notNull().default(1),
}, (t) => [
  uniqueIndex('uniq_tb_aje_sequences').on(t.companyId, t.fiscalYear),
]);

// Monotonic GL change counter per company (ADR-TB-01, rule TB6). Bumped
// by DB triggers on journal_lines / transactions so every mutation path —
// including raw-SQL ones — is caught. Read per TB request for exact cache
// invalidation; published to Redis best-effort for SSE push.
// company_id uses the zero-uuid sentinel for tenant-wide (NULL-company)
// transactions; a company's effective stamp = its row + the sentinel row.
export const glVersionStamps = pgTable('gl_version_stamps', {
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id').notNull(),
  counter: bigint('counter', { mode: 'number' }).notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('uniq_gl_version_stamps').on(t.tenantId, t.companyId),
]);
