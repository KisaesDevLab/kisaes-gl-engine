// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import {
  pgTable,
  uuid,
  varchar,
  text,
  bigint,
  jsonb,
  timestamp,
  index,
} from 'drizzle-orm/pg-core';
import { tenants } from './auth.js';
import { companies } from './company.js';
import { portalContacts } from './portal-contacts.js';

// VIBE_MYBOOKS_PRACTICE_BUILD_PLAN Phase 10 — Question System Core.
// Three tables: questions, message threads, attachments. The
// transaction_id / split_line_id columns are intentionally
// soft-typed UUIDs (no FK) so a deleted transaction auto-resolves
// the question without a cascade — see Phase 10.8.

export const portalQuestions = pgTable('portal_questions', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  companyId: uuid('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
  // Soft-link — null when this is a "non-transaction" question (10.2).
  transactionId: uuid('transaction_id'),
  splitLineId: uuid('split_line_id'),
  assignedContactId: uuid('assigned_contact_id').references(() => portalContacts.id, { onDelete: 'set null' }),
  body: text('body').notNull(),
  // open | viewed | responded | resolved
  status: varchar('status', { length: 20 }).notNull().default('open'),
  createdBy: uuid('created_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  // null until the deferred-notification queue (10.3) flushes.
  notifiedAt: timestamp('notified_at', { withTimezone: true }),
  viewedAt: timestamp('viewed_at', { withTimezone: true }),
  respondedAt: timestamp('responded_at', { withTimezone: true }),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  // YYYY-MM (close period at creation). Used by 10.8 to group on the
  // bookkeeper inbox.
  currentClosePeriod: varchar('current_close_period', { length: 7 }),
}, (table) => ({
  tenantStatusIdx: index('idx_portal_questions_tenant_status').on(table.tenantId, table.status),
  tenantCompanyIdx: index('idx_portal_questions_tenant_company').on(table.tenantId, table.companyId),
  contactIdx: index('idx_portal_questions_contact').on(table.assignedContactId),
  transactionIdx: index('idx_portal_questions_transaction').on(table.transactionId),
  notifiedIdx: index('idx_portal_questions_notified').on(table.tenantId, table.notifiedAt),
}));

export const portalQuestionMessages = pgTable('portal_question_messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  questionId: uuid('question_id').notNull().references(() => portalQuestions.id, { onDelete: 'cascade' }),
  // 'bookkeeper' | 'contact'
  senderType: varchar('sender_type', { length: 20 }).notNull(),
  // staff user id when senderType=bookkeeper, portal contact id when senderType=contact
  senderId: uuid('sender_id').notNull(),
  body: text('body').notNull(),
  // [{ attachmentId, filename, mimeType, sizeBytes }]
  attachmentsJson: jsonb('attachments_json').notNull().default([]),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  questionIdx: index('idx_portal_question_messages_question').on(table.questionId, table.createdAt),
}));

export const portalQuestionAttachments = pgTable('portal_question_attachments', {
  id: uuid('id').primaryKey().defaultRandom(),
  questionId: uuid('question_id').notNull().references(() => portalQuestions.id, { onDelete: 'cascade' }),
  // Null for question-body attachments; set for message-level attachments.
  messageId: uuid('message_id').references(() => portalQuestionMessages.id, { onDelete: 'cascade' }),
  storageProvider: varchar('storage_provider', { length: 20 }).notNull().default('local'),
  storageKey: text('storage_key').notNull(),
  filename: varchar('filename', { length: 512 }).notNull(),
  mimeType: varchar('mime_type', { length: 120 }),
  sizeBytes: bigint('size_bytes', { mode: 'number' }),
  uploadedBy: uuid('uploaded_by').notNull(),
  uploadedByType: varchar('uploaded_by_type', { length: 20 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  questionIdx: index('idx_portal_question_attachments_question').on(table.questionId),
}));
