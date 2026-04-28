// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import crypto from 'node:crypto';
import { and, desc, eq, gte, lte, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  portalReceipts,
  transactions,
  contacts,
  companies,
  documentRequests,
} from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import { getProviderForTenant } from './storage/storage-provider.factory.js';
import { auditLog } from '../middleware/audit.js';

// VIBE_MYBOOKS_PRACTICE_BUILD_PLAN Phase 18 — Receipt Inbox.
// Upload pipeline + match algorithm + inbox. The OCR step itself
// uses the existing AI receipt OCR service (ai-receipt-ocr.service);
// here we only persist what comes back.

const MATCH_AMOUNT_TOLERANCE = 0.02; // ±2%
const MATCH_DATE_TOLERANCE_DAYS = 7;
const AUTO_MATCH_THRESHOLD = 0.85;

function sha256(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export interface UploadInput {
  tenantId: string;
  companyId: string;
  uploadedBy: string;
  uploadedByType: 'bookkeeper' | 'contact';
  captureSource: 'portal' | 'practice';
  filename: string;
  mimeType: string;
  buffer: Buffer;
  capturedAt?: Date;
  // RECURRING_DOC_REQUESTS_V1 — when set, the upload fulfils a
  // standing document_requests row. The service flips that row to
  // status='submitted' + stamps submitted_receipt_id back.
  documentRequestId?: string;
}

export async function uploadReceipt(input: UploadInput): Promise<{
  id: string;
  duplicate: boolean;
}> {
  const co = await db.query.companies.findFirst({
    where: and(eq(companies.tenantId, input.tenantId), eq(companies.id, input.companyId)),
  });
  if (!co) throw AppError.notFound('Company not found');

  const hash = sha256(input.buffer);

  // 18.8 — duplicate detection within inbox by content hash.
  const dup = await db.query.portalReceipts.findFirst({
    where: and(
      eq(portalReceipts.tenantId, input.tenantId),
      eq(portalReceipts.contentSha256, hash),
    ),
  });
  if (dup) {
    // Even on a content-hash dupe, still link the dupe to the
    // document request the user was trying to fulfil — otherwise
    // re-uploading "the same statement" appears to do nothing on
    // the practice dashboard.
    if (input.documentRequestId) {
      const recurDoc = await import('./recurring-doc-request.service.js');
      await recurDoc.markFulfilledByReceipt(input.tenantId, input.documentRequestId, dup.id);
      await db
        .update(portalReceipts)
        .set({ documentRequestId: input.documentRequestId, updatedAt: new Date() })
        .where(eq(portalReceipts.id, dup.id));
    }
    return { id: dup.id, duplicate: true };
  }

  const provider = await getProviderForTenant(input.tenantId);
  const storageKey = `receipts/${input.tenantId}/${crypto.randomUUID()}-${input.filename.replace(/[^A-Za-z0-9._-]/g, '_')}`;
  await provider.upload(storageKey, input.buffer, {
    fileName: input.filename,
    mimeType: input.mimeType,
    sizeBytes: input.buffer.length,
  });

  const inserted = await db
    .insert(portalReceipts)
    .values({
      tenantId: input.tenantId,
      companyId: input.companyId,
      captureSource: input.captureSource,
      uploadedBy: input.uploadedBy,
      uploadedByType: input.uploadedByType,
      storageKey,
      filename: input.filename,
      mimeType: input.mimeType,
      sizeBytes: input.buffer.length,
      contentSha256: hash,
      status: 'pending_ocr',
      capturedAt: input.capturedAt ?? new Date(),
      documentRequestId: input.documentRequestId ?? null,
    })
    .returning({ id: portalReceipts.id });
  const row = inserted[0];
  if (!row) throw AppError.badRequest('Insert failed');

  await auditLog(input.tenantId, 'create', 'portal_receipt', row.id, null, {
    companyId: input.companyId,
    filename: input.filename,
    sizeBytes: input.buffer.length,
    captureSource: input.captureSource,
    documentRequestId: input.documentRequestId ?? null,
  }, input.uploadedBy);

  if (input.documentRequestId) {
    // STATEMENT_AUTO_IMPORT_V1 — when the doc-request asks for a bank
    // statement, route the upload into the bank-feed import pipeline
    // instead of (or in addition to) the receipts inbox. Falls back
    // to the regular receipt-OCR flow when the document type isn't a
    // statement OR the feature flag is off for this tenant.
    const recurDoc = await import('./recurring-doc-request.service.js');
    const docReq = await db.query.documentRequests.findFirst({
      where: and(
        eq(documentRequests.tenantId, input.tenantId),
        eq(documentRequests.id, input.documentRequestId),
      ),
    });

    const stmt = await import('./statement-routing.service.js');
    if (docReq && stmt.isStatementDocumentType(docReq.documentType)) {
      const flags = await import('./feature-flags.service.js');
      const enabled = await flags.isEnabled(input.tenantId, 'STATEMENT_AUTO_IMPORT_V1');
      if (enabled) {
        await stmt.routeStatementUpload({
          tenantId: input.tenantId,
          receiptId: row.id,
          documentRequestId: docReq.id,
          contactId: docReq.contactId,
          recurringId: docReq.recurringId,
          documentType: docReq.documentType,
        });
        // routeStatementUpload handles markFulfilledByReceipt itself
        // on the imported path; on awaits_routing we leave the
        // request pending so the CPA's manual-route action can close
        // it.
        return { id: row.id, duplicate: false };
      }
    }

    // Default path: just mark the request fulfilled (matches today's
    // behavior for non-statement document types).
    await recurDoc.markFulfilledByReceipt(input.tenantId, input.documentRequestId, row.id);
  }

  return { id: row.id, duplicate: false };
}

// 18.4 — patch the OCR result onto an existing receipt + run the
// matching algorithm. Caller is the OCR worker (or the bookkeeper
// "rerun OCR" action).
export interface OcrResult {
  vendor?: string | null;
  date?: string | null;
  total?: string | number | null;
  tax?: string | number | null;
  lineItems?: unknown;
  raw?: unknown;
  failed?: boolean;
}

export async function applyOcrResult(
  tenantId: string,
  receiptId: string,
  result: OcrResult,
): Promise<{ matched: boolean; transactionId?: string; score?: number }> {
  const receipt = await db.query.portalReceipts.findFirst({
    where: and(eq(portalReceipts.tenantId, tenantId), eq(portalReceipts.id, receiptId)),
  });
  if (!receipt) throw AppError.notFound('Receipt not found');

  if (result.failed) {
    await db
      .update(portalReceipts)
      .set({ status: 'ocr_failed', updatedAt: new Date() })
      .where(eq(portalReceipts.id, receiptId));
    return { matched: false };
  }

  const total = result.total !== null && result.total !== undefined ? String(result.total) : null;
  const tax = result.tax !== null && result.tax !== undefined ? String(result.tax) : null;

  await db
    .update(portalReceipts)
    .set({
      extractedVendor: result.vendor ?? null,
      extractedDate: result.date ?? null,
      extractedTotal: total,
      extractedTax: tax,
      extractedLineItems: (result.lineItems ?? null) as never,
      extractedRaw: (result.raw ?? null) as never,
      status: 'unmatched',
      updatedAt: new Date(),
    })
    .where(eq(portalReceipts.id, receiptId));

  // 18.5 — try to auto-match.
  const candidates = await suggestMatches(tenantId, receiptId);
  const top = candidates[0];
  if (top && top.score >= AUTO_MATCH_THRESHOLD) {
    await db
      .update(portalReceipts)
      .set({
        status: 'auto_matched',
        matchedTransactionId: top.transactionId,
        matchScore: top.score.toFixed(4),
        updatedAt: new Date(),
      })
      .where(eq(portalReceipts.id, receiptId));
    return { matched: true, transactionId: top.transactionId, score: top.score };
  }
  return { matched: false };
}

export interface MatchCandidate {
  transactionId: string;
  vendor: string | null;
  amount: string;
  txnDate: string;
  score: number;
  reasons: string[];
}

function fuzzy(a: string | null | undefined, b: string | null | undefined): number {
  if (!a || !b) return 0;
  const aN = a.toLowerCase().replace(/[^a-z0-9]/g, '');
  const bN = b.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (aN === bN) return 1;
  if (aN.includes(bN) || bN.includes(aN)) return 0.8;
  // Trivial token overlap.
  const aT = new Set(aN.match(/.{1,3}/g) ?? []);
  const bT = new Set(bN.match(/.{1,3}/g) ?? []);
  const overlap = [...aT].filter((t) => bT.has(t)).length;
  const max = Math.max(aT.size, bT.size, 1);
  return overlap / max;
}

export async function suggestMatches(
  tenantId: string,
  receiptId: string,
): Promise<MatchCandidate[]> {
  const receipt = await db.query.portalReceipts.findFirst({
    where: and(eq(portalReceipts.tenantId, tenantId), eq(portalReceipts.id, receiptId)),
  });
  if (!receipt) throw AppError.notFound('Receipt not found');
  if (!receipt.extractedTotal) return [];

  const target = Number(receipt.extractedTotal);
  if (!Number.isFinite(target) || target <= 0) return [];

  const min = (target * (1 - MATCH_AMOUNT_TOLERANCE)).toFixed(4);
  const max = (target * (1 + MATCH_AMOUNT_TOLERANCE)).toFixed(4);

  // Date window.
  let dateMin: string;
  let dateMax: string;
  if (receipt.extractedDate) {
    const base = new Date(`${receipt.extractedDate}T00:00:00Z`);
    dateMin = new Date(base.getTime() - MATCH_DATE_TOLERANCE_DAYS * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    dateMax = new Date(base.getTime() + MATCH_DATE_TOLERANCE_DAYS * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
  } else {
    // No date — search the last 60 days.
    const today = new Date();
    dateMax = today.toISOString().slice(0, 10);
    dateMin = new Date(today.getTime() - 60 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  }

  const txns = await db
    .select({
      id: transactions.id,
      total: transactions.total,
      txnDate: transactions.txnDate,
      contactId: transactions.contactId,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.tenantId, tenantId),
        sql`${transactions.total} BETWEEN ${min} AND ${max}`,
        gte(transactions.txnDate, dateMin),
        lte(transactions.txnDate, dateMax),
        sql`${transactions.voidedAt} IS NULL`,
      ),
    )
    .limit(50);

  if (txns.length === 0) return [];

  // Pull vendor names for all candidate txns.
  const contactIds = [...new Set(txns.map((t) => t.contactId).filter((x): x is string => !!x))];
  const contactMap = new Map<string, string>();
  if (contactIds.length > 0) {
    const cs = await db
      .select({ id: contacts.id, name: contacts.displayName })
      .from(contacts)
      .where(
        and(
          eq(contacts.tenantId, tenantId),
          sql`${contacts.id} = ANY(${contactIds}::uuid[])`,
        ),
      );
    for (const c of cs) contactMap.set(c.id, c.name);
  }

  const candidates: MatchCandidate[] = [];
  for (const txn of txns) {
    const txnTotal = Number(txn.total ?? 0);
    const amountScore = 1 - Math.min(Math.abs(txnTotal - target) / target, 1);
    const txnDateMs = new Date(`${txn.txnDate}T00:00:00Z`).getTime();
    const baseDate = receipt.extractedDate
      ? new Date(`${receipt.extractedDate}T00:00:00Z`).getTime()
      : Date.now();
    const dayDelta = Math.abs(txnDateMs - baseDate) / (24 * 60 * 60 * 1000);
    const dateScore = Math.max(0, 1 - dayDelta / MATCH_DATE_TOLERANCE_DAYS);
    const vendor = txn.contactId ? contactMap.get(txn.contactId) ?? null : null;
    const vendorScore = fuzzy(vendor, receipt.extractedVendor);
    // Weighted blend per the build plan: amount 0.5, date 0.3, vendor 0.2.
    const score = amountScore * 0.5 + dateScore * 0.3 + vendorScore * 0.2;

    const reasons: string[] = [];
    if (amountScore >= 0.95) reasons.push('amount match');
    if (dateScore >= 0.9) reasons.push('date close');
    if (vendorScore >= 0.7) reasons.push('vendor match');

    candidates.push({
      transactionId: txn.id,
      vendor,
      amount: String(txnTotal.toFixed(2)),
      txnDate: txn.txnDate,
      score,
      reasons,
    });
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, 10);
}

export async function attachToTransaction(
  tenantId: string,
  bookkeeperUserId: string,
  receiptId: string,
  transactionId: string,
): Promise<void> {
  const receipt = await db.query.portalReceipts.findFirst({
    where: and(eq(portalReceipts.tenantId, tenantId), eq(portalReceipts.id, receiptId)),
  });
  if (!receipt) throw AppError.notFound('Receipt not found');
  const txn = await db.query.transactions.findFirst({
    where: and(eq(transactions.tenantId, tenantId), eq(transactions.id, transactionId)),
  });
  if (!txn) throw AppError.notFound('Transaction not found');

  await db
    .update(portalReceipts)
    .set({
      status: 'manually_matched',
      matchedTransactionId: transactionId,
      matchScore: '1.0000',
      updatedAt: new Date(),
    })
    .where(eq(portalReceipts.id, receiptId));

  await auditLog(tenantId, 'update', 'portal_receipt_attach', receiptId, null, { transactionId }, bookkeeperUserId);
}

export async function dismissReceipt(
  tenantId: string,
  bookkeeperUserId: string,
  receiptId: string,
): Promise<void> {
  await db
    .update(portalReceipts)
    .set({ status: 'dismissed', updatedAt: new Date() })
    .where(and(eq(portalReceipts.tenantId, tenantId), eq(portalReceipts.id, receiptId)));
  await auditLog(tenantId, 'update', 'portal_receipt_dismiss', receiptId, null, null, bookkeeperUserId);
}

export interface InboxRow {
  id: string;
  filename: string;
  status: string;
  capturedAt: Date;
  uploadedBy: string;
  captureSource: string;
  extractedVendor: string | null;
  extractedTotal: string | null;
  extractedDate: string | null;
  matchedTransactionId: string | null;
  matchScore: string | null;
  companyId: string;
  companyName: string;
}

export async function listInbox(
  tenantId: string,
  opts: { status?: string; companyId?: string } = {},
): Promise<InboxRow[]> {
  const filters: ReturnType<typeof eq>[] = [eq(portalReceipts.tenantId, tenantId)];
  if (opts.status && opts.status !== 'all') {
    filters.push(eq(portalReceipts.status, opts.status));
  }
  if (opts.companyId) filters.push(eq(portalReceipts.companyId, opts.companyId));

  const rows = await db
    .select({
      id: portalReceipts.id,
      filename: portalReceipts.filename,
      status: portalReceipts.status,
      capturedAt: portalReceipts.capturedAt,
      uploadedBy: portalReceipts.uploadedBy,
      captureSource: portalReceipts.captureSource,
      extractedVendor: portalReceipts.extractedVendor,
      extractedTotal: portalReceipts.extractedTotal,
      extractedDate: portalReceipts.extractedDate,
      matchedTransactionId: portalReceipts.matchedTransactionId,
      matchScore: portalReceipts.matchScore,
      companyId: portalReceipts.companyId,
      companyName: companies.businessName,
    })
    .from(portalReceipts)
    .innerJoin(companies, eq(portalReceipts.companyId, companies.id))
    .where(and(...filters))
    .orderBy(desc(portalReceipts.capturedAt))
    .limit(200);

  return rows;
}

export async function getReceipt(tenantId: string, id: string) {
  const r = await db.query.portalReceipts.findFirst({
    where: and(eq(portalReceipts.tenantId, tenantId), eq(portalReceipts.id, id)),
  });
  if (!r) throw AppError.notFound('Receipt not found');
  return r;
}
