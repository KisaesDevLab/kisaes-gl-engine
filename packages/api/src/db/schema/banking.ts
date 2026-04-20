// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { pgTable, uuid, varchar, text, decimal, boolean, date, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';

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
