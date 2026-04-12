import { pgTable, uuid, varchar, text, decimal, boolean, date, timestamp, integer, index, uniqueIndex, jsonb } from 'drizzle-orm/pg-core';

// ── Provider Templates ──
export const payrollProviderTemplates = pgTable('payroll_provider_templates', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 100 }).notNull(),
  providerKey: varchar('provider_key', { length: 50 }).notNull(),
  description: text('description'),
  columnMap: jsonb('column_map'),
  fileFormatHints: jsonb('file_format_hints'),
  isSystem: boolean('is_system').default(false),
  tenantId: uuid('tenant_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  providerKeyIdx: index('idx_payroll_tpl_provider').on(table.providerKey),
  tenantIdx: index('idx_payroll_tpl_tenant').on(table.tenantId),
}));

// ── Import Sessions ──
export const payrollImportSessions = pgTable('payroll_import_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id'),
  importMode: varchar('import_mode', { length: 20 }).notNull(), // 'employee_level' | 'prebuilt_je'
  templateId: uuid('template_id'),
  originalFilename: varchar('original_filename', { length: 255 }).notNull(),
  filePath: varchar('file_path', { length: 500 }).notNull(),
  fileHash: varchar('file_hash', { length: 64 }).notNull(),
  companionFilename: varchar('companion_filename', { length: 255 }),
  companionFilePath: varchar('companion_file_path', { length: 500 }),
  payPeriodStart: date('pay_period_start'),
  payPeriodEnd: date('pay_period_end'),
  checkDate: date('check_date'),
  status: varchar('status', { length: 20 }).notNull().default('uploaded'), // uploaded, mapped, validated, posted, failed, cancelled
  rowCount: integer('row_count').default(0),
  errorCount: integer('error_count').default(0),
  jeCount: integer('je_count').default(1),
  journalEntryId: uuid('journal_entry_id'),
  journalEntryIds: jsonb('journal_entry_ids'), // uuid[] for Mode B multi-JE
  columnMapSnapshot: jsonb('column_map_snapshot'),
  metadata: jsonb('metadata'),
  idempotencyKey: varchar('idempotency_key', { length: 255 }),
  detectedProvider: varchar('detected_provider', { length: 50 }),
  createdBy: uuid('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  tenantIdx: index('idx_payroll_sess_tenant').on(table.tenantId),
  companyStatusIdx: index('idx_payroll_sess_company_status').on(table.companyId, table.status),
  fileHashIdx: index('idx_payroll_sess_hash').on(table.tenantId, table.fileHash),
}));

// ── Import Column Mappings (per-session user overrides) ──
export const payrollImportColumnMappings = pgTable('payroll_import_column_mappings', {
  id: uuid('id').primaryKey().defaultRandom(),
  sessionId: uuid('session_id').notNull(),
  sourceColumn: varchar('source_column', { length: 200 }).notNull(),
  targetField: varchar('target_field', { length: 100 }).notNull(),
  transformRule: jsonb('transform_rule'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  sessionIdx: index('idx_payroll_colmap_session').on(table.sessionId),
}));

// ── Import Rows (staging) ──
export const payrollImportRows = pgTable('payroll_import_rows', {
  id: uuid('id').primaryKey().defaultRandom(),
  sessionId: uuid('session_id').notNull(),
  rowNumber: integer('row_number').notNull(),
  rawData: jsonb('raw_data'),
  mappedData: jsonb('mapped_data'),
  validationStatus: varchar('validation_status', { length: 20 }).default('pending'), // pending, valid, warning, error
  validationMessages: jsonb('validation_messages'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  sessionRowIdx: index('idx_payroll_rows_session_row').on(table.sessionId, table.rowNumber),
}));

// ── Import Errors (session-level) ──
export const payrollImportErrors = pgTable('payroll_import_errors', {
  id: uuid('id').primaryKey().defaultRandom(),
  sessionId: uuid('session_id').notNull(),
  errorType: varchar('error_type', { length: 50 }).notNull(), // parse_error, mapping_error, posting_error
  message: text('message').notNull(),
  detail: jsonb('detail'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  sessionIdx: index('idx_payroll_errors_session').on(table.sessionId),
}));

// ── Description→Account Map (Mode B) ──
export const payrollDescriptionAccountMap = pgTable('payroll_description_account_map', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id'),
  providerKey: varchar('provider_key', { length: 50 }).notNull(),
  sourceDescription: varchar('source_description', { length: 200 }).notNull(),
  accountId: uuid('account_id').notNull(),
  lineCategory: varchar('line_category', { length: 30 }), // expense, liability, asset, equity
  isSystemSuggested: boolean('is_system_suggested').default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  uniqueDescMap: uniqueIndex('idx_payroll_descmap_unique').on(table.tenantId, table.companyId, table.providerKey, table.sourceDescription),
  tenantIdx: index('idx_payroll_descmap_tenant').on(table.tenantId),
}));

// ── Check Register Rows (Mode B companion) ──
export const payrollCheckRegisterRows = pgTable('payroll_check_register_rows', {
  id: uuid('id').primaryKey().defaultRandom(),
  sessionId: uuid('session_id').notNull(),
  rowNumber: integer('row_number').notNull(),
  checkNumber: varchar('check_number', { length: 20 }),
  checkDate: date('check_date').notNull(),
  payeeName: varchar('payee_name', { length: 200 }).notNull(),
  amount: decimal('amount', { precision: 19, scale: 4 }).notNull(),
  memo: varchar('memo', { length: 500 }),
  checkType: varchar('check_type', { length: 20 }), // employee, contractor, tax_payment
  posted: boolean('posted').default(false),
  transactionId: uuid('transaction_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  sessionIdx: index('idx_payroll_checks_session').on(table.sessionId),
}));

// ── Payroll Account Mapping (per-company COA mapping for JE generation) ──
export const payrollAccountMapping = pgTable('payroll_account_mapping', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id'),
  lineType: varchar('line_type', { length: 50 }).notNull(),
  accountId: uuid('account_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  uniqueMapping: uniqueIndex('idx_payroll_acctmap_unique').on(table.tenantId, table.companyId, table.lineType),
  tenantIdx: index('idx_payroll_acctmap_tenant').on(table.tenantId),
}));
