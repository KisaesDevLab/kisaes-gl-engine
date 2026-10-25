// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { Router } from 'express';
import { z } from 'zod';
import { describe } from '../middleware/describe.js';
import { createBillSchema, billFiltersSchema, payableBillsQuerySchema, voidTransactionSchema } from '@kis-books/shared';
import { authenticate } from '../middleware/auth.js';
import { requireResource } from '../middleware/permission.js';
import { companyContext } from '../middleware/company.js';
import { validate } from '../middleware/validate.js';
import { idempotent } from '../middleware/idempotent.js';
import * as billService from '../services/bill.service.js';
import * as billOcrService from '../services/ai-bill-ocr.service.js';
import * as attachmentService from '../services/attachment.service.js';

export const billsRouter = Router();
billsRouter.use(authenticate);
billsRouter.use(companyContext);
billsRouter.use(requireResource('bills'));

billsRouter.get('/', async (req, res) => {
  const filters = billFiltersSchema.parse(req.query);
  const result = await billService.listBills(req.tenantId, filters, req.companyId);
  res.json(result);
});

billsRouter.get('/payable', async (req, res) => {
  const query = payableBillsQuerySchema.parse(req.query);
  const result = await billService.getPayableBills(req.tenantId, query);
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

// Idempotency-Key (idempotency-v1, U-18).
billsRouter.post('/', idempotent({
  successStatus: 201,
  replay: async (req, entity) => ({ bill: await billService.getBill(req.tenantId, entity!.id) }),
}), validate(createBillSchema), async (req, res) => {
  const bill = await billService.createBill(req.tenantId, req.body, req.userId, req.companyId);
  res.status(201).json({ bill });
});

billsRouter.get('/:id', async (req, res) => {
  const bill = await billService.getBill(req.tenantId, req.params['id']!);
  res.json({ bill });
});

billsRouter.put('/:id', validate(createBillSchema), async (req, res) => {
  const bill = await billService.updateBill(req.tenantId, req.params['id']!, req.body, req.userId, req.companyId);
  res.json({ bill });
});

billsRouter.post('/:id/void', validate(voidTransactionSchema), async (req, res) => {
  await billService.voidBill(req.tenantId, req.params['id']!, req.body.reason, req.userId);
  const bill = await billService.getBill(req.tenantId, req.params['id']!);
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
//      attachment(s) to the newly created bill.
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
  params: z.object({ attachmentId: z.string() }),
  response: extractionResponse,
}), async (req, res) => {
  const result = await billOcrService.extractBillFromAttachment(req.tenantId, req.params['attachmentId']!);
  res.json({ extraction: result });
});

billsRouter.post('/:id/attach-draft', async (req, res) => {
  const { draftId } = req.body as { draftId?: string };
  if (!draftId) {
    res.status(400).json({ error: { message: 'draftId is required' } });
    return;
  }
  // Re-link as 'bill' so the BillDetailPage's <AttachmentPanel
  // attachableType="bill" /> picks them up. Other transaction types
  // (expense, deposit, etc.) follow the same convention of using
  // their `txnType` as the attachable type — see
  // transactions.routes.ts and TransactionDetail.tsx.
  const reassigned = await attachmentService.reassignDraftAttachments(
    req.tenantId,
    draftId,
    'bill',
    req.params['id']!,
  );
  res.json({ reassigned });
});
