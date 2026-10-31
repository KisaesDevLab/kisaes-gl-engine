// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { pgTable, uuid, varchar, text, jsonb, timestamp, index } from 'drizzle-orm/pg-core';

// Email Outbox of forms (U-127, migration 0244): one row per message waiting
// to be sent. The message only (recipients, subject, body); the PDF is made
// when it is sent (Q-P20q). Recipients are owner data, never written to a
// log or an audit row.
export const formEmailQueue = pgTable('form_email_queue', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id'),
  transactionId: uuid('transaction_id').notNull(),
  toAddresses: jsonb('to_addresses').$type<string[]>().notNull().default([]),
  ccAddresses: jsonb('cc_addresses').$type<string[]>().notNull().default([]),
  bccAddresses: jsonb('bcc_addresses').$type<string[]>().notNull().default([]),
  subject: varchar('subject', { length: 500 }).notNull().default(''),
  body: text('body').notNull().default(''),
  userId: uuid('user_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  companyIdx: index('idx_form_email_queue_company').on(table.tenantId, table.companyId, table.createdAt),
  txnIdx: index('idx_form_email_queue_txn').on(table.tenantId, table.transactionId),
}));
