// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { pgTable, uuid, varchar, text, jsonb, timestamp, date, decimal, index, uniqueIndex } from 'drizzle-orm/pg-core';
import type { DocumentSendMethod } from './document-send-events.js';

// Customer statements (U-112, U-140; migration 0250). A run issues one
// numbered snapshot per client; the snapshot is display data only (no ids).
// Recipients are owner data, never written to a log or an audit row.

export const customerStatementRuns = pgTable('customer_statement_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id').notNull(),
  asOf: date('as_of').notNull(),
  format: varchar('format', { length: 20 }).notNull(),
  startDate: date('start_date'),
  createdBy: uuid('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  companyIdx: index('idx_cs_runs_company').on(t.tenantId, t.companyId, t.createdAt),
}));

export const customerStatements = pgTable('customer_statements', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  runId: uuid('run_id').notNull(),
  companyId: uuid('company_id').notNull(),
  contactId: uuid('contact_id').notNull(),
  number: varchar('number', { length: 50 }).notNull(),
  asOf: date('as_of').notNull(),
  amountDue: decimal('amount_due', { precision: 19, scale: 4 }).notNull(),
  snapshot: jsonb('snapshot').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  numberIdx: uniqueIndex('uq_customer_statements_number').on(t.companyId, t.number),
  contactIdx: index('idx_customer_statements_contact').on(t.tenantId, t.contactId, t.createdAt),
  runIdx: index('idx_customer_statements_run').on(t.runId),
}));

export const customerStatementSendEvents = pgTable('customer_statement_send_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id').notNull(),
  customerStatementId: uuid('customer_statement_id').notNull(),
  method: varchar('method', { length: 10 }).$type<DocumentSendMethod>().notNull(),
  recipients: jsonb('recipients').$type<string[]>().notNull().default([]),
  sentAt: timestamp('sent_at', { withTimezone: true }).notNull().defaultNow(),
  userId: uuid('user_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  stmtIdx: index('idx_cs_send_events_statement').on(t.tenantId, t.customerStatementId, t.sentAt),
}));

export const customerStatementEmailQueue = pgTable('customer_statement_email_queue', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id').notNull(),
  customerStatementId: uuid('customer_statement_id').notNull(),
  toAddresses: jsonb('to_addresses').$type<string[]>().notNull().default([]),
  ccAddresses: jsonb('cc_addresses').$type<string[]>().notNull().default([]),
  bccAddresses: jsonb('bcc_addresses').$type<string[]>().notNull().default([]),
  subject: varchar('subject', { length: 500 }).notNull().default(''),
  body: text('body').notNull().default(''),
  userId: uuid('user_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  companyIdx: index('idx_cs_email_queue_company').on(t.tenantId, t.companyId, t.createdAt),
}));
