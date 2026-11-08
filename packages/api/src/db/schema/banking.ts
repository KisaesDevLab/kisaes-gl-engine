// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { sql } from 'drizzle-orm';
import { pgTable, uuid, varchar, text, decimal, numeric, boolean, date, timestamp, index, uniqueIndex, jsonb, integer, char, smallint } from 'drizzle-orm/pg-core';

export const bankConnections = pgTable('bank_connections', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id'),
  accountId: uuid('account_id').notNull(),
  provider: varchar('provider', { length: 50 }).default('plaid'),
  providerAccountId: varchar('provider_account_id', { length: 255 }),
  providerItemId: varchar('provider_item_id', { length: 255 }),
  accessTokenEncrypted: text('access_token_encrypted'),
  institutionName: varchar('institution_name', { length: 255 }),
  mask: varchar('mask', { length: 10 }),
  lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
  syncStatus: varchar('sync_status', { length: 20 }).default('active'),
  errorMessage: text('error_message'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
});

export const bankFeedItems = pgTable('bank_feed_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id'),
  bankConnectionId: uuid('bank_connection_id').notNull(),
  providerTransactionId: varchar('provider_transaction_id', { length: 255 }),
  feedDate: date('feed_date').notNull(),
  description: varchar('description', { length: 500 }),
  originalDescription: varchar('original_description', { length: 500 }),
  amount: decimal('amount', { precision: 19, scale: 4 }).notNull(),
  category: varchar('category', { length: 255 }),
  status: varchar('status', { length: 20 }).default('pending'),
  matchedTransactionId: uuid('matched_transaction_id'),
  suggestedAccountId: uuid('suggested_account_id'),
  suggestedContactId: uuid('suggested_contact_id'),
  // ADR 0XX §7.3 / ADR 0XY §3.4 — AI's per-line tag suggestion. Flows
  // through resolveDefaultTag at precedence level 2.5 when the user
  // accepts the categorization.
  suggestedTagId: uuid('suggested_tag_id'),
  confidenceScore: decimal('confidence_score', { precision: 3, scale: 2 }),
  matchType: varchar('match_type', { length: 20 }),
  // STATEMENT_CHECK_PAYEE_V1 — check number parsed from a "CHECK ####"
  // description, and the payee read off the check-image thumbnail on the
  // statement. Both are stamped onto the posted transaction at categorize
  // time so reports show the real payee. See migration 0104.
  checkNumber: integer('check_number'),
  payeeNameOnCheck: varchar('payee_name_on_check', { length: 255 }),
  // Migration 0118 — feed-item memo. Plaid sync seeds it with the bank's
  // raw payee text (payment_meta.payee); the review panel edits it; the
  // categorize path stamps it onto the posted transaction.
  memo: text('memo'),
  // Migration 0119 — two-phase workflow. ASSIGN stages the human-chosen
  // category here (status → 'assigned') WITHOUT posting; APPROVE reads these
  // columns and posts the ledger transaction. Distinct from suggested_* (the
  // AI/rule guess) and matched_transaction_id (the posted result).
  assignedAccountId: uuid('assigned_account_id'),
  assignedContactId: uuid('assigned_contact_id'),
  assignedTagId: uuid('assigned_tag_id'),
  assignedMemo: text('assigned_memo'),
  assignedBy: uuid('assigned_by'),
  assignedAt: timestamp('assigned_at', { withTimezone: true }),
  // Phase 4 — when a conditional rule's `skip_ai` action fires
  // for this item, the AI categorizer batch step skips it.
  skipAi: boolean('skip_ai').notNull().default(false),
  // Phase 4 — when a conditional rule's split_by_* action fires,
  // this JSONB carries the per-split config that the categorize
  // path consumes to post N journal_lines instead of 2.
  splitsConfig: jsonb('splits_config'),
  // Statement-driven reconciliation (migration 0115): which bank_statements
  // row this item was imported from. Lets auto-clear trace statement rows to
  // their posted journal lines. FK ON DELETE SET NULL in SQL.
  statementId: uuid('statement_id'),
  // Migration 0188 — Close Review "Looks right" mark on a categorized /
  // matched / excluded item. NULL = not yet reviewed for the close.
  closeReviewedAt: timestamp('close_reviewed_at', { withTimezone: true }),
  closeReviewedBy: uuid('close_reviewed_by'),
  // Migration 0263 (U-06, bank-import-batch-v1): the import batch a row came
  // from (FK ON DELETE SET NULL in SQL), its dedupe key (the FITID key when
  // the bank id was trusted, else the row key; unique per connection), its
  // row key, the key version and the line in the source file.
  importBatchId: uuid('import_batch_id'),
  dedupeKey: char('dedupe_key', { length: 64 }),
  rowKey: char('row_key', { length: 64 }),
  dedupeVersion: smallint('dedupe_version'),
  sourceLine: integer('source_line'),
  // Q-P25c: imported as a look-alike of an existing item (soft reference).
  possibleDuplicate: boolean('possible_duplicate').notNull().default(false),
  possibleDuplicateOf: uuid('possible_duplicate_of'),
  // Migration 0265 (U-166, feed-match-v2): the journal line on the item's
  // bank account this item is (one item per line, partial unique index;
  // NULL for items matched before 0265, which hold the whole transaction),
  // and when the entry the item points at was voided (Q-P26u).
  matchedJournalLineId: uuid('matched_journal_line_id'),
  entryVoidedAt: timestamp('entry_voided_at', { withTimezone: true }),
  // Migration 0266 (U-168, U-174): the rule that staged the suggestion
  // ('conditional' = conditional_rules, 'legacy' = bank_rules), written with
  // the suggestion; why an excluded item was excluded ('duplicate' or NULL).
  suggestedRuleId: uuid('suggested_rule_id'),
  suggestedRuleKind: varchar('suggested_rule_kind', { length: 12 }),
  exclusionReason: varchar('exclusion_reason', { length: 20 }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  tenantIdx: index('idx_bfi_tenant').on(table.tenantId),
  statusIdx: index('idx_bfi_status').on(table.tenantId, table.status),
  dateIdx: index('idx_bfi_date').on(table.tenantId, table.feedDate),
  // A bank's transaction id is unique per bank connection (migration 0262,
  // U-163); the tenant-wide index serves the Plaid sync's lookups.
  connectionProviderTxnUniq: uniqueIndex('uq_bfi_connection_provider_txn')
    .on(table.bankConnectionId, table.providerTransactionId)
    .where(sql`provider_transaction_id IS NOT NULL`),
  tenantProviderTxnIdx: index('idx_bfi_tenant_provider_txn').on(table.tenantId, table.providerTransactionId),
  connectionDedupeKeyUniq: uniqueIndex('uq_bfi_connection_dedupe_key')
    .on(table.bankConnectionId, table.dedupeKey)
    .where(sql`dedupe_key IS NOT NULL`),
  connectionRowKeyIdx: index('idx_bfi_connection_row_key').on(table.bankConnectionId, table.rowKey)
    .where(sql`row_key IS NOT NULL`),
  importBatchIdx: index('idx_bfi_import_batch').on(table.importBatchId).where(sql`import_batch_id IS NOT NULL`),
  // Migrations 0265 and 0266.
  matchedJournalLineUniq: uniqueIndex('uq_bfi_matched_journal_line').on(table.tenantId, table.matchedJournalLineId)
    .where(sql`matched_journal_line_id IS NOT NULL`),
  matchedTxnIdx: index('idx_bfi_matched_txn').on(table.tenantId, table.matchedTransactionId)
    .where(sql`matched_transaction_id IS NOT NULL`),
  entryVoidedIdx: index('idx_bfi_entry_voided').on(table.tenantId, table.entryVoidedAt).where(sql`entry_voided_at IS NOT NULL`),
  // Migration 0268: the transfer-twin match signal (bank-feed-buckets.ts).
  waitingAmountIdx: index('idx_bfi_waiting_amount').on(table.tenantId, table.amount)
    .where(sql`status IN ('pending', 'assigned')`),
  suggestedRuleIdx: index('idx_bfi_suggested_rule').on(table.tenantId, table.suggestedRuleKind, table.suggestedRuleId)
    .where(sql`suggested_rule_id IS NOT NULL`),
}));

// Bank file import batches (migration 0263, U-06). One row per committed
// batch, also when nothing was inserted. `result` is the response, kept for
// an Idempotency-Key replay. FKs (tenant, company, connection) in the SQL.
export const bankImportBatches = pgTable('bank_import_batches', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id'),
  bankConnectionId: uuid('bank_connection_id').notNull(),
  accountId: uuid('account_id').notNull(),
  format: varchar('format', { length: 8 }).notNull(), // ofx | qfx | qif | csv
  fileName: varchar('file_name', { length: 255 }).notNull(),
  sourceFileSha256: char('source_file_sha256', { length: 64 }).notNull(),
  sectionIndex: integer('section_index').notNull().default(0),
  sectionStart: date('section_start'),
  sectionEnd: date('section_end'),
  amountsFlipped: boolean('amounts_flipped').notNull().default(false),
  csvMapping: jsonb('csv_mapping'),
  rowsInFile: integer('rows_in_file').notNull().default(0),
  newCount: integer('new_count').notNull().default(0),
  duplicateCount: integer('duplicate_count').notNull().default(0),
  possibleDuplicateCount: integer('possible_duplicate_count').notNull().default(0),
  changedCount: integer('changed_count').notNull().default(0),
  closedPeriodCount: integer('closed_period_count').notNull().default(0),
  insertedCount: integer('inserted_count').notNull().default(0),
  insertedTotal: numeric('inserted_total').notNull().default('0'),
  fileEndingBalance: decimal('file_ending_balance', { precision: 19, scale: 4 }),
  fileEndingDate: date('file_ending_date'),
  result: jsonb('result'),
  // `changed` rows the batch replaced, with their values before (undo restores them).
  replacedItems: jsonb('replaced_items'),
  postProcessing: varchar('post_processing', { length: 12 }).notNull().default('scheduled'), // scheduled | done | failed (undone while scheduled: reported as cancelled)
  // Post-processing progress (0264): items to do (set when it starts) and done.
  totalRows: integer('total_rows'),
  processedRows: integer('processed_rows').notNull().default(0),
  // An undo asked the running post-processing to stop after its chunk (0264).
  cancelRequestedAt: timestamp('cancel_requested_at', { withTimezone: true }),
  undoneAt: timestamp('undone_at', { withTimezone: true }),
  undoneBy: uuid('undone_by'),
  createdBy: uuid('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  accountIdx: index('idx_bank_import_batches_account').on(table.tenantId, table.accountId, table.format, table.createdAt),
  scheduledIdx: index('idx_bank_import_batches_scheduled').on(table.createdAt).where(sql`post_processing = 'scheduled'`),
}));

// Which bank connection a bank file's account identity belongs to
// (migration 0263, U-06). account_key_hash is an HMAC of the bank file's
// BANKID and ACCTID under the company's link key (bank_link_keys, owner
// Q-P25u), computed by the engine; the account number is never stored.
// Unique per tenant (the key differs per company).
export const bankConnectionIdentities = pgTable('bank_connection_identities', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  bankConnectionId: uuid('bank_connection_id').notNull(),
  mask: varchar('mask', { length: 10 }).notNull(),
  accountKeyHash: char('account_key_hash', { length: 64 }).notNull(),
  createdBy: uuid('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  hashUniq: uniqueIndex('uq_bank_connection_identities_hash').on(table.tenantId, table.accountKeyHash),
  connectionIdx: index('idx_bank_connection_identities_connection').on(table.bankConnectionId),
}));

// One bank-file link key per company (migration 0263, owner Q-P25u): the
// HMAC key of bank_connection_identities.account_key_hash, encrypted with
// utils/encryption.ts; re-encrypted for the importing install by a tenant
// export (SECRET_COLUMNS). FKs (tenant, company) in the SQL.
export const bankLinkKeys = pgTable('bank_link_keys', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id').notNull(),
  keyEncrypted: text('key_encrypted'), // NULL: none yet or unreadable after a restore
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  companyUniq: uniqueIndex('uq_bank_link_keys_company').on(table.companyId),
}));

export const reconciliations = pgTable('reconciliations', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id'),
  accountId: uuid('account_id').notNull(),
  statementDate: date('statement_date').notNull(),
  statementEndingBalance: decimal('statement_ending_balance', { precision: 19, scale: 4 }).notNull(),
  beginningBalance: decimal('beginning_balance', { precision: 19, scale: 4 }).notNull(),
  clearedBalance: decimal('cleared_balance', { precision: 19, scale: 4 }),
  difference: decimal('difference', { precision: 19, scale: 4 }),
  status: varchar('status', { length: 20 }).default('in_progress'),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  completedBy: uuid('completed_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
});

export const reconciliationLines = pgTable('reconciliation_lines', {
  id: uuid('id').primaryKey().defaultRandom(),
  reconciliationId: uuid('reconciliation_id').notNull(),
  journalLineId: uuid('journal_line_id').notNull(),
  isCleared: boolean('is_cleared').default(false),
  clearedAt: timestamp('cleared_at', { withTimezone: true }),
});

// Electronic sign-off on a completed reconciliation (migration 0214).
// Preparer, then Reviewer (a different user, firm staff). `fingerprint` hashes
// the reconciliation's substance at signing (see reconciliation-signoff.service
// computeReconFingerprint); a mismatch on read, a reopen/undo, or the
// preparer's removal sets invalidated_at + invalidated_reason. One LIVE
// (invalidated_at IS NULL) sign-off per (reconciliation, role).
export const reconciliationSignoffs = pgTable('reconciliation_signoffs', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  reconciliationId: uuid('reconciliation_id').notNull().references(() => reconciliations.id, { onDelete: 'cascade' }),
  role: varchar('role', { length: 10 }).notNull(), // preparer | reviewer
  userId: uuid('user_id').notNull(),
  signerName: varchar('signer_name', { length: 255 }).notNull(),
  signedAt: timestamp('signed_at', { withTimezone: true }).notNull().defaultNow(),
  fingerprint: text('fingerprint').notNull(),
  invalidatedAt: timestamp('invalidated_at', { withTimezone: true }),
  // removed | preparer_removed | reconciliation_reopened | data_changed
  invalidatedReason: varchar('invalidated_reason', { length: 40 }),
  invalidatedDetail: text('invalidated_detail'),
  invalidatedBy: uuid('invalidated_by'),
}, (t) => [
  uniqueIndex('uniq_reconciliation_signoffs_live').on(t.reconciliationId, t.role).where(sql`${t.invalidatedAt} IS NULL`),
  index('idx_reconciliation_signoffs_rec').on(t.tenantId, t.reconciliationId, t.signedAt),
]);

// Statement-driven reconciliation (migration 0115): parsed bank statements
// as first-class records. Captured on statement import (from the ai_jobs
// parse result), backfilled from historical completed 'ocr_statement' jobs,
// and linked to the reconciliation they seed. FKs (accounts / attachments /
// ai_jobs / reconciliations, ON DELETE SET NULL where nullable) are declared
// in the SQL migration, matching the file's existing style.
export const bankStatements = pgTable('bank_statements', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id'),
  accountId: uuid('account_id').notNull(),
  attachmentId: uuid('attachment_id'),
  aiJobId: uuid('ai_job_id'),
  periodStart: date('period_start'),
  periodEnd: date('period_end').notNull(),
  openingBalance: decimal('opening_balance', { precision: 19, scale: 4 }),
  closingBalance: decimal('closing_balance', { precision: 19, scale: 4 }).notNull(),
  maskedAccountNumber: varchar('masked_account_number', { length: 50 }),
  institutionName: varchar('institution_name', { length: 255 }),
  // Extraction type_hint: CHECKING | SAVINGS | CREDITCARD | LINEOFCREDIT | ...
  statementType: varchar('statement_type', { length: 30 }),
  // Golden-Rule (opening + Σ = closing) arithmetic check from the parse:
  // 'verified' | 'discrepancy' | 'unknown' (balances missing / skipped).
  goldenRuleStatus: varchar('golden_rule_status', { length: 20 }).default('unknown'),
  goldenRuleDelta: decimal('golden_rule_delta', { precision: 19, scale: 4 }),
  reconciliationId: uuid('reconciliation_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  tenantAccountIdx: index('idx_bank_statements_tenant_account').on(table.tenantId, table.accountId, table.periodEnd),
  aiJobIdx: index('idx_bank_statements_ai_job').on(table.aiJobId),
  reconciliationIdx: index('idx_bank_statements_reconciliation').on(table.reconciliationId),
}));

// Dismissed "no statement on file for YYYY-MM" Bank Rec warnings (migration 0197).
export const statementGapDismissals = pgTable('statement_gap_dismissals', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  accountId: uuid('account_id').notNull(),
  month: varchar('month', { length: 7 }).notNull(),
  dismissedBy: uuid('dismissed_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  uniq: uniqueIndex('uniq_statement_gap_dismissals').on(table.tenantId, table.accountId, table.month),
}));

// Statement Match Engine wave 1 (migration 0116): each parsed statement
// transaction as a first-class line, scored against reconciliation worksheet
// journal lines. `amount` is SIGNED in normalized statement orientation —
// money INTO the GL account (deposit / card payment) positive, money OUT
// (spend / charge) negative; it equals `jl.debit - jl.credit` of the matching
// journal line on the reconciliation account. FKs (statement CASCADE,
// journal line SET NULL) declared in the SQL migration.
export const bankStatementLines = pgTable('bank_statement_lines', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  statementId: uuid('statement_id').notNull(),
  lineDate: date('line_date').notNull(),
  description: text('description'),
  amount: decimal('amount', { precision: 19, scale: 4 }).notNull(),
  checkNumber: varchar('check_number', { length: 40 }),
  payee: varchar('payee', { length: 255 }),
  runningBalance: decimal('running_balance', { precision: 19, scale: 4 }),
  // 'unmatched' | 'auto' | 'suggested' | 'confirmed' | 'rejected'
  matchStatus: varchar('match_status', { length: 20 }).notNull().default('unmatched'),
  matchedJournalLineId: uuid('matched_journal_line_id'),
  matchScore: decimal('match_score', { precision: 6, scale: 4 }),
  scoreBreakdown: jsonb('score_breakdown'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  tenantStatementIdx: index('idx_bsl_tenant_statement').on(table.tenantId, table.statementId),
  tenantMatchedJlIdx: index('idx_bsl_tenant_matched_jl').on(table.tenantId, table.matchedJournalLineId),
}));

// Bank feed accept records (migration 0268, U-169, feed-undo-v1; review B5).
// One group per accept request (POST /banking/feed/accept, /:id/transfer,
// /:id/deposit, a match, a payment received for a bank line); one item row
// per feed item it linked. Undo acts only on item rows whose feed item still
// points at transaction_id and that are not undone.
export const bankFeedAcceptGroups = pgTable('bank_feed_accept_groups', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id'),
  userId: uuid('user_id'),
  /** accept | transfer | deposit | match | payment */
  source: varchar('source', { length: 20 }).notNull(),
  ruleId: uuid('rule_id'),
  ruleKind: varchar('rule_kind', { length: 12 }),
  /** The accept response (GET /banking/feed/accept-groups/:id). */
  result: jsonb('result'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  tenantCreatedIdx: index('idx_bfag_tenant_created').on(table.tenantId, table.createdAt),
}));

export const bankFeedAcceptGroupItems = pgTable('bank_feed_accept_group_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id'),
  groupId: uuid('group_id').notNull(),
  feedItemId: uuid('feed_item_id').notNull(),
  /** post | match | transfer | deposit | payment */
  kind: varchar('kind', { length: 12 }).notNull(),
  transactionId: uuid('transaction_id').notNull(),
  journalLineId: uuid('journal_line_id'),
  /** sha256 of the entry's date, contact, memo and lines at commit (FEED_UNDO_CHANGED). */
  txnFingerprint: char('txn_fingerprint', { length: 64 }),
  /** The feed item's review state before the accept, restored by Undo and Review again. */
  priorState: jsonb('prior_state').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  undoneAt: timestamp('undone_at', { withTimezone: true }),
  undoneBy: uuid('undone_by'),
}, (table) => ({
  groupIdx: index('idx_bfagi_group').on(table.tenantId, table.groupId),
  itemLiveIdx: index('idx_bfagi_item_live').on(table.tenantId, table.feedItemId, table.createdAt)
    .where(sql`undone_at IS NULL`),
  txnIdx: index('idx_bfagi_txn').on(table.tenantId, table.transactionId),
}));
