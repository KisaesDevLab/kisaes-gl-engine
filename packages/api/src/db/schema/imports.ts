// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { pgTable, uuid, varchar, integer, jsonb, date, timestamp, index } from 'drizzle-orm/pg-core';

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
}, (table) => ({
  byCompanyKind: index('idx_imp_sess_tck').on(table.tenantId, table.companyId, table.kind, table.status),
  byHash: index('idx_imp_sess_hash').on(table.tenantId, table.companyId, table.fileHash),
}));
