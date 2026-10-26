// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { pgTable, uuid, varchar, char, integer, jsonb, timestamp, date, decimal, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import type { DocumentDraftKind, DocumentDraftReader, DocumentDraftStatus } from '@kis-books/shared';

// Document drafts (U-92, migration 0233): a client's reading of one vendor
// document, waiting to be converted into a bill, card charge, check or cash
// expense. Never posts by itself; see document-draft.service.ts.
export const documentDrafts = pgTable('document_drafts', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id').notNull(),
  // The draft attachment (attachable_type 'draft'); nulled when the file is
  // deleted after the draft is closed. content_sha256 keeps the claim.
  attachmentId: uuid('attachment_id'),
  contentSha256: char('content_sha256', { length: 64 }).notNull(),
  kind: varchar('kind', { length: 20 }).$type<DocumentDraftKind>().notNull().default('unknown'),
  status: varchar('status', { length: 20 }).$type<DocumentDraftStatus>().notNull().default('new'),
  reader: varchar('reader', { length: 20 }).$type<DocumentDraftReader>(),
  fields: jsonb('fields').$type<Record<string, unknown>>().notNull().default({}),
  lines: jsonb('lines').$type<unknown[]>().notNull().default([]),
  checks: jsonb('checks').$type<unknown[]>().notNull().default([]),
  failureReason: varchar('failure_reason', { length: 40 }),
  suggestedContactId: uuid('suggested_contact_id'),
  docReference: varchar('doc_reference', { length: 100 }),
  docTotal: decimal('doc_total', { precision: 19, scale: 4 }),
  docDate: date('doc_date'),
  convertedTransactionId: uuid('converted_transaction_id'),
  convertedType: varchar('converted_type', { length: 30 }),
  convertedAt: timestamp('converted_at', { withTimezone: true }),
  convertedBy: uuid('converted_by'),
  discardedAt: timestamp('discarded_at', { withTimezone: true }),
  createdBy: uuid('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  claimUq: uniqueIndex('uq_document_drafts_claim').on(table.tenantId, table.companyId, table.contentSha256).where(sql`status <> 'discarded'`),
  queueIdx: index('idx_document_drafts_queue').on(table.tenantId, table.companyId, table.status, table.createdAt),
  attachmentIdx: index('idx_document_drafts_attachment').on(table.attachmentId),
  contactIdx: index('idx_document_drafts_contact').on(table.tenantId, table.companyId, table.suggestedContactId),
}));

export type DocumentDraftRow = typeof documentDrafts.$inferSelect;

// Vendor layout templates (U-92, migration 0233): where one vendor's
// documents of one layout print each field, learned by the client.
export const vendorLayoutTemplates = pgTable('vendor_layout_templates', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id').notNull(),
  contactId: uuid('contact_id').notNull(),
  fingerprint: varchar('fingerprint', { length: 128 }).notNull(),
  fieldRegions: jsonb('field_regions').$type<Record<string, unknown>>().notNull().default({}),
  lineTable: jsonb('line_table').$type<Record<string, unknown> | null>(),
  samples: integer('samples').notNull().default(1),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  createdBy: uuid('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  layoutUq: uniqueIndex('uq_vendor_layout_templates').on(table.companyId, table.contactId, table.fingerprint),
  companyIdx: index('idx_vendor_layout_templates_company').on(table.tenantId, table.companyId, table.contactId),
}));

export type VendorLayoutTemplateRow = typeof vendorLayoutTemplates.$inferSelect;
