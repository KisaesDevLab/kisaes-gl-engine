// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Entity shapes for the document-extraction module, as returned by the API
// (timestamps serialized to ISO strings; decimals as strings). The DocType
// union lives in schemas/extraction.ts (single source of truth) and is
// re-exported here for convenience.

// DocType is exported from schemas/extraction.js (the single source of
// truth). We import it type-only here and do NOT re-export it, to avoid an
// ambiguous `export *` collision in the package barrel.
import type { DocType } from '../schemas/extraction.js';

export type ExtractionJobStatus =
  | 'pending' // job row created, original stored, render job enqueued
  | 'rendering' // PDF→page images in flight
  | 'extracting' // per-page model calls in flight
  | 'complete' // all pages extracted, validated, persisted
  | 'needs_review' // ≥1 page/record flagged below the confidence floor
  | 'failed'; // render/extract failed after retries

export type ReviewStatus = 'open' | 'resolved';

export interface ExtractionJob {
  id: string;
  tenantId: string;
  companyId: string | null;
  docType: DocType;
  status: ExtractionJobStatus;
  /** sha256 of the original upload — unique per tenant for idempotency. */
  fileHash: string;
  storageKey: string | null;
  pageCount: number | null;
  modelTag: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface ExtractionPage {
  id: string;
  tenantId: string;
  jobId: string;
  pageNo: number;
  /** Storage key of the rendered page image. */
  imageRef: string | null;
  /** Exact schemaInstruction sent to the model — persisted for audit. */
  prompt: string | null;
  /** Raw model response, verbatim — persisted for audit, never discarded. */
  rawResponse: string | null;
  pageConfidence: string | null;
  status: string;
  createdAt: string;
}

export interface ExtractedRecord {
  id: string;
  tenantId: string;
  jobId: string;
  pageNo: number;
  docType: DocType;
  /** Validated, schema-conformant payload (jsonb). */
  payload: unknown;
  confidence: string | null;
  validated: boolean;
  posted: boolean;
  createdAt: string;
}

export interface ReviewQueueItem {
  id: string;
  tenantId: string;
  jobId: string;
  reason: string;
  status: ReviewStatus;
  reviewer: string | null;
  /** Human correction payload, when resolved with edits. */
  correction: unknown | null;
  resolvedAt: string | null;
  createdAt: string;
}
