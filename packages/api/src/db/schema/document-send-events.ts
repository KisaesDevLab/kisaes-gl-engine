// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { pgTable, uuid, varchar, jsonb, timestamp, index } from 'drizzle-orm/pg-core';

/** How a form was sent (U-126). */
export type DocumentSendMethod = 'printed' | 'email' | 'pdf';

// Send history of a form (U-126, migration 0242): one row per send, kept
// across edits. recipients is the email addresses (empty for printed / pdf);
// it is never written to a log or an audit row.
export const documentSendEvents = pgTable('document_send_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id'),
  transactionId: uuid('transaction_id').notNull(),
  method: varchar('method', { length: 10 }).$type<DocumentSendMethod>().notNull(),
  recipients: jsonb('recipients').$type<string[]>().notNull().default([]),
  sentAt: timestamp('sent_at', { withTimezone: true }).notNull().defaultNow(),
  userId: uuid('user_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  txnIdx: index('idx_document_send_events_txn').on(table.tenantId, table.transactionId, table.sentAt),
}));
