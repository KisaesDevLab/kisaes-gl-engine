// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { Router } from 'express';
import { z } from 'zod';
import {
  createBillSchema, updateBillSchema, billFiltersSchema, payableBillsQuerySchema, voidTransactionSchema, billTermsDatesQuerySchema,
} from '@kis-books/shared';
import { authenticate } from '../middleware/auth.js';
import { requireResource } from '../middleware/permission.js';
import { companyContext } from '../middleware/company.js';
import { validate } from '../middleware/validate.js';
import { describe } from '../middleware/describe.js';
import { idempotent } from '../middleware/idempotent.js';
import { closingPasswordLimiter } from '../middleware/closing-password-limiter.js';
import { requireDesktopDocumentTextConsent } from '../middleware/desktop-document-consent.js';
import { lockContextMiddleware } from '../services/lock-context.js';
import * as billService from '../services/bill.service.js';
import * as billOcrService from '../services/ai-bill-ocr.service.js';
import * as attachmentService from '../services/attachment.service.js';
import { db } from '../db/index.js';
import { AppError } from '../utils/errors.js';

export const billsRouter = Router();
billsRouter.use(authenticate);
billsRouter.use(companyContext);
billsRouter.use(requireResource('bills'));

// Closed periods (U-83, ap-closing-v1): a bill dated on or before the
// closing date (for an edit, the old or the new date) takes closingPassword
// or a staff overrideConfirmed, as POST /transactions does. The limiter
// must see the body before lockContextMiddleware strips the password, and
// both run before validation (checks.routes.ts order).
const closingPasswordDoc = z.string().optional().describe('closing-date password (closing-password-v1); never stored or echoed');
const closedPeriodNote = 'A bill dated on or before the closing date (for an edit, the old or the new date) needs closingPassword (or a staff overrideConfirmed): ' +
  '423 TB_PERIOD_LOCKED, 403 CLOSING_PASSWORD_INVALID, 429 CLOSING_PASSWORD_RATE_LIMIT; an allowed one writes a closing_date_override audit row (ap-closing-v1).';
const billBodyDoc = createBillSchema.extend({ closingPassword: closingPasswordDoc, overrideConfirmed: z.boolean().optional() });
const voidBodyDoc = voidTransactionSchema.extend({ closingPassword: closingPasswordDoc, overrideConfirmed: z.boolean().optional() });
const idParams = z.object({ id: z.string().uuid() });

const lineRules = 'Lines (bill-lines-v1): itemId?, quantity? (decimal string > 0, at most 4 places, below 100,000,000), unitPrice? (decimal string >= 0, at most 4 places), ' +
  'amount (decimal string, at most 4 places), accountId, description?, tagId?, contactId? (a customer of the company), isBillable? (needs contactId). ' +
  'quantity and unitPrice both: amount must equal round(quantity x unitPrice, 2, half away from zero), else 400 LINE_AMOUNT_MISMATCH (details.lineIndex, details.expected); ' +
  'unitPrice without quantity 400 LINE_QTY_RATE_INCOMPLETE (details.lineIndex); quantity with amount and no unitPrice is accepted.';
const termsRules = 'Terms (bill-terms-v1): paymentTerms is a code from GET /payment-terms; custom takes termsDays and optional discountPercent + discountDays (both or neither, days fewer than termsDays). ' +
  'The due date and discount date are computed by calendar arithmetic unless dueDate / discountDate is sent (the owner override, stored as dueDateOverridden / discountDateOverridden). ' +
  'billReceived (bill-received-v1): default true; false keeps the bill out of /bills/payable and Pay Bills.';

billsRouter.get('/', describe({
  summary: 'List bills',
  description: 'Rows carry billReceived, discountDate, updatedAt and daysOverdue (from the database date).',
  query: billFiltersSchema,
}), async (req, res) => {
  const filters = billFiltersSchema.parse(req.query);
  const result = await billService.listBills(req.tenantId, filters, req.companyId);
  res.json(result);
});

billsRouter.get('/payable', describe({
  summary: 'Open bills for Pay Bills (posted, received, balance due > 0) and the vendors\' available credits',
  description: 'Response {bills, credits}, both of the request\'s company (rows without a company included). ' +
    'Each bill row carries updatedAt and discountAvailable (bill-discounts-v1): round(balanceDue x discountPercent / 100, 2, half away from zero) ' +
    'as a 2-place string when paymentDate (YYYY-MM-DD, default the database\'s current date) is on or before the bill\'s discountDate, else "0.00".',
  query: payableBillsQuerySchema,
}), async (req, res) => {
  const parsed = payableBillsQuerySchema.safeParse(req.query);
  if (!parsed.success) throw AppError.badRequest(parsed.error.issues[0]?.message ?? 'Invalid query', 'VALIDATION_ERROR');
  const result = await billService.getPayableBills(req.tenantId, {
    ...parsed.data, companyId: req.companyId, companyIncludesNull: true,
  });
  res.json(result);
});

billsRouter.get('/vendor-summary', async (req, res) => {
  const contactId = typeof req.query['contactId'] === 'string' ? req.query['contactId'] : '';
  if (!contactId) {
    res.status(400).json({ error: { message: 'contactId required' } });
    return;
  }
  const summary = await billService.getVendorApSummary(req.tenantId, contactId, req.companyId);
  res.json({ summary });
});

// U-86 (bill-terms-v1): the dates create would compute, read-only. Static
// path, declared before '/:id'.
billsRouter.get('/terms-dates', describe({
  summary: 'Due date and discount date for a bill date and terms (read-only)',
  description: 'The same calculation as POST /bills. contactId: the vendor whose default terms apply when paymentTerms is omitted. ' +
    'Response {dueDate, discountDate, paymentTerms, termsDays, discountPercent, discountDays, source: "input"|"vendor"|"none"}; dates YYYY-MM-DD or null, discountPercent a 4-place string or null.',
  query: billTermsDatesQuerySchema,
}), async (req, res) => {
  const parsed = billTermsDatesQuerySchema.safeParse(req.query);
  if (!parsed.success) throw AppError.badRequest(parsed.error.issues[0]?.message ?? 'Invalid query', 'VALIDATION_ERROR');
  res.json(await billService.getTermsDates(req.tenantId, parsed.data, req.companyId));
});

// Idempotency-Key (idempotency-v1, U-18): after the closed-period
// middleware (transactions.routes.ts order), before validation.
billsRouter.post('/', closingPasswordLimiter, lockContextMiddleware, idempotent({
  successStatus: 201,
  replay: async (req, entity) => ({ bill: await billService.getBill(req.tenantId, entity!.id, req.companyId) }),
}), validate(createBillSchema), describe({
  summary: 'Enter a bill',
  description: `Response 201 {bill}. ${closedPeriodNote} ${lineRules} ${termsRules} ` +
    'draftAttachmentId: the draft\'s attachments are relinked to the bill (attachable type "bill") in the same database transaction, one audit row each.',
  body: billBodyDoc,
}), async (req, res) => {
  const bill = await billService.createBill(req.tenantId, req.body, req.userId, req.companyId);
  res.status(201).json({ bill: await billService.getBill(req.tenantId, bill.id, req.companyId) });
});

billsRouter.get('/:id', describe({ summary: 'Get a bill (header, terms, received flag and lines)', params: idParams }), async (req, res) => {
  const bill = await billService.getBill(req.tenantId, req.params['id']!, req.companyId);
  res.json({ bill });
});

// Idempotency-Key on edit and void (idempotency-ap-v1): routes added after
// idempotency-v1, so under their own capability name. Refusals (409 STALE,
// BILL_HAS_PAYMENTS, …) are never stored.
const keyedBillById = idempotent({
  successStatus: 200,
  replay: async (req) => ({ bill: await billService.getBill(req.tenantId, req.params['id']!, req.companyId) }),
});

billsRouter.put('/:id', closingPasswordLimiter, lockContextMiddleware, keyedBillById, validate(updateBillSchema), describe({
  summary: 'Edit a bill',
  description: `Response 200 {bill} as committed (its updatedAt is the next expectedUpdatedAt). ${closedPeriodNote} ` +
    'expectedUpdatedAt (ap-edit-v1): mismatch 409 STALE (details.updatedAt), nothing changes. ' +
    'With payments or credits applied the vendor, date and total stay (400), the terms stay, and billReceived can\'t become false (409 BILL_HAS_PAYMENTS). ' +
    'paymentTerms may also be the bill\'s stored free-text terms from before the table, sent back unchanged (its stored due date is kept unless dueDate is sent). ' +
    'A line sent back unchanged (same position, account, amount and description) that omits itemId, quantity, unitPrice, contactId and isBillable keeps its stored ones; null clears them. ' +
    `${lineRules} ${termsRules}`,
  body: billBodyDoc.extend({ paymentTerms: z.string().max(50).optional() }),
  params: idParams,
}), async (req, res) => {
  const bill = await billService.updateBill(req.tenantId, req.params['id']!, req.body, req.userId, req.companyId);
  res.json({ bill });
});

billsRouter.post('/:id/void', closingPasswordLimiter, lockContextMiddleware, keyedBillById, validate(voidTransactionSchema), describe({
  summary: 'Void a bill',
  description: `Response 200 {bill}. ${closedPeriodNote} Refused while payments or credits are applied: 409 BILL_HAS_PAYMENTS. ` +
    'expectedUpdatedAt (ap-edit-v1): mismatch 409 STALE. A bill of another company is 404.',
  body: voidBodyDoc,
  params: idParams,
}), async (req, res) => {
  await billService.voidBill(req.tenantId, req.params['id']!, req.body.reason, req.userId, {
    expectedUpdatedAt: req.body.expectedUpdatedAt, companyId: req.companyId,
  });
  const bill = await billService.getBill(req.tenantId, req.params['id']!, req.companyId);
  res.json({ bill });
});

// ─── AI: extract bill fields from an attachment ─────────────────
//
// Flow used by EnterBillPage:
//   1. Form uploads the file via POST /attachments with attachableType='draft'
//      and a client-generated draft id, getting back an attachment id.
//   2. Form calls POST /bills/extract-from-attachment/:attachmentId — this
//      runs the bill-specific OCR pipeline and returns parsed fields plus
//      best-effort vendor + default-expense-account resolution.
//   3. User reviews / edits the pre-filled form and saves the bill.
//   4. Form calls POST /bills/:id/attach-draft to relink the draft
//      attachment(s) to the newly created bill (or sends draftAttachmentId
//      with POST /bills, bill-lines-v1).
//
// The Attachment Library's "Create bill" action reuses the same flow for an
// EXISTING unfiled attachment: the form first adopts it into the session's
// draft set via POST /attachments/:id/link {attachableType:'draft'},
// then steps 2-4 run unchanged (extract-from-attachment works on any
// tenant attachment id, and honors the same consent/PII gates).
const ocrMoney = z.string().nullable().describe('plain decimal string, e.g. "1234.56"; never a JSON number (bill-ocr-v2)');
const ocrConfidence = z.enum(['high', 'medium', 'low']);
const extractionResponse = z.object({
  extraction: z.object({
    jobId: z.string(),
    vendor: z.string().nullable(),
    vendorAddress: z.object({
      line1: z.string().nullable(), line2: z.string().nullable(), city: z.string().nullable(),
      state: z.string().nullable(), zip: z.string().nullable(),
    }).nullable(),
    vendorInvoiceNumber: z.string().nullable(),
    billDate: z.string().nullable().describe('YYYY-MM-DD as read'),
    dueDate: z.string().nullable(),
    paymentTerms: z.string().nullable(),
    total: ocrMoney,
    subtotal: ocrMoney,
    tax: ocrMoney,
    lineItems: z.array(z.object({
      description: z.string().nullable(),
      amount: ocrMoney,
      quantity: z.string().nullable(),
      confidence: ocrConfidence.describe('bill-ocr-v2; low when the amount did not read'),
    })),
    notes: z.string().nullable(),
    confidence: z.number().describe('document-level 0–1 score, kept for older clients'),
    fieldConfidence: z.object({
      vendor: ocrConfidence, billDate: ocrConfidence, dueDate: ocrConfidence,
      vendorInvoiceNumber: ocrConfidence, total: ocrConfidence, subtotal: ocrConfidence,
      tax: ocrConfidence, paymentTerms: ocrConfidence,
    }).describe('bill-ocr-v2: high ≥ 0.85, medium ≥ 0.6, else low; an empty field is low'),
    contactId: z.string().nullable(),
    defaultExpenseAccountId: z.string().nullable(),
    qualityWarnings: z.array(z.string()),
    status: z.enum(['ok', 'ocr_only']).optional(),
    rawText: z.string().optional(),
  }),
});

billsRouter.post('/extract-from-attachment/:attachmentId', describe({
  summary: 'Read a bill from an attachment with AI (an explicit owner request)',
  description: 'Needs the company\'s receipt_ocr consent. Desktop mode with a cloud OCR provider: also the company\'s ' +
    'document_text_cloud switch, else 403 CONSENT_REQUIRED (details.task) before the attachment lookup (U-92d).',
  params: z.object({ attachmentId: z.string() }),
  response: extractionResponse,
}), requireDesktopDocumentTextConsent, async (req, res) => {
  // An attachment of another company is 404 (one with no company passes),
  // as in relinkDraftAttachments.
  const result = await billOcrService.extractBillFromAttachment(req.tenantId, req.params['attachmentId']!, req.companyId);
  res.json({ extraction: result });
});

billsRouter.post('/:id/attach-draft', describe({
  summary: 'Relink a draft\'s attachments to a bill',
  description: 'The bill must exist in this company (else 404). One audit row per relinked attachment. Response {reassigned: count}.',
  body: z.object({ draftId: z.string() }),
  params: idParams,
}), async (req, res) => {
  const { draftId } = req.body as { draftId?: string };
  if (!draftId) {
    res.status(400).json({ error: { message: 'draftId is required' } });
    return;
  }
  // The target must be a bill of this tenant and company (review Notes:
  // the id was taken unchecked).
  const bill = await billService.getBill(req.tenantId, req.params['id']!, req.companyId).catch(() => null);
  if (!bill || bill.status === 'deleted' || (req.companyId && bill.companyId && bill.companyId !== req.companyId)) {
    throw AppError.notFound('Bill not found');
  }
  // Re-link as 'bill' so the BillDetailPage's <AttachmentPanel
  // attachableType="bill" /> picks them up. Other transaction types
  // (expense, deposit, etc.) follow the same convention of using
  // their `txnType` as the attachable type — see
  // transactions.routes.ts and TransactionDetail.tsx.
  const ids = await attachmentService.relinkDraftAttachments(db, req.tenantId, draftId, 'bill', bill.id, req.userId, req.companyId);
  res.json({ reassigned: ids.length });
});
