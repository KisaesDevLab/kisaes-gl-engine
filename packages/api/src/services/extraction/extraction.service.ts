// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Document-extraction orchestration service. Owns job lifecycle + the two
// processing steps the BullMQ workers invoke:
//
//   createJob          hash + dedup + store original + enqueue render (API)
//   processRender      PDF→page images, persist pages, enqueue per-page extract
//   processExtractPage one page → Qwen vision → validate → persist or flag
//   finalizeIfComplete set job status once every page is accounted for
//
// Idempotency: jobs are unique per (tenant, file_hash); pages and records are
// unique per (job, page) and upserted; review rows unique per job. A retried
// BullMQ job therefore re-runs safely without duplicating rows.

import crypto from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import { type DocType } from '@kis-books/shared';
import { db } from '../../db/index.js';
import { extractionJobs, extractionPages, extractedRecords, reviewQueue } from '../../db/schema/index.js';
import { AppError } from '../../utils/errors.js';
import { env } from '../../config/env.js';
import * as storage from './storage.service.js';
import { renderToPages } from './pdf-render.service.js';
import { extractImage } from './qwen-client.service.js';
import { buildSchemaInstruction, EXTRACTION_SYSTEM_PROMPT } from './prompts.js';
import { getResolvedExtractionOptions } from './options.js';
import { validateExtractedPage, checkCrossPageConsistency } from './validate.js';
import { enqueueRender, enqueueExtract } from './queue.js';

type ExtractionJobRow = typeof extractionJobs.$inferSelect;

export interface CreateJobInput {
  docType: DocType;
  companyId?: string | null;
  file: { buffer: Buffer; mimeType: string; originalname: string };
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

async function findByHash(tenantId: string, fileHash: string): Promise<ExtractionJobRow | undefined> {
  return db.query.extractionJobs.findFirst({
    where: and(eq(extractionJobs.tenantId, tenantId), eq(extractionJobs.fileHash, fileHash)),
  });
}

/**
 * Create a job from an uploaded file: hash for idempotency, store the
 * original, enqueue the render step. Re-uploading identical bytes returns the
 * existing job (duplicate: true) and enqueues nothing.
 */
export async function createJob(
  tenantId: string,
  input: CreateJobInput,
): Promise<{ job: ExtractionJobRow; duplicate: boolean }> {
  const fileHash = crypto.createHash('sha256').update(input.file.buffer).digest('hex');

  const existing = await findByHash(tenantId, fileHash);
  if (existing) return { job: existing, duplicate: true };

  let job: ExtractionJobRow;
  try {
    const [created] = await db
      .insert(extractionJobs)
      .values({
        tenantId,
        companyId: input.companyId ?? null,
        docType: input.docType,
        status: 'pending',
        fileHash,
        modelTag: env.EXTRACTION_MODEL_TAG,
      })
      .returning();
    if (!created) throw AppError.internal('Failed to create extraction job');
    job = created;
  } catch (err) {
    // Concurrent upload of the same bytes — the unique (tenant, hash) index
    // raced us. Return the row the other request inserted.
    if (isUniqueViolation(err)) {
      const dup = await findByHash(tenantId, fileHash);
      if (dup) return { job: dup, duplicate: true };
    }
    throw err;
  }

  const key = storage.originalKey(tenantId, job.id, storage.extForMime(input.file.mimeType));
  try {
    await storage.storeBytes(tenantId, key, input.file.buffer, input.file.mimeType);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await db
      .update(extractionJobs)
      .set({ status: 'failed', error: `store_original_failed: ${msg}`, updatedAt: new Date() })
      .where(eq(extractionJobs.id, job.id));
    throw err;
  }

  const [updated] = await db
    .update(extractionJobs)
    .set({ storageKey: key, updatedAt: new Date() })
    .where(eq(extractionJobs.id, job.id))
    .returning();

  await enqueueRender({ jobId: job.id, tenantId });
  return { job: updated ?? job, duplicate: false };
}

async function loadJob(tenantId: string, jobId: string): Promise<ExtractionJobRow> {
  const job = await db.query.extractionJobs.findFirst({
    where: and(eq(extractionJobs.tenantId, tenantId), eq(extractionJobs.id, jobId)),
  });
  if (!job) throw AppError.notFound('Extraction job not found');
  return job;
}

export async function getJob(tenantId: string, jobId: string) {
  const job = await loadJob(tenantId, jobId);
  const [pages, records, reviews] = await Promise.all([
    db.select().from(extractionPages).where(and(eq(extractionPages.tenantId, tenantId), eq(extractionPages.jobId, jobId))).orderBy(extractionPages.pageNo),
    db.select().from(extractedRecords).where(and(eq(extractedRecords.tenantId, tenantId), eq(extractedRecords.jobId, jobId))).orderBy(extractedRecords.pageNo),
    db.select().from(reviewQueue).where(and(eq(reviewQueue.tenantId, tenantId), eq(reviewQueue.jobId, jobId))),
  ]);
  return { job, pages, records, review: reviews };
}

export interface ListJobsFilters {
  status?: string | undefined;
  docType?: DocType | undefined;
  limit: number;
  offset: number;
}

export async function listJobs(tenantId: string, filters: ListJobsFilters) {
  const conds = [eq(extractionJobs.tenantId, tenantId)];
  if (filters.status) conds.push(eq(extractionJobs.status, filters.status));
  if (filters.docType) conds.push(eq(extractionJobs.docType, filters.docType));
  const where = and(...conds);

  const [data, totalRes] = await Promise.all([
    db.select().from(extractionJobs).where(where).orderBy(desc(extractionJobs.createdAt)).limit(filters.limit).offset(filters.offset),
    db.select({ count: sql<number>`count(*)::int` }).from(extractionJobs).where(where),
  ]);
  return { data, total: totalRes[0]?.count ?? 0 };
}

async function setJobStatus(jobId: string, status: string, patch: Partial<typeof extractionJobs.$inferInsert> = {}): Promise<void> {
  await db.update(extractionJobs).set({ status, updatedAt: new Date(), ...patch }).where(eq(extractionJobs.id, jobId));
}

async function flagReview(tenantId: string, jobId: string, reason: string): Promise<void> {
  await db
    .insert(reviewQueue)
    .values({ tenantId, jobId, reason, status: 'open' })
    .onConflictDoUpdate({ target: reviewQueue.jobId, set: { reason, status: 'open' } });
}

/**
 * Render step: rasterize the original to page images, persist page rows
 * (idempotent upsert), and enqueue an extract job per page. Deterministic
 * failures (malformed PDF, unsupported type) route to review without
 * rethrowing — retrying wouldn't help; transient failures rethrow for
 * BullMQ's exponential backoff.
 */
export async function processRender(tenantId: string, jobId: string): Promise<void> {
  const job = await loadJob(tenantId, jobId);
  if (job.status === 'complete' || job.status === 'needs_review') return; // already finalized
  if (!job.storageKey) throw new Error(`extraction job ${jobId} has no stored original`);

  await setJobStatus(jobId, 'rendering');
  const original = await storage.loadBytes(tenantId, job.storageKey);
  const mimeType = storage.mimeFromStorageKey(job.storageKey);

  const renderOpts = await getResolvedExtractionOptions();
  let pages;
  try {
    pages = await renderToPages(original, mimeType, {
      dpi: renderOpts.renderDpi,
      grayscale: renderOpts.grayscale,
    });
  } catch (err) {
    if (err instanceof AppError) {
      const msg = err.message;
      await setJobStatus(jobId, 'needs_review', { error: msg });
      await flagReview(tenantId, jobId, `render_failed: ${msg}`);
      return; // terminal — do not retry a deterministic render failure
    }
    throw err; // transient (storage hiccup) — let BullMQ retry
  }

  for (const page of pages) {
    const imageRef = await storage.storePageImage(tenantId, jobId, page);
    await db
      .insert(extractionPages)
      .values({ tenantId, jobId, pageNo: page.pageNo, imageRef, status: 'pending' })
      .onConflictDoUpdate({
        target: [extractionPages.jobId, extractionPages.pageNo],
        set: { imageRef, status: 'pending' },
      });
  }

  await setJobStatus(jobId, 'extracting', { pageCount: pages.length });
  for (const page of pages) {
    await enqueueExtract({ jobId, tenantId, pageNo: page.pageNo });
  }
}

/**
 * Extract step for one page: render image → Qwen vision → validate → persist
 * an extracted_record (validated when it passes) or flag the document for
 * review. Always persists the exact prompt + raw response for audit.
 */
export async function processExtractPage(tenantId: string, jobId: string, pageNo: number): Promise<void> {
  const job = await loadJob(tenantId, jobId);
  const page = await db.query.extractionPages.findFirst({
    where: and(eq(extractionPages.tenantId, tenantId), eq(extractionPages.jobId, jobId), eq(extractionPages.pageNo, pageNo)),
  });
  if (!page) throw new Error(`extraction page ${jobId}/${pageNo} not found`);
  if (page.status === 'done' || page.status === 'review') {
    await finalizeIfComplete(tenantId, jobId);
    return; // idempotent: already processed
  }
  if (!page.imageRef) throw new Error(`extraction page ${jobId}/${pageNo} has no image`);

  const docType = job.docType as DocType;
  const systemPrompt = EXTRACTION_SYSTEM_PROMPT;
  const userPrompt = buildSchemaInstruction(docType);

  const imageBuf = await storage.loadBytes(tenantId, page.imageRef);
  const base64 = imageBuf.toString('base64');
  const mimeType = storage.mimeFromStorageKey(page.imageRef);

  let extraction;
  try {
    extraction = await extractImage({ base64, mimeType, systemPrompt, userPrompt });
  } catch (err) {
    if (err instanceof AppError) {
      // Deterministic (endpoint not configured, cloud-vision blocked) — route
      // to review rather than spinning BullMQ retries against a config error.
      await db
        .update(extractionPages)
        .set({ prompt: userPrompt, status: 'review', pageConfidence: '0' })
        .where(eq(extractionPages.id, page.id));
      await flagReview(tenantId, jobId, `extract_error: ${err.message}`);
      await finalizeIfComplete(tenantId, jobId);
      return;
    }
    throw err; // transient model/network error — BullMQ retries
  }

  const { confidenceThreshold } = await getResolvedExtractionOptions();
  const validation = validateExtractedPage(docType, extraction.parsed, {
    threshold: confidenceThreshold,
    parseError: extraction.parseError,
  });

  await db
    .update(extractionPages)
    .set({
      prompt: userPrompt,
      rawResponse: extraction.text,
      pageConfidence: validation.pageConfidence.toFixed(2),
      status: validation.ok ? 'done' : 'review',
    })
    .where(eq(extractionPages.id, page.id));

  await db
    .insert(extractedRecords)
    .values({
      tenantId,
      jobId,
      pageNo,
      docType,
      payload: validation.payload,
      confidence: validation.minConfidence.toFixed(2),
      validated: validation.ok,
      posted: false, // never auto-post; posting to the ledger is a later step
    })
    .onConflictDoUpdate({
      target: [extractedRecords.jobId, extractedRecords.pageNo],
      set: {
        docType,
        payload: validation.payload,
        confidence: validation.minConfidence.toFixed(2),
        validated: validation.ok,
      },
    });

  if (!validation.ok) {
    await flagReview(tenantId, jobId, validation.reasons.join('; ') || 'low_confidence');
  }

  await finalizeIfComplete(tenantId, jobId);
}

/**
 * Once every page is accounted for, run cross-page consistency and set the
 * job's terminal status. Safe to call repeatedly / concurrently — the final
 * UPDATE is idempotent.
 */
async function finalizeIfComplete(tenantId: string, jobId: string): Promise<void> {
  const job = await loadJob(tenantId, jobId);
  if (job.pageCount == null) return; // render hasn't recorded page count yet

  const pages = await db
    .select({ status: extractionPages.status })
    .from(extractionPages)
    .where(and(eq(extractionPages.tenantId, tenantId), eq(extractionPages.jobId, jobId)));

  const accounted = pages.filter((p) => p.status === 'done' || p.status === 'review' || p.status === 'failed');
  if (accounted.length < job.pageCount) return; // still extracting

  const records = await db
    .select({ payload: extractedRecords.payload })
    .from(extractedRecords)
    .where(and(eq(extractedRecords.tenantId, tenantId), eq(extractedRecords.jobId, jobId)))
    .orderBy(extractedRecords.pageNo);

  const crossFlags = checkCrossPageConsistency(job.docType as DocType, records.map((r) => r.payload));
  if (crossFlags.length > 0) await flagReview(tenantId, jobId, crossFlags.join('; '));

  const anyReview = pages.some((p) => p.status === 'review') || crossFlags.length > 0;
  const allFailed = pages.every((p) => p.status === 'failed');
  const status = allFailed ? 'failed' : anyReview ? 'needs_review' : 'complete';

  await db
    .update(extractionJobs)
    .set({ status, completedAt: new Date(), updatedAt: new Date() })
    .where(eq(extractionJobs.id, jobId));
}

// ── Human-in-the-loop review ──────────────────────────────────────────────

type ExtractedRecordRow = typeof extractedRecords.$inferSelect;

/**
 * Items needing review for a job: the open review_queue row(s), the pages
 * flagged 'review', and the not-yet-validated records (with their raw
 * payloads) the reviewer will correct.
 */
export async function getReviewItems(tenantId: string, jobId: string) {
  await loadJob(tenantId, jobId); // tenant-scoped existence check
  const [review, pages, records] = await Promise.all([
    db.select().from(reviewQueue).where(and(eq(reviewQueue.tenantId, tenantId), eq(reviewQueue.jobId, jobId))),
    db.select().from(extractionPages).where(and(eq(extractionPages.tenantId, tenantId), eq(extractionPages.jobId, jobId), eq(extractionPages.status, 'review'))).orderBy(extractionPages.pageNo),
    db.select().from(extractedRecords).where(and(eq(extractedRecords.tenantId, tenantId), eq(extractedRecords.jobId, jobId), eq(extractedRecords.validated, false))).orderBy(extractedRecords.pageNo),
  ]);
  return { review, pages, records };
}

export interface SubmitReviewInput {
  correction?: Record<string, unknown> | undefined;
  post: boolean;
  note?: string | undefined;
}

/**
 * Apply a human correction to one extracted record: replace its payload (if a
 * correction was supplied), mark it validated and (optionally) posted, and
 * mark its page done. When the last unvalidated record is resolved, the
 * job's review_queue row is closed and the job marked complete.
 */
export async function submitReview(
  tenantId: string,
  jobId: string,
  recordId: string,
  input: SubmitReviewInput,
  userId?: string,
): Promise<{ before: ExtractedRecordRow; after: ExtractedRecordRow }> {
  await loadJob(tenantId, jobId);
  const before = await db.query.extractedRecords.findFirst({
    where: and(eq(extractedRecords.tenantId, tenantId), eq(extractedRecords.jobId, jobId), eq(extractedRecords.id, recordId)),
  });
  if (!before) throw AppError.notFound('Extracted record not found');

  const [after] = await db
    .update(extractedRecords)
    .set({
      payload: input.correction ?? before.payload,
      validated: true,
      posted: input.post,
    })
    .where(eq(extractedRecords.id, recordId))
    .returning();
  if (!after) throw AppError.internal('Failed to update extracted record');

  await db
    .update(extractionPages)
    .set({ status: 'done' })
    .where(and(eq(extractionPages.tenantId, tenantId), eq(extractionPages.jobId, jobId), eq(extractionPages.pageNo, before.pageNo)));

  const [remaining] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(extractedRecords)
    .where(and(eq(extractedRecords.tenantId, tenantId), eq(extractedRecords.jobId, jobId), eq(extractedRecords.validated, false)));

  if ((remaining?.count ?? 0) === 0) {
    await db
      .update(reviewQueue)
      .set({ status: 'resolved', reviewer: userId ?? null, correction: input.correction ?? null, resolvedAt: new Date() })
      .where(and(eq(reviewQueue.tenantId, tenantId), eq(reviewQueue.jobId, jobId), eq(reviewQueue.status, 'open')));
    await db
      .update(extractionJobs)
      .set({ status: 'complete', completedAt: new Date(), updatedAt: new Date() })
      .where(eq(extractionJobs.id, jobId));
  }

  return { before, after };
}
