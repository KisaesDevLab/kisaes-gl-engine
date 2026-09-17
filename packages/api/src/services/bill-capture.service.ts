// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * AP Bill Capture — bill.com-style intake (migration 0175, AP_BILL_CAPTURE_V1).
 *
 * Staff (or a portal contact with bill_upload_access) drop vendor bills; each
 * becomes a `bill_captures` row whose file sits in `attachments` under
 * attachable_type 'bill_capture'. A BullMQ worker runs the existing bill-OCR
 * pipeline (ai-bill-ocr.service) and the row moves
 *
 *   received -> processing -> ready -> entered
 *
 * with side exits to `failed` (OCR error; still enterable by hand) and
 * `discarded`. AI availability is decided at UPLOAD time: when AI is off or
 * consent is missing the row goes straight to `ready` with
 * extraction_skipped_reason set, so the queue doubles as a manual-keying
 * surface with the image beside the form.
 *
 * enterBill() posts through bill.service.createBill — the same path as Enter
 * Bill — so the result flows into Pay Bills / check printing unchanged. The
 * ledger post is deliberately the LAST irreversible step; everything after it
 * (re-link attachment, mark entered, remember the vendor's lines mode) is
 * idempotent, so a crash between them leaves a real bill plus a capture that
 * can be re-marked, never a half-posted ledger.
 */

import crypto from 'crypto';
import { and, desc, eq, gt, inArray, ne, sql } from 'drizzle-orm';
import type { CreateBillInput, EnterBillCaptureInput } from '@kis-books/shared';
import { db } from '../db/index.js';
import {
  attachments,
  billCaptures,
  companies,
  contacts,
  portalContactCompanies,
  portalContacts,
  transactions,
  users,
  type BillCaptureRow,
  type BillCaptureSource,
  type BillCaptureStatus,
  type ExtractionSkippedReason,
} from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import { auditLog } from '../middleware/audit.js';
import { log } from '../utils/logger.js';
import * as attachmentService from './attachment.service.js';
import * as billService from './bill.service.js';
import * as contactsService from './contacts.service.js';
import * as systemEmail from './system-email.service.js';
import { getCompanySettings } from './portal-contact.service.js';
import { matchByName } from './ai-name-match.js';
import { verifyAttachmentContent } from '../routes/attachments.routes.js';
import {
  billOcrAvailability,
  extractBillFromAttachment,
  type BillOcrResult,
} from './ai-bill-ocr.service.js';

export const BILL_CAPTURE_ATTACHABLE_TYPE = 'bill_capture';
const WATCHDOG_MS = 30_000;
const MAX_VENDOR_CANDIDATES = 3;

export interface UploadedFile {
  originalname: string;
  mimetype: string;
  buffer: Buffer;
  size: number;
}

export interface CreateCapturesInput {
  tenantId: string;
  companyId: string;
  source: BillCaptureSource;
  userId?: string | null;
  contactId?: string | null;
  files: UploadedFile[];
}

export interface CreatedCapture {
  id: string;
  fileName: string;
  status: BillCaptureStatus;
  /** true when the same bytes were already in the queue; that row is returned. */
  duplicate: boolean;
}

export interface DuplicateHit {
  transactionId: string;
  txnNumber: string | null;
  matchedOn: 'invoice_number' | 'total_date';
}

export interface VendorDefaults {
  contactId: string;
  displayName: string;
  defaultExpenseAccountId: string | null;
  defaultTagId: string | null;
  defaultPaymentTerms: string | null;
  defaultTermsDays: number | null;
  billLinesMode: 'detailed' | 'single' | null;
}

export interface CaptureSummary {
  id: string;
  fileName: string;
  mimeType: string | null;
  source: BillCaptureSource;
  status: BillCaptureStatus;
  createdAt: Date;
  enteredAt: Date | null;
  vendorName: string | null;
  contactId: string | null;
  contactName: string | null;
  suggestedContactId: string | null;
  suggestedContactName: string | null;
  total: string | null;
  billDate: string | null;
  vendorInvoiceNumber: string | null;
  confidence: number | null;
  isDuplicate: boolean;
  duplicateOfTransactionId: string | null;
  billId: string | null;
  billTxnNumber: string | null;
  billVoided: boolean;
  extractionSkippedReason: ExtractionSkippedReason | null;
  extractionError: string | null;
  uploadedByName: string | null;
}

export interface CaptureDetail extends CaptureSummary {
  attachmentId: string;
  extraction: BillOcrResult | null;
  duplicate: DuplicateHit | null;
  vendorCandidates: Array<{ id: string; displayName: string }>;
  vendorDefaults: VendorDefaults | null;
}

// ─── helpers ────────────────────────────────────────────────────────

function extractionOf(row: BillCaptureRow): BillOcrResult | null {
  return (row.extraction as BillOcrResult | null) ?? null;
}

function isImageOrPdf(mime: string): boolean {
  return mime.startsWith('image/') || mime === 'application/pdf';
}

async function loadCapture(tenantId: string, companyId: string, id: string): Promise<BillCaptureRow> {
  const row = await db.query.billCaptures.findFirst({
    where: and(eq(billCaptures.tenantId, tenantId), eq(billCaptures.companyId, companyId), eq(billCaptures.id, id)),
  });
  if (!row) throw AppError.notFound('Bill capture not found');
  return row;
}

async function loadVendorRows(tenantId: string) {
  return db
    .select({
      id: contacts.id,
      displayName: contacts.displayName,
      contactType: contacts.contactType,
      isActive: contacts.isActive,
    })
    .from(contacts)
    .where(and(eq(contacts.tenantId, tenantId), inArray(contacts.contactType, ['vendor', 'both'])));
}

// ─── duplicate detection ────────────────────────────────────────────

/**
 * A posted, non-void bill for the same vendor with the same invoice number
 * (primary) or the same total on the same date (secondary). Void bills are
 * ignored so re-entering a voided bill is not flagged.
 */
export async function findDuplicateBill(
  tenantId: string,
  companyId: string,
  contactId: string | null,
  ext: { vendorInvoiceNumber: string | null; total: string | null; billDate: string | null },
): Promise<DuplicateHit | null> {
  if (!contactId) return null;
  const base = [
    eq(transactions.tenantId, tenantId),
    eq(transactions.companyId, companyId),
    eq(transactions.txnType, 'bill'),
    eq(transactions.contactId, contactId),
    ne(transactions.status, 'void'),
  ];
  const inv = ext.vendorInvoiceNumber?.trim();
  if (inv) {
    const [hit] = await db
      .select({ id: transactions.id, txnNumber: transactions.txnNumber })
      .from(transactions)
      .where(and(...base, sql`lower(trim(${transactions.vendorInvoiceNumber})) = lower(${inv})`))
      .limit(1);
    if (hit) return { transactionId: hit.id, txnNumber: hit.txnNumber ?? null, matchedOn: 'invoice_number' };
  }
  const total = ext.total != null && ext.total !== '' && Number.isFinite(Number(ext.total)) ? Number(ext.total).toFixed(4) : null;
  if (total && ext.billDate) {
    const [hit] = await db
      .select({ id: transactions.id, txnNumber: transactions.txnNumber })
      .from(transactions)
      .where(and(...base, sql`${transactions.total} = ${total}::numeric`, sql`${transactions.txnDate} = ${ext.billDate}::date`))
      .limit(1);
    if (hit) return { transactionId: hit.id, txnNumber: hit.txnNumber ?? null, matchedOn: 'total_date' };
  }
  return null;
}

// ─── upload ─────────────────────────────────────────────────────────

export async function createCapturesFromUpload(input: CreateCapturesInput): Promise<CreatedCapture[]> {
  const { tenantId, companyId, source } = input;
  if (source === 'staff' && !input.userId) throw AppError.badRequest('userId required for staff uploads');
  if (source === 'portal' && !input.contactId) throw AppError.badRequest('contactId required for portal uploads');
  if (input.files.length === 0) throw AppError.badRequest('No files uploaded');

  const company = await db.query.companies.findFirst({
    where: and(eq(companies.id, companyId), eq(companies.tenantId, tenantId)),
  });
  if (!company) throw AppError.notFound('Company not found');

  const availability = await billOcrAvailability(tenantId, companyId);
  const results: CreatedCapture[] = [];

  for (const file of input.files) {
    verifyAttachmentContent(file.mimetype, file.buffer);
    const sha = crypto.createHash('sha256').update(file.buffer).digest('hex');

    const existing = await db.query.billCaptures.findFirst({
      where: and(
        eq(billCaptures.tenantId, tenantId),
        eq(billCaptures.companyId, companyId),
        eq(billCaptures.contentSha256, sha),
        ne(billCaptures.status, 'discarded'),
      ),
    });
    if (existing) {
      results.push({ id: existing.id, fileName: existing.fileName, status: existing.status, duplicate: true });
      continue;
    }

    const captureId = crypto.randomUUID();
    const attachment = await attachmentService.upload(tenantId, file, BILL_CAPTURE_ATTACHABLE_TYPE, captureId, {
      companyId,
      uploadedByContactId: source === 'portal' ? input.contactId : null,
      skipAutoClassify: true,
    });
    if (!attachment) throw AppError.internal('Failed to store uploaded file');

    let status: BillCaptureStatus = 'received';
    let skipped: ExtractionSkippedReason | null = null;
    if (!isImageOrPdf(file.mimetype)) {
      status = 'ready';
      skipped = 'unsupported_type';
    } else if (!availability.ok) {
      status = 'ready';
      skipped = availability.reason;
    }

    const [row] = await db
      .insert(billCaptures)
      .values({
        id: captureId,
        tenantId,
        companyId,
        attachmentId: attachment.id,
        source,
        uploadedByUserId: source === 'staff' ? input.userId : null,
        uploadedByContactId: source === 'portal' ? input.contactId : null,
        status,
        extractionSkippedReason: skipped,
        contentSha256: sha,
        fileName: file.originalname.slice(0, 255),
      })
      .returning();
    if (!row) throw AppError.internal('Failed to create bill capture');

    await auditLog(tenantId, 'create', 'bill_capture', row.id, null, {
      fileName: row.fileName, source, status, skipped,
    }, input.userId ?? undefined);

    results.push({ id: row.id, fileName: row.fileName, status: row.status, duplicate: false });
    if (status === 'received') await dispatch(tenantId, row.id);
  }
  return results;
}

// ─── dispatch + worker entry ────────────────────────────────────────

/**
 * Hand the extraction to the worker via BullMQ. If the queue is unreachable
 * run it in-process; if a worker never claims it within the grace window the
 * watchdog runs it in-process too. Mirrors ai-statement-parser.startStatementParse.
 */
export async function dispatch(tenantId: string, captureId: string): Promise<void> {
  const [row] = await db
    .update(billCaptures)
    .set({ processAttempts: sql`${billCaptures.processAttempts} + 1`, updatedAt: new Date() })
    .where(and(eq(billCaptures.tenantId, tenantId), eq(billCaptures.id, captureId)))
    .returning({ attempt: billCaptures.processAttempts });
  const attempt = row?.attempt ?? 1;
  try {
    const { enqueueBillCapture } = await import('./extraction/queue.js');
    await enqueueBillCapture({ captureId, tenantId, attempt });
    scheduleWatchdog(tenantId, captureId);
  } catch (err) {
    log.warn({
      component: 'bill-capture',
      event: 'enqueue_failed_inprocess_fallback',
      captureId,
      message: err instanceof Error ? err.message : String(err),
    });
    void runBillCaptureJob(tenantId, captureId).catch(() => undefined);
  }
}

function scheduleWatchdog(tenantId: string, captureId: string): void {
  const timer = setTimeout(() => {
    void (async () => {
      try {
        const row = await db.query.billCaptures.findFirst({
          where: and(eq(billCaptures.tenantId, tenantId), eq(billCaptures.id, captureId)),
        });
        // Still 'received' => no worker claimed it. runBillCaptureJob claims
        // atomically, so a worker grabbing it in the same instant can't double-run.
        if (row && row.status === 'received') {
          log.warn({
            component: 'bill-capture',
            event: 'watchdog_inprocess_fallback',
            captureId,
            message: 'No worker claimed the bill-capture job within the grace window; processing in-process.',
          });
          await runBillCaptureJob(tenantId, captureId);
        }
      } catch {
        // Best-effort — runBillCaptureJob records any terminal failure itself.
      }
    })();
  }, WATCHDOG_MS);
  timer.unref?.();
}

/** Worker entry point. Safe to call twice: only a 'received' row is claimed. */
export async function runBillCaptureJob(tenantId: string, captureId: string): Promise<void> {
  const [claimed] = await db
    .update(billCaptures)
    .set({ status: 'processing', updatedAt: new Date() })
    .where(and(eq(billCaptures.tenantId, tenantId), eq(billCaptures.id, captureId), eq(billCaptures.status, 'received')))
    .returning();
  if (!claimed) return;

  try {
    const ext = await extractBillFromAttachment(tenantId, claimed.attachmentId);

    // Upgrade the pipeline's exact-name vendor probe with the fuzzy matcher.
    let suggestedContactId: string | null = null;
    if (!ext.contactId && ext.vendor) {
      const vendors = (await loadVendorRows(tenantId)).filter((v) => v.isActive !== false);
      const hit = matchByName(vendors, (v) => v.displayName, ext.vendor);
      if (hit) suggestedContactId = hit.id;
    }

    const dup = await findDuplicateBill(tenantId, claimed.companyId, ext.contactId ?? suggestedContactId, ext);

    await db
      .update(billCaptures)
      .set({
        status: 'ready',
        extraction: ext,
        extractionError: null,
        aiJobId: ext.jobId,
        suggestedContactId,
        duplicateOfTransactionId: dup?.transactionId ?? null,
        duplicateMatch: dup?.matchedOn ?? null,
        updatedAt: new Date(),
      })
      .where(and(eq(billCaptures.tenantId, tenantId), eq(billCaptures.id, captureId)));
  } catch (err) {
    const code = err instanceof AppError ? err.code : undefined;
    const message = err instanceof Error ? err.message : String(err);
    // Consent revoked / AI switched off between upload and run: not a
    // failure, the row is simply not scanned (same as the upload-time gate).
    const skipped: ExtractionSkippedReason | null =
      code === 'ai_consent_blocked' ? 'ai_consent_blocked'
        : code === 'ai_function_disabled' ? 'ai_function_disabled'
          : /AI processing is not enabled/i.test(message) ? 'ai_disabled'
            : null;
    await db
      .update(billCaptures)
      .set(skipped
        ? { status: 'ready', extractionSkippedReason: skipped, extractionError: null, updatedAt: new Date() }
        : { status: 'failed', extractionError: message.slice(0, 2000), updatedAt: new Date() })
      .where(and(eq(billCaptures.tenantId, tenantId), eq(billCaptures.id, captureId)));
    log.warn({ component: 'bill-capture', event: skipped ? 'extraction_skipped' : 'extraction_failed', captureId, message });
  }
}

// ─── read ───────────────────────────────────────────────────────────

async function decorate(tenantId: string, rows: BillCaptureRow[]): Promise<CaptureSummary[]> {
  if (rows.length === 0) return [];
  const contactIds = new Set<string>();
  const billIds: string[] = [];
  const userIds: string[] = [];
  const portalIds: string[] = [];
  const attachmentIds: string[] = [];
  for (const r of rows) {
    const ext = extractionOf(r);
    if (ext?.contactId) contactIds.add(ext.contactId);
    if (r.suggestedContactId) contactIds.add(r.suggestedContactId);
    if (r.billId) billIds.push(r.billId);
    if (r.uploadedByUserId) userIds.push(r.uploadedByUserId);
    if (r.uploadedByContactId) portalIds.push(r.uploadedByContactId);
    attachmentIds.push(r.attachmentId);
  }
  const [contactRows, billRows, userRows, portalRows, attachRows] = await Promise.all([
    contactIds.size
      ? db.select({ id: contacts.id, displayName: contacts.displayName }).from(contacts)
        .where(and(eq(contacts.tenantId, tenantId), inArray(contacts.id, [...contactIds])))
      : Promise.resolve([]),
    billIds.length
      ? db.select({ id: transactions.id, txnNumber: transactions.txnNumber, status: transactions.status }).from(transactions)
        .where(and(eq(transactions.tenantId, tenantId), inArray(transactions.id, billIds)))
      : Promise.resolve([]),
    userIds.length
      ? db.select({ id: users.id, displayName: users.displayName, email: users.email }).from(users)
        .where(inArray(users.id, userIds))
      : Promise.resolve([]),
    portalIds.length
      ? db.select({ id: portalContacts.id, firstName: portalContacts.firstName, lastName: portalContacts.lastName, email: portalContacts.email })
        .from(portalContacts).where(and(eq(portalContacts.tenantId, tenantId), inArray(portalContacts.id, portalIds)))
      : Promise.resolve([]),
    db.select({ id: attachments.id, mimeType: attachments.mimeType }).from(attachments)
      .where(and(eq(attachments.tenantId, tenantId), inArray(attachments.id, attachmentIds))),
  ]);
  const contactName = new Map(contactRows.map((c) => [c.id, c.displayName]));
  const bill = new Map(billRows.map((b) => [b.id, b]));
  const userName = new Map(userRows.map((u) => [u.id, u.displayName || u.email]));
  const portalName = new Map(portalRows.map((p) => [p.id, [p.firstName, p.lastName].filter(Boolean).join(' ') || p.email]));
  const mime = new Map(attachRows.map((a) => [a.id, a.mimeType]));

  return rows.map((r) => {
    const ext = extractionOf(r);
    const b = r.billId ? bill.get(r.billId) : undefined;
    return {
      id: r.id,
      fileName: r.fileName,
      mimeType: mime.get(r.attachmentId) ?? null,
      source: r.source,
      status: r.status,
      createdAt: r.createdAt,
      enteredAt: r.enteredAt,
      vendorName: ext?.vendor ?? null,
      contactId: ext?.contactId ?? null,
      contactName: ext?.contactId ? contactName.get(ext.contactId) ?? null : null,
      suggestedContactId: r.suggestedContactId,
      suggestedContactName: r.suggestedContactId ? contactName.get(r.suggestedContactId) ?? null : null,
      total: ext?.total ?? null,
      billDate: ext?.billDate ?? null,
      vendorInvoiceNumber: ext?.vendorInvoiceNumber ?? null,
      confidence: ext?.confidence ?? null,
      isDuplicate: !!r.duplicateOfTransactionId,
      duplicateOfTransactionId: r.duplicateOfTransactionId,
      billId: r.billId,
      billTxnNumber: b?.txnNumber ?? null,
      billVoided: b?.status === 'void',
      extractionSkippedReason: r.extractionSkippedReason ?? null,
      extractionError: r.extractionError,
      uploadedByName: r.uploadedByUserId
        ? userName.get(r.uploadedByUserId) ?? null
        : r.uploadedByContactId ? portalName.get(r.uploadedByContactId) ?? null : null,
    };
  });
}

export async function list(
  tenantId: string,
  companyId: string,
  opts: { status?: BillCaptureStatus; limit?: number; offset?: number } = {},
): Promise<{ captures: CaptureSummary[]; total: number; counts: Record<BillCaptureStatus, number> }> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);
  const scope = and(eq(billCaptures.tenantId, tenantId), eq(billCaptures.companyId, companyId));
  const where = opts.status ? and(scope, eq(billCaptures.status, opts.status)) : scope;

  const [rows, [countRow], countRows] = await Promise.all([
    db.select().from(billCaptures).where(where).orderBy(desc(billCaptures.createdAt)).limit(limit).offset(offset),
    db.select({ count: sql<number>`count(*)::int` }).from(billCaptures).where(where),
    db.select({ status: billCaptures.status, count: sql<number>`count(*)::int` }).from(billCaptures).where(scope).groupBy(billCaptures.status),
  ]);
  const counts: Record<BillCaptureStatus, number> = { received: 0, processing: 0, ready: 0, failed: 0, entered: 0, discarded: 0 };
  for (const c of countRows) counts[c.status] = Number(c.count);
  return { captures: await decorate(tenantId, rows), total: Number(countRow?.count ?? 0), counts };
}

async function vendorDefaultsFor(tenantId: string, contactId: string | null): Promise<VendorDefaults | null> {
  if (!contactId) return null;
  const c = await db.query.contacts.findFirst({ where: and(eq(contacts.tenantId, tenantId), eq(contacts.id, contactId)) });
  if (!c) return null;
  return {
    contactId: c.id,
    displayName: c.displayName,
    defaultExpenseAccountId: c.defaultExpenseAccountId ?? null,
    defaultTagId: c.defaultTagId ?? null,
    defaultPaymentTerms: c.defaultPaymentTerms ?? null,
    defaultTermsDays: c.defaultTermsDays ?? null,
    billLinesMode: c.billLinesMode ?? null,
  };
}

/** Oldest actionable capture after this one, wrapping to the oldest overall. */
async function nextReadyAfter(tenantId: string, companyId: string, row: BillCaptureRow): Promise<string | null> {
  const actionable = inArray(billCaptures.status, ['ready', 'failed']);
  const scope = and(eq(billCaptures.tenantId, tenantId), eq(billCaptures.companyId, companyId), actionable, ne(billCaptures.id, row.id));
  const [after] = await db.select({ id: billCaptures.id }).from(billCaptures)
    .where(and(scope, gt(billCaptures.createdAt, row.createdAt))).orderBy(billCaptures.createdAt).limit(1);
  if (after) return after.id;
  const [first] = await db.select({ id: billCaptures.id }).from(billCaptures).where(scope).orderBy(billCaptures.createdAt).limit(1);
  return first?.id ?? null;
}

export async function get(
  tenantId: string,
  companyId: string,
  id: string,
): Promise<{ capture: CaptureDetail; nextReadyId: string | null }> {
  const row = await loadCapture(tenantId, companyId, id);
  const [summary] = await decorate(tenantId, [row]);
  const ext = extractionOf(row);

  let vendorCandidates: Array<{ id: string; displayName: string }> = [];
  if (!ext?.contactId && !row.suggestedContactId && ext?.vendor) {
    const token = ext.vendor.trim().split(/\s+/)[0] ?? '';
    if (token.length >= 3) {
      vendorCandidates = (await loadVendorRows(tenantId))
        .filter((v) => v.isActive !== false && v.displayName.toLowerCase().includes(token.toLowerCase()))
        .slice(0, MAX_VENDOR_CANDIDATES)
        .map((v) => ({ id: v.id, displayName: v.displayName }));
    }
  }

  const duplicate: DuplicateHit | null = row.duplicateOfTransactionId
    ? await (async () => {
      const t = await db.query.transactions.findFirst({
        where: and(eq(transactions.tenantId, tenantId), eq(transactions.id, row.duplicateOfTransactionId!)),
      });
      return t ? { transactionId: t.id, txnNumber: t.txnNumber ?? null, matchedOn: row.duplicateMatch ?? 'invoice_number' } : null;
    })()
    : null;

  const capture: CaptureDetail = {
    ...summary!,
    attachmentId: row.attachmentId,
    extraction: ext,
    duplicate,
    vendorCandidates,
    vendorDefaults: await vendorDefaultsFor(tenantId, ext?.contactId ?? row.suggestedContactId ?? null),
  };
  return { capture, nextReadyId: await nextReadyAfter(tenantId, companyId, row) };
}

/** Attachment stream for the review pane; scoped through the capture so a
 *  bills-only user needs no `attachments` permission. */
export async function file(tenantId: string, companyId: string, id: string) {
  const row = await loadCapture(tenantId, companyId, id);
  return attachmentService.download(tenantId, row.attachmentId);
}

// ─── mutations ──────────────────────────────────────────────────────

export async function discard(tenantId: string, companyId: string, id: string, userId?: string): Promise<CaptureSummary> {
  const row = await loadCapture(tenantId, companyId, id);
  if (row.status === 'entered') throw AppError.conflict('This capture was already entered as a bill', 'BILL_CAPTURE_ALREADY_ENTERED', { billId: row.billId });
  if (row.status !== 'discarded') {
    await db.update(billCaptures).set({ status: 'discarded', updatedAt: new Date() })
      .where(and(eq(billCaptures.tenantId, tenantId), eq(billCaptures.id, id)));
    await auditLog(tenantId, 'update', 'bill_capture', id, { status: row.status }, { status: 'discarded' }, userId);
  }
  const [s] = await decorate(tenantId, [{ ...row, status: 'discarded' }]);
  return s!;
}

export async function reprocess(tenantId: string, companyId: string, id: string, userId?: string): Promise<CaptureSummary> {
  const row = await loadCapture(tenantId, companyId, id);
  if (row.status !== 'ready' && row.status !== 'failed') {
    throw AppError.conflict(`Cannot re-read a capture in status '${row.status}'`, 'BILL_CAPTURE_BAD_STATE');
  }
  const attachment = await attachmentService.getById(tenantId, row.attachmentId);
  if (!isImageOrPdf(attachment.mimeType || '')) throw AppError.badRequest('Only images and PDFs can be read');
  const availability = await billOcrAvailability(tenantId, companyId);
  if (!availability.ok) {
    throw AppError.badRequest(
      availability.reason === 'ai_consent_blocked'
        ? 'AI consent is not granted for this company, so the bill cannot be read automatically.'
        : 'Bill OCR is not enabled on this installation.',
      availability.reason,
    );
  }
  await db.update(billCaptures).set({
    status: 'received',
    extraction: null,
    extractionError: null,
    extractionSkippedReason: null,
    suggestedContactId: null,
    duplicateOfTransactionId: null,
    duplicateMatch: null,
    updatedAt: new Date(),
  }).where(and(eq(billCaptures.tenantId, tenantId), eq(billCaptures.id, id)));
  await auditLog(tenantId, 'update', 'bill_capture', id, { status: row.status }, { status: 'received', reprocess: true }, userId);
  await dispatch(tenantId, id);
  const [s] = await decorate(tenantId, [{ ...row, status: 'received', extraction: null, extractionError: null }]);
  return s!;
}

export async function enterBill(
  tenantId: string,
  companyId: string,
  id: string,
  input: EnterBillCaptureInput,
  userId?: string,
) {
  const row = await loadCapture(tenantId, companyId, id);
  if (row.status === 'entered') {
    throw AppError.conflict('This capture was already entered as a bill', 'BILL_CAPTURE_ALREADY_ENTERED', { billId: row.billId });
  }
  if (row.status === 'discarded') throw AppError.conflict('This capture was discarded', 'BILL_CAPTURE_DISCARDED');

  // 1. Resolve the vendor (existing, or create from the bill's letterhead).
  let contactId = input.contactId ?? null;
  let createdVendorId: string | null = null;
  if (!contactId) {
    const nv = input.newVendor!;
    const created = await contactsService.create(tenantId, {
      contactType: 'vendor',
      displayName: nv.displayName,
      email: nv.email ?? '',
      phone: nv.phone ?? null,
      billingLine1: nv.billingLine1 ?? null,
      billingLine2: nv.billingLine2 ?? null,
      billingCity: nv.billingCity ?? null,
      billingState: nv.billingState ?? null,
      billingZip: nv.billingZip ?? null,
      ...(nv.billingCountry ? { billingCountry: nv.billingCountry } : {}),
      defaultExpenseAccountId: nv.defaultExpenseAccountId ?? null,
    }, userId);
    contactId = created.id;
    createdVendorId = created.id;
  }

  // 2. Server-authoritative duplicate check on the SUBMITTED values.
  const total = input.lines.reduce((s, l) => s + Number(l.amount || 0), 0).toFixed(2);
  const dup = await findDuplicateBill(tenantId, companyId, contactId, {
    vendorInvoiceNumber: input.vendorInvoiceNumber ?? null,
    total,
    billDate: input.txnDate,
  });
  if (dup && !input.overrideDuplicate) {
    throw AppError.conflict('A bill with this invoice number (or total and date) already exists for this vendor', 'BILL_CAPTURE_DUPLICATE', { ...dup });
  }

  // 3. Post — the last irreversible step.
  const billInput: CreateBillInput = {
    contactId,
    txnDate: input.txnDate,
    ...(input.dueDate ? { dueDate: input.dueDate } : {}),
    ...(input.paymentTerms ? { paymentTerms: input.paymentTerms } : {}),
    ...(input.termsDays != null ? { termsDays: input.termsDays } : {}),
    ...(input.vendorInvoiceNumber ? { vendorInvoiceNumber: input.vendorInvoiceNumber } : {}),
    ...(input.memo ? { memo: input.memo } : {}),
    ...(input.internalNotes ? { internalNotes: input.internalNotes } : {}),
    lines: input.lines,
  };
  const bill = await billService.createBill(tenantId, billInput, userId, companyId);

  // 4. Idempotent follow-ups.
  await attachmentService.linkAttachment(tenantId, row.attachmentId, 'bill', bill.id);
  await db.update(billCaptures).set({
    status: 'entered',
    billId: bill.id,
    enteredAt: new Date(),
    updatedAt: new Date(),
  }).where(and(eq(billCaptures.tenantId, tenantId), eq(billCaptures.id, id)));
  await db.update(contacts).set({ billLinesMode: input.linesMode })
    .where(and(eq(contacts.tenantId, tenantId), eq(contacts.id, contactId)));
  await auditLog(tenantId, 'update', 'bill_capture', id, { status: row.status }, {
    status: 'entered', billId: bill.id, linesMode: input.linesMode, createdVendorId, overrodeDuplicate: !!dup,
  }, userId);

  const [capture] = await decorate(tenantId, [{ ...row, status: 'entered', billId: bill.id, enteredAt: new Date() }]);
  return { bill, capture: capture!, createdVendorId };
}

// ─── portal ─────────────────────────────────────────────────────────

export async function assertBillUploadAccess(tenantId: string, contactId: string, companyId: string): Promise<void> {
  const link = await db
    .select({ billUploadAccess: portalContactCompanies.billUploadAccess })
    .from(portalContactCompanies)
    .innerJoin(companies, eq(companies.id, portalContactCompanies.companyId))
    .where(and(
      eq(portalContactCompanies.contactId, contactId),
      eq(portalContactCompanies.companyId, companyId),
      eq(companies.tenantId, tenantId),
    ))
    .limit(1);
  if (link.length === 0 || !link[0]?.billUploadAccess) {
    throw AppError.forbidden('Bill uploads are not enabled for your account', 'BILL_UPLOAD_NOT_ENABLED');
  }
}

export type PortalCaptureStatus = 'received' | 'processing' | 'entered' | 'closed';

export async function listForPortalContact(
  tenantId: string,
  companyId: string,
  contactId: string,
): Promise<Array<{ id: string; fileName: string; status: PortalCaptureStatus; createdAt: Date; enteredAt: Date | null }>> {
  const rows = await db.select({
    id: billCaptures.id,
    fileName: billCaptures.fileName,
    status: billCaptures.status,
    createdAt: billCaptures.createdAt,
    enteredAt: billCaptures.enteredAt,
  }).from(billCaptures)
    .where(and(
      eq(billCaptures.tenantId, tenantId),
      eq(billCaptures.companyId, companyId),
      eq(billCaptures.uploadedByContactId, contactId),
    ))
    .orderBy(desc(billCaptures.createdAt))
    .limit(200);
  // Coarse, amount-free view: the client should not learn whether OCR
  // failed or what staff are doing with the queue.
  const coarse = (s: BillCaptureStatus): PortalCaptureStatus =>
    s === 'received' ? 'received'
      : s === 'entered' ? 'entered'
        : s === 'discarded' ? 'closed'
          : 'processing';
  return rows.map((r) => ({ ...r, status: coarse(r.status) }));
}

/** One email per upload request. Recipient = the company's bill-pay notify
 *  user, else active owners (capped). Never throws. */
export async function notifyStaffOfPortalBillUpload(params: {
  tenantId: string;
  companyId: string;
  contactId: string;
  fileCount: number;
}): Promise<void> {
  try {
    const [contact, settings, company] = await Promise.all([
      db.query.portalContacts.findFirst({ where: and(eq(portalContacts.tenantId, params.tenantId), eq(portalContacts.id, params.contactId)) }),
      getCompanySettings(params.tenantId, params.companyId).catch(() => null),
      db.query.companies.findFirst({ where: eq(companies.id, params.companyId) }),
    ]);
    let recipients: string[] = [];
    const notifyUserId = settings?.billPayNotifyUserId ?? null;
    if (notifyUserId) {
      const u = await db.query.users.findFirst({ where: and(eq(users.id, notifyUserId), eq(users.tenantId, params.tenantId)) });
      if (u && u.isActive) recipients = [u.email];
    }
    if (recipients.length === 0) {
      const owners = await db.select({ email: users.email }).from(users)
        .where(and(eq(users.tenantId, params.tenantId), eq(users.role, 'owner'), eq(users.isActive, true)));
      recipients = owners.slice(0, 5).map((o) => o.email);
    }
    if (recipients.length === 0) return;

    const who = [contact?.firstName, contact?.lastName].filter(Boolean).join(' ') || contact?.email || 'A portal user';
    const companyName = company?.businessName ?? 'a client company';
    const baseUrl = process.env['CORS_ORIGIN'] || 'http://localhost:5173';
    const n = params.fileCount;
    const results = await Promise.allSettled(recipients.map((to) => systemEmail.sendActionEmail({
      to,
      subject: `${n} bill${n === 1 ? '' : 's'} uploaded — ${companyName}`,
      bodyText: `${who}${contact?.email ? ` (${contact.email})` : ''} uploaded ${n} vendor bill${n === 1 ? '' : 's'} in the client portal for ${companyName}.\n\nThey are being read now and will appear under Payables → Bill Capture for review.`,
      cta: { label: 'Open Bill Capture', url: `${baseUrl}/bills/capture` },
    })));
    for (const r of results) {
      if (r.status === 'rejected') {
        log.warn({ component: 'bill-capture', event: 'notify_email_failed', err: r.reason instanceof Error ? r.reason.message : String(r.reason), tenantId: params.tenantId });
      }
    }
  } catch (err) {
    log.warn({ component: 'bill-capture', event: 'notify_failed', err: err instanceof Error ? err.message : String(err), tenantId: params.tenantId });
  }
}
