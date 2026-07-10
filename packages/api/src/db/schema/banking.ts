// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { pgTable, uuid, varchar, text, decimal, boolean, date, timestamp, index, uniqueIndex, jsonb, integer } from 'drizzle-orm/pg-core';

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
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  tenantIdx: index('idx_bfi_tenant').on(table.tenantId),
  statusIdx: index('idx_bfi_status').on(table.tenantId, table.status),
  dateIdx: index('idx_bfi_date').on(table.tenantId, table.feedDate),
  providerTxnIdx: uniqueIndex('idx_bfi_provider_txn').on(table.tenantId, table.providerTransactionId),
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
