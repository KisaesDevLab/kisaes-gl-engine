// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import {
  pgTable,
  uuid,
  varchar,
  integer,
  jsonb,
  boolean,
  decimal,
  text,
  timestamp,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

// Local document-extraction module. One job per uploaded document; one page
// row per rendered page; one extracted_record per page (its validated,
// schema-conformant payload); one review_queue row per job that fell below
// the confidence floor or failed a consistency check.
//
// AUDIT INVARIANT (brief #4): file hash, page image refs, the exact prompt,
// the raw model response, the parsed payload, the model tag, and timestamps
// are all persisted here and never discarded.

export const extractionJobs = pgTable('extraction_jobs', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id'),
  docType: varchar('doc_type', { length: 20 }).notNull(),
  // pending | rendering | extracting | complete | needs_review | failed
  status: varchar('status', { length: 20 }).notNull().default('pending'),
  // sha256 hex of the original upload. Unique per tenant → idempotent
  // re-upload (the upload endpoint returns the existing job).
  fileHash: varchar('file_hash', { length: 64 }).notNull(),
  storageKey: varchar('storage_key', { length: 500 }),
  pageCount: integer('page_count'),
  modelTag: varchar('model_tag', { length: 100 }),
  error: text('error'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
}, (table) => ({
  byStatus: index('idx_extr_jobs_status').on(table.tenantId, table.status),
  byTenantHash: uniqueIndex('idx_extr_jobs_tenant_hash').on(table.tenantId, table.fileHash),
}));

export const extractionPages = pgTable('extraction_pages', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  jobId: uuid('job_id').notNull(),
  pageNo: integer('page_no').notNull(),
  imageRef: varchar('image_ref', { length: 500 }),
  // Exact schemaInstruction sent to the model — persisted for audit.
  prompt: text('prompt'),
  // Verbatim model response — persisted for audit, never discarded.
  rawResponse: text('raw_response'),
  pageConfidence: decimal('page_confidence', { precision: 3, scale: 2 }),
  // pending | done | review | failed
  status: varchar('status', { length: 20 }).notNull().default('pending'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  byJob: index('idx_extr_pages_job').on(table.tenantId, table.jobId),
  // One page row per (job, page) — makes render + extract idempotent.
  uniqJobPage: uniqueIndex('idx_extr_pages_job_page').on(table.jobId, table.pageNo),
}));

export const extractedRecords = pgTable('extracted_records', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  jobId: uuid('job_id').notNull(),
  pageNo: integer('page_no').notNull(),
  docType: varchar('doc_type', { length: 20 }).notNull(),
  payload: jsonb('payload'),
  confidence: decimal('confidence', { precision: 3, scale: 2 }),
  validated: boolean('validated').notNull().default(false),
  posted: boolean('posted').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  byJob: index('idx_extr_recs_job').on(table.tenantId, table.jobId),
  // One record per (job, page) → re-extraction upserts rather than dupes.
  uniqJobPage: uniqueIndex('idx_extr_recs_job_page').on(table.jobId, table.pageNo),
}));

export const reviewQueue = pgTable('extraction_review_queue', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  jobId: uuid('job_id').notNull(),
  reason: text('reason').notNull(),
  // open | resolved
  status: varchar('status', { length: 20 }).notNull().default('open'),
  reviewer: uuid('reviewer'),
  correction: jsonb('correction'),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  byStatus: index('idx_extr_review_status').on(table.tenantId, table.status),
  // One review row per job (the whole document routes to review).
  uniqJob: uniqueIndex('idx_extr_review_job').on(table.jobId),
}));
