// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { pgTable, uuid, varchar, text, integer, jsonb, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';

// AP Bill Capture queue (migration 0175). One row per uploaded vendor bill.
// Lifecycle: received -> processing -> ready -> entered, with side exits to
// failed (OCR error; still enterable by hand) and discarded. See the
// migration header and bill-capture.service.ts for the contract.
export const BILL_CAPTURE_STATUSES = ['received', 'processing', 'ready', 'failed', 'entered', 'discarded'] as const;
export type BillCaptureStatus = typeof BILL_CAPTURE_STATUSES[number];

export const BILL_CAPTURE_SOURCES = ['staff', 'portal'] as const;
export type BillCaptureSource = typeof BILL_CAPTURE_SOURCES[number];

export const EXTRACTION_SKIPPED_REASONS = ['ai_disabled', 'ai_function_disabled', 'ai_consent_blocked', 'unsupported_type'] as const;
export type ExtractionSkippedReason = typeof EXTRACTION_SKIPPED_REASONS[number];

export const billCaptures = pgTable('bill_captures', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id').notNull(),
  // The uploaded file: attachments.attachable_type='bill_capture',
  // attachable_id=this row's id until entered, then re-linked to the bill.
  attachmentId: uuid('attachment_id').notNull(),
  aiJobId: uuid('ai_job_id'),
  source: varchar('source', { length: 10 }).$type<BillCaptureSource>().notNull(),
  uploadedByUserId: uuid('uploaded_by_user_id'),
  uploadedByContactId: uuid('uploaded_by_contact_id'),
  status: varchar('status', { length: 20 }).$type<BillCaptureStatus>().notNull().default('received'),
  // BillOcrResult as returned by ai-bill-ocr.service (post vendor-match upgrade).
  extraction: jsonb('extraction'),
  extractionError: text('extraction_error'),
  extractionSkippedReason: varchar('extraction_skipped_reason', { length: 40 }).$type<ExtractionSkippedReason>(),
  processAttempts: integer('process_attempts').notNull().default(0),
  // Fuzzy vendor match when the OCR pipeline found no exact contact.
  suggestedContactId: uuid('suggested_contact_id'),
  duplicateOfTransactionId: uuid('duplicate_of_transaction_id'),
  duplicateMatch: varchar('duplicate_match', { length: 20 }).$type<'invoice_number' | 'total_date'>(),
  billId: uuid('bill_id'),
  contentSha256: varchar('content_sha256', { length: 64 }).notNull(),
  fileName: varchar('file_name', { length: 255 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  enteredAt: timestamp('entered_at', { withTimezone: true }),
}, (table) => ({
  queueIdx: index('idx_bill_captures_queue').on(table.tenantId, table.companyId, table.status, table.createdAt),
  tenantStatusIdx: index('idx_bill_captures_tenant_status').on(table.tenantId, table.status, table.createdAt),
  attachmentUq: uniqueIndex('uq_bill_captures_attachment').on(table.attachmentId),
  shaIdx: index('idx_bill_captures_sha').on(table.tenantId, table.companyId, table.contentSha256),
  contactIdx: index('idx_bill_captures_contact').on(table.uploadedByContactId, table.createdAt),
  billIdx: index('idx_bill_captures_bill').on(table.billId),
}));

export type BillCaptureRow = typeof billCaptures.$inferSelect;
export type NewBillCaptureRow = typeof billCaptures.$inferInsert;
