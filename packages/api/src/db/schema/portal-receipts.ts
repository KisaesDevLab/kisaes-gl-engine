// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import {
  pgTable,
  uuid,
  varchar,
  text,
  decimal,
  date,
  timestamp,
  bigint,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';
import { tenants } from './auth.js';
import { companies } from './company.js';

// VIBE_MYBOOKS_PRACTICE_BUILD_PLAN Phase 18 — receipt inbox.
// One table; OCR results are stored as JSONB so the schema can
// evolve as the OCR pipeline returns new fields.

export const portalReceipts = pgTable('portal_receipts', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  companyId: uuid('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
  // Where the upload came from: 'portal' (contact) or 'practice' (bookkeeper)
  // — drives which UX flow surfaces it.
  captureSource: varchar('capture_source', { length: 20 }).notNull().default('portal'),
  uploadedBy: uuid('uploaded_by').notNull(),
  uploadedByType: varchar('uploaded_by_type', { length: 20 }).notNull(),
  storageKey: text('storage_key').notNull(),
  filename: varchar('filename', { length: 512 }).notNull(),
  mimeType: varchar('mime_type', { length: 120 }),
  sizeBytes: bigint('size_bytes', { mode: 'number' }),
  // Hash of file content — used for dupe detection.
  contentSha256: varchar('content_sha256', { length: 64 }),
  // OCR-extracted fields. Same field names as ai-receipt-ocr returns.
  extractedVendor: varchar('extracted_vendor', { length: 255 }),
  extractedDate: date('extracted_date'),
  extractedTotal: decimal('extracted_total', { precision: 19, scale: 4 }),
  extractedTax: decimal('extracted_tax', { precision: 19, scale: 4 }),
  extractedLineItems: jsonb('extracted_line_items'),
  extractedRaw: jsonb('extracted_raw'),
  // Lifecycle: pending_ocr | ocr_failed | unmatched | auto_matched | manually_matched | dismissed
  status: varchar('status', { length: 30 }).notNull().default('pending_ocr'),
  // FK soft-link — null until matched/attached.
  matchedTransactionId: uuid('matched_transaction_id'),
  matchScore: decimal('match_score', { precision: 5, scale: 4 }),
  // RECURRING_DOC_REQUESTS_V1 — when set, the upload fulfilled a
  // standing document request. The receipts service flips the linked
  // document_requests row to status='submitted' and stamps
  // submitted_receipt_id back. Soft FK (no Drizzle .references()) to
  // avoid a circular schema import; the migration adds the constraint.
  documentRequestId: uuid('document_request_id'),
  capturedAt: timestamp('captured_at', { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  tenantStatusIdx: index('idx_portal_receipts_tenant_status').on(table.tenantId, table.status),
  tenantCompanyIdx: index('idx_portal_receipts_tenant_company').on(table.tenantId, table.companyId),
  contentHashIdx: index('idx_portal_receipts_content_hash').on(table.tenantId, table.contentSha256),
}));
