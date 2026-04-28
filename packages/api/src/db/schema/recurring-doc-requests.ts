// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import {
  pgTable,
  uuid,
  varchar,
  text,
  boolean,
  integer,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { tenants } from './auth.js';
import { companies } from './company.js';
import { portalContacts } from './portal-contacts.js';

// RECURRING_DOC_REQUESTS_V1 — calendar-cadence document requests.
// Two tables:
//   recurring_document_requests = the standing rule ("ask client X for
//   their bank statement on the 3rd of every month").
//   document_requests           = one row per issued cycle. Used by the
//   reminder scan loop (trigger_type='doc_request') and by the portal
//   upload UI for fulfilment.

export const recurringDocumentRequests = pgTable('recurring_document_requests', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  // null → applies tenant-wide (rare; usually scoped to a single company).
  companyId: uuid('company_id').references(() => companies.id, { onDelete: 'cascade' }),
  // The portal contact who owes the document.
  contactId: uuid('contact_id').notNull().references(() => portalContacts.id, { onDelete: 'cascade' }),
  // bank_statement | cc_statement | payroll_report | receipt_batch | other
  documentType: varchar('document_type', { length: 40 }).notNull(),
  description: text('description').notNull(),
  // monthly | quarterly | annually (v1 fully supports `monthly`; the
  // others slot in by extending computeNextIssueAt).
  frequency: varchar('frequency', { length: 20 }).notNull().default('monthly'),
  intervalValue: integer('interval_value').notNull().default(1),
  // 1–28 to avoid DST/short-month surprises; the service clamps the
  // requested day at issuance time. nullable for non-monthly cadences
  // that don't use this concept.
  dayOfMonth: integer('day_of_month'),
  // RECURRING_CRON_V1 — switches the issuance arithmetic between the
  // existing frequency model (monthly/quarterly/annually) and a cron
  // expression. Default 'frequency' so pre-flag rows keep firing.
  cadenceKind: varchar('cadence_kind', { length: 20 }).notNull().default('frequency'),
  cronExpression: varchar('cron_expression', { length: 120 }),
  cronTimezone: varchar('cron_timezone', { length: 64 }),
  // Computed at create + each issued cycle. The scheduler picks rows
  // where next_issue_at <= now() AND active.
  nextIssueAt: timestamp('next_issue_at', { withTimezone: true }).notNull(),
  lastIssuedAt: timestamp('last_issued_at', { withTimezone: true }),
  // Sets due_date on each issued document_requests row.
  dueDaysAfterIssue: integer('due_days_after_issue').notNull().default(7),
  // Reuses the [3,7,14] semantics from reminderSchedules.cadenceDays.
  // [] disables nudges entirely; the opening email is the only send.
  cadenceDays: jsonb('cadence_days').notNull().default([3, 7, 14]),
  active: boolean('active').notNull().default(true),
  // Optional hard stop. The scheduler skips rows where
  // ends_at IS NOT NULL AND ends_at <= now().
  endsAt: timestamp('ends_at', { withTimezone: true }),
  // STATEMENT_AUTO_IMPORT_V1 — pre-bind "uploads against this rule
  // route into this bank connection". Soft FK (no Drizzle reference,
  // since bank_connections lives in a different schema file and we
  // already have a circular-import budget); the migration creates
  // the FK constraint with ON DELETE SET NULL.
  bankConnectionId: uuid('bank_connection_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  tenantActiveNextIdx: index('idx_recur_doc_req_tenant_active_next')
    .on(table.tenantId, table.active, table.nextIssueAt),
  contactIdx: index('idx_recur_doc_req_contact').on(table.contactId, table.active),
}));

export const documentRequests = pgTable('document_requests', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  companyId: uuid('company_id').references(() => companies.id, { onDelete: 'cascade' }),
  // null when this is a one-off request created manually (a future
  // route can support that without a recurring rule). When set, this
  // row was issued by the recurring scheduler.
  recurringId: uuid('recurring_id').references(() => recurringDocumentRequests.id, { onDelete: 'set null' }),
  contactId: uuid('contact_id').notNull().references(() => portalContacts.id, { onDelete: 'cascade' }),
  // Denormalised from the parent rule so the email + UI don't have to
  // re-join, and so cancelling the rule doesn't blank existing rows.
  documentType: varchar('document_type', { length: 40 }).notNull(),
  description: text('description').notNull(),
  // Human-readable label printed in the email — e.g. "2026-04" so
  // April's bank statement is unambiguous when the contact has three
  // months of pending requests.
  periodLabel: varchar('period_label', { length: 40 }).notNull(),
  // Calendar moment of issuance — used as the cadence anchor by the
  // doc_request scan branch (analogous to portalQuestions.notifiedAt).
  requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
  dueDate: timestamp('due_date', { withTimezone: true }),
  // pending | submitted | cancelled | superseded
  status: varchar('status', { length: 20 }).notNull().default('pending'),
  submittedAt: timestamp('submitted_at', { withTimezone: true }),
  // FK to portal_receipts when the request was fulfilled by an upload.
  // Soft FK (added in the migration as a column, not as a Drizzle
  // reference, to avoid a circular import with portal-receipts).
  submittedReceiptId: uuid('submitted_receipt_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  tenantStatusReqIdx: index('idx_doc_req_tenant_status_req')
    .on(table.tenantId, table.status, table.requestedAt),
  contactStatusIdx: index('idx_doc_req_contact_status').on(table.contactId, table.status),
  // Idempotency for the scheduler — one document_requests row per
  // (recurring rule, period). The service uses this to guard against
  // double-issue when two ticks race past the advisory lock.
  recurringPeriodUq: uniqueIndex('uq_doc_req_recurring_period')
    .on(table.recurringId, table.periodLabel),
}));
