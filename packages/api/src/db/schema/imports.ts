// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

import { pgTable, uuid, varchar, integer, jsonb, date, timestamp, index, boolean, primaryKey } from 'drizzle-orm/pg-core';

// One row per file the operator uploads through the bulk-import flow.
// Holds parsed canonical rows + validation errors as JSONB so each kind
// (coa, contacts, trial_balance, gl_transactions) shares one table.
// Lifecycle: uploaded → (validated) → committing → committed | failed,
// or uploaded → cancelled. Indexes target the two queries the page
// actually runs: list-by-(tenant,company,kind,status) and the
// duplicate-upload check by file hash.
export const importSessions = pgTable('import_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id').notNull(),
  kind: varchar('kind', { length: 20 }).notNull(),
  sourceSystem: varchar('source_system', { length: 30 }).notNull(),
  status: varchar('status', { length: 20 }).notNull().default('uploaded'),
  originalFilename: varchar('original_filename', { length: 255 }).notNull(),
  fileHash: varchar('file_hash', { length: 64 }).notNull(),
  rowCount: integer('row_count').notNull().default(0),
  errorCount: integer('error_count').notNull().default(0),
  parsedRows: jsonb('parsed_rows'),
  validationErrors: jsonb('validation_errors'),
  // Populated by the GL/TB commit step so the operator can see counts
  // (created, skipped duplicates, voids reversed) on the success page.
  commitResult: jsonb('commit_result'),
  options: jsonb('options'),
  // Trial-balance only — the date the opening JE will/did post under.
  // For AP TB the operator supplies it at upload; for QBO TB the
  // adapter parses "As of <DATE>" from the file header.
  reportDate: date('report_date'),
  createdBy: uuid('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  committedAt: timestamp('committed_at', { withTimezone: true }),
  // U-261, U-263 (migration 0282). The batch this session belongs to (one at
  // most); 'post' sessions are posted, 'reference' sessions are only compared
  // against (tie-out). row_hash is SHA-256 over kind, source, report date and
  // the normalized parsed rows; active_commit is true while a committed batch
  // holds the session (a partial unique index refuses a second one). The
  // date range is a journal file's first and last entry date.
  batchId: uuid('batch_id'),
  role: varchar('role', { length: 10 }).notNull().default('post'),
  rowHash: varchar('row_hash', { length: 64 }),
  activeCommit: boolean('active_commit').notNull().default(false),
  dateFrom: date('date_from'),
  dateTo: date('date_to'),
}, (table) => ({
  byCompanyKind: index('idx_imp_sess_tck').on(table.tenantId, table.companyId, table.kind, table.status),
  byHash: index('idx_imp_sess_hash').on(table.tenantId, table.companyId, table.fileHash),
}));

// U-261 (migration 0282): parsed canonical rows of a session, one per row
// (review S8: no single large jsonb). Deleted at verify and at undo.
export const importRows = pgTable('import_rows', {
  sessionId: uuid('session_id').notNull(),
  rowNo: integer('row_no').notNull(),
  data: jsonb('data').notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.sessionId, table.rowNo] }),
}));

// U-261 (migration 0282): a Bulk Import batch, the unit of commit, undo and
// record. status: draft -> committing -> committed | failed; committed ->
// undoing -> undone (or back to committed when the undo fails).
export const importBatches = pgTable('import_batches', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id').notNull(),
  sourceSystem: varchar('source_system', { length: 30 }).notNull(),
  kind: varchar('kind', { length: 20 }).notNull().default('single'),
  status: varchar('status', { length: 20 }).notNull().default('draft'),
  options: jsonb('options'),
  priorValues: jsonb('prior_values'),
  tieout: jsonb('tieout'),
  spotCheck: jsonb('spot_check'),
  result: jsonb('result'),
  error: jsonb('error'),
  backupRef: varchar('backup_ref', { length: 500 }),
  companyWasEmpty: boolean('company_was_empty'),
  conversionDate: date('conversion_date'),
  historyFrom: date('history_from'),
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
  verifiedBy: uuid('verified_by'),
  createdBy: uuid('created_by'),
  committedBy: uuid('committed_by'),
  committedAt: timestamp('committed_at', { withTimezone: true }),
  undoneBy: uuid('undone_by'),
  undoneAt: timestamp('undone_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  byCompany: index('idx_imp_batches_company').on(table.tenantId, table.companyId, table.createdAt, table.id),
}));
