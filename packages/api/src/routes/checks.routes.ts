// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { Router } from 'express';
import { z } from 'zod';
import { writeCheckSchema, updateCheckSchema, printCheckSchema, renderChecksSchema, checkSettingsSchema, updateCheckMemoSchema, STEP_UP_REQUIRED } from '@kis-books/shared';
import { authenticate } from '../middleware/auth.js';
import { hasTenantOwnerPower } from '../middleware/firm-capabilities.js';
import { requireResource } from '../middleware/permission.js';
import { companyContext } from '../middleware/company.js';
import { validate } from '../middleware/validate.js';
import { describe } from '../middleware/describe.js';
import { idempotent } from '../middleware/idempotent.js';
import * as ledger from '../services/ledger.service.js';
import { closingPasswordLimiter } from '../middleware/closing-password-limiter.js';
import { lockContextMiddleware } from '../services/lock-context.js';
import * as checkService from '../services/check.service.js';
import * as checkPdfService from '../services/check-pdf.service.js';
import * as signatureService from '../services/check-signature.service.js';
import * as attachmentService from '../services/attachment.service.js';
import { AppError } from '../utils/errors.js';
import { parseLimit, parseOffset } from '../utils/pagination.js';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { companies } from '../db/schema/index.js';

export const checksRouter = Router();
checksRouter.use(authenticate);
checksRouter.use(companyContext);
checksRouter.use(requireResource('checks'));

// lockContextMiddleware: a check dated in a closed period takes the same
// closingPassword / overrideConfirmed as POST /transactions (U-15).
// Idempotency-Key (idempotency-v1, U-18): the readers replay the check as it
// is now when no stored response is left.
const readCheck = (req: { tenantId: string }, id: string) => ledger.getTransaction(req.tenantId, id);

checksRouter.post('/', idempotent({
  successStatus: 201,
  replay: async (req, entity) => ({ check: await readCheck(req, entity!.id) }),
}), closingPasswordLimiter, lockContextMiddleware, validate(writeCheckSchema), async (req, res) => {
  const check = await checkService.createCheck(req.tenantId, req.body, req.userId, req.companyId);
  // Checks post as txn_type 'expense', which is the attachable type the
  // transaction detail page reads — keep them in step.
  if (req.body.draftAttachmentId && check?.id) {
    await attachmentService.reassignDraftAttachments(
      req.tenantId, req.body.draftAttachmentId, 'expense', check.id,
    );
  }
  res.status(201).json({ check });
});

checksRouter.get('/', async (req, res) => {
  const result = await checkService.listChecks(req.tenantId, {
    bankAccountId: req.query['bank_account_id'] as string,
    printStatus: req.query['print_status'] as string,
    startDate: req.query['start_date'] as string,
    endDate: req.query['end_date'] as string,
    limit: parseLimit(req.query['limit']),
    offset: parseOffset(req.query['offset']),
  }, req.companyId);
  res.json(result);
});

checksRouter.get('/print-queue', async (req, res) => {
  const data = await checkService.getPrintQueue(req.tenantId, req.query['bank_account_id'] as string, req.companyId);
  res.json({ data });
});

// Closed periods on the print routes (U-81, ledger-guards-v1): the printed
// memo, printing, re-queueing and reprinting change a check's record, so a
// check dated on or before the closing date takes closingPassword (or a
// staff overrideConfirmed) as PUT /checks/:id does: 423 TB_PERIOD_LOCKED,
// 403 CLOSING_PASSWORD_INVALID, nothing changes.
const closingPasswordDoc = z.string().optional().describe('closing-date password (closing-password-v1); never stored or echoed');
const closedPeriodNote = 'A check dated on or before the closing date needs closingPassword (or a staff overrideConfirmed): 423 TB_PERIOD_LOCKED, 403 CLOSING_PASSWORD_INVALID (ledger-guards-v1).';

// Edit the memo that will print on a queued check — including the checks
// created by paying bills, which POST /transactions/:id refuses to touch.
checksRouter.patch('/:id/memo', closingPasswordLimiter, lockContextMiddleware, validate(updateCheckMemoSchema), describe({
  summary: 'Set the memo printed on a queued check',
  description: closedPeriodNote,
  body: updateCheckMemoSchema.extend({ closingPassword: closingPasswordDoc }),
  params: z.object({ id: z.string().uuid() }),
}), async (req, res) => {
  const result = await checkService.updatePrintedMemo(
    req.tenantId, req.params['id']!, req.body.printedMemo, req.userId, req.companyId,
  );
  res.json(result);
});

checksRouter.post('/test-print', async (req, res) => {
  const pdf = await checkPdfService.generateTestCheckPdf(req.tenantId, req.body.format || 'voucher');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'inline; filename="test-check.pdf"');
  res.send(pdf);
});

// Signature authorization + step-up gate, shared by /render and /print.
// BOTH must enforce it: the render PDF IS the printable artifact, and the
// step-up token can expire between the two calls. Returns the decrypted
// image (memory only) or undefined when the request is unsigned.
async function resolveSignature(req: import('express').Request): Promise<checkPdfService.SignatureRenderData | undefined> {
  const { signatureId, stepUpToken } = req.body as { signatureId?: string; stepUpToken?: string };
  if (!signatureId) return undefined;
  // Owner parity includes firm members holding the `check_signatures`
  // access right; the step-up token check below is unchanged for everyone.
  const isOwner = await hasTenantOwnerPower(req, 'check_signatures');
  const allowed = await signatureService.userCanUseSignature(req.tenantId, signatureId, req.userId, isOwner);
  if (!allowed) throw AppError.forbidden('You are not authorized to print with this signature');
  if (!signatureService.verifyStepUpToken(stepUpToken, req.userId, req.tenantId)) {
    throw AppError.forbidden('Re-authentication required to print with a signature', STEP_UP_REQUIRED);
  }
  const sig = await signatureService.loadSignatureImage(req.tenantId, signatureId);
  return { bytes: sig.bytes, mime: sig.mime, maxAmount: sig.maxAmount };
}

checksRouter.post('/render', validate(renderChecksSchema), async (req, res) => {
  const { checkIds, format, startingCheckNumber } = req.body;
  const signature = await resolveSignature(req);
  // startingCheckNumber lets the render preview the numbers that the
  // subsequent POST /print will assign (same checkIds order).
  const startNum = Number.isInteger(startingCheckNumber) && startingCheckNumber > 0
    ? startingCheckNumber : null;
  const pdf = await checkPdfService.generateCheckPdf(req.tenantId, checkIds, format || 'voucher', startNum, signature);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'inline; filename="checks.pdf"');
  res.send(pdf);
});

// #10 envelopes for a batch of checks (return + payee mailing address).
checksRouter.post('/envelopes', async (req, res) => {
  const { checkIds } = req.body;
  if (!Array.isArray(checkIds) || checkIds.length === 0) {
    res.status(400).json({ error: 'checkIds is required' });
    return;
  }
  const pdf = await checkPdfService.generateEnvelopePdf(req.tenantId, checkIds);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'inline; filename="envelopes.pdf"');
  res.send(pdf);
});

checksRouter.post('/print', closingPasswordLimiter, lockContextMiddleware, validate(printCheckSchema), describe({
  summary: 'Print queued checks: assign numbers and mark them printed',
  description: closedPeriodNote,
  body: printCheckSchema.extend({ closingPassword: closingPasswordDoc }),
}), async (req, res) => {
  const signature = await resolveSignature(req);
  const result = await checkService.printChecks(
    req.tenantId, req.body.bankAccountId, req.body.checkIds,
    req.body.startingCheckNumber, req.body.format, req.userId,
    signature ? { id: req.body.signatureId, maxAmount: signature.maxAmount } : undefined,
  );
  res.json(result);
});

checksRouter.post('/reprint/:batchId', closingPasswordLimiter, lockContextMiddleware, describe({
  summary: 'Return a printed batch to the print queue',
  description: closedPeriodNote,
  body: z.object({ closingPassword: closingPasswordDoc }),
  params: z.object({ batchId: z.string() }),
}), async (req, res) => {
  await checkService.reprintBatch(req.tenantId, req.params['batchId']!);
  res.json({ message: 'Batch reset to queue' });
});

checksRouter.post('/requeue', closingPasswordLimiter, lockContextMiddleware, describe({
  summary: 'Return checks to the print queue (number and print stamp cleared)',
  description: closedPeriodNote,
  body: z.object({ checkIds: z.array(z.string().uuid()), closingPassword: closingPasswordDoc }),
}), async (req, res) => {
  await checkService.requeueChecks(req.tenantId, req.body.checkIds);
  res.json({ message: 'Checks returned to queue' });
});

// Check settings
checksRouter.get('/settings', async (req, res) => {
  const { and: andOp } = await import('drizzle-orm');
  const company = await db.query.companies.findFirst({ where: andOp(eq(companies.tenantId, req.tenantId), eq(companies.id, req.companyId)) });
  res.json({ settings: company?.checkSettings || {} });
});

checksRouter.put('/settings', validate(checkSettingsSchema), async (req, res) => {
  const { and: andOp } = await import('drizzle-orm');
  const company = await db.query.companies.findFirst({ where: andOp(eq(companies.tenantId, req.tenantId), eq(companies.id, req.companyId)) });
  const current = (company?.checkSettings as Record<string, unknown>) || {};
  const merged = { ...current, ...req.body };
  await db.update(companies).set({ checkSettings: merged }).where(andOp(eq(companies.tenantId, req.tenantId), eq(companies.id, req.companyId)));
  res.json({ settings: merged });
});

// Edit a check (U-48, capability check-edit-v1). Body = POST /checks body
// without draftAttachmentId; printLater has no default (absent keeps the
// current print state) and printedCheckChange ('reprint' | 'keep_number')
// is required when a PRINTED check's printed face changes. Declared after
// PUT /settings so that static path is not read as an id. Closed periods
// take closingPassword (or a staff overrideConfirmed) exactly as
// PUT /transactions/:id. Errors: 400 VALIDATION_ERROR (amount not > 0,
// lines don't sum exactly to amount, billable line without a customer, line
// customer or tag outside the company), 400 CHECK_NOT_EDITABLE (a
// bill-payment check), 400 void check, 404 not a check / deleted, 409
// CHECK_PRINTED, 409 LINE_BILLED, 409 duplicate check number, 423
// TB_PERIOD_LOCKED, 403 CLOSING_PASSWORD_INVALID, 429 rate limit.
const updateCheckBodyDoc = updateCheckSchema.extend({
  closingPassword: z.string().optional().describe('closing-date password (closing-password-v1); never stored or echoed'),
});

checksRouter.put('/:id', idempotent({
  successStatus: 200,
  replay: async (req) => ({ check: await readCheck(req, req.params['id']!) }),
}), closingPasswordLimiter, lockContextMiddleware, validate(updateCheckSchema), describe({
  summary: 'Edit a check: lines, amount, payee, date, number and print status (check-edit-v1)',
  body: updateCheckBodyDoc,
  params: z.object({ id: z.string().uuid() }),
}), async (req, res) => {
  const parsed = z.string().uuid().safeParse(req.params['id']);
  if (!parsed.success) throw AppError.notFound('Check not found');
  const check = await checkService.updateCheck(req.tenantId, parsed.data, req.body, req.userId, req.companyId);
  res.json({ check });
});
