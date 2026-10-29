// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { Router } from 'express';
import { z } from 'zod';
import { writeCheckSchema, updateCheckSchema, printCheckSchema, renderChecksSchema, checkSettingsSchema, updateCheckMemoSchema, STEP_UP_REQUIRED, CHECK_LAYOUT_VALUES, CHECK_ACCOUNT_FORMAT_VALUES } from '@kis-books/shared';
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
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import { accounts, companies } from '../db/schema/index.js';

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
      req.tenantId, req.body.draftAttachmentId, 'expense', check.id, undefined, req.companyId,
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

// U-107: each row also carries txnType, bankAccountId and payeeAddress
// (mailing rows; check-reprint-audit-v1).
const printQueueRowDoc = z.object({
  id: z.string().uuid(),
  txnDate: z.string(),
  amount: z.string().describe('decimal string'),
  memo: z.string().nullable(),
  payeeNameOnCheck: z.string().nullable(),
  printedMemo: z.string().nullable(),
  contactName: z.string().nullable(),
  createdAt: z.string(),
  source: z.string().nullable(),
  txnType: z.string().describe("'expense' (a written check) or 'bill_payment'"),
  bankAccountId: z.string().uuid().nullable().describe('the bank account the check is drawn on'),
  payeeAddress: z.array(z.string()).describe(
    'mailing rows (street / street 2 / "City, ST ZIP"): a bill payment uses the vendor billing address, else the check\'s typed address; '
    + 'a written check uses its typed address, else the payee contact billing address; [] when none',
  ),
});

checksRouter.get('/print-queue', describe({
  summary: 'Checks waiting to print (check-reprint-audit-v1 adds txnType, bankAccountId, payeeAddress)',
  query: z.object({ bank_account_id: z.string().uuid().optional() }),
  response: z.object({ data: z.array(printQueueRowDoc) }),
}), async (req, res) => {
  const data = await checkService.getPrintQueue(req.tenantId, req.query['bank_account_id'] as string, req.companyId);
  res.json({ data });
});

// Spoiled check numbers (U-106, check-reprint-audit-v1): numbers a check
// carried before a requeue or reprint sent it back to the queue, for a
// register to show the spoiled paper. Listing only: a number may be reused.
checksRouter.get('/spoiled', describe({
  summary: 'Check numbers spoiled by reprints (check-reprint-audit-v1)',
  query: z.object({ bank_account_id: z.string().uuid().optional() }),
  response: z.object({
    data: z.array(z.object({
      checkNumber: z.number().int(),
      checkId: z.string().uuid().describe('the check that carried the number (it is back in the queue or reprinted under a new number)'),
      bankAccountId: z.string().uuid(),
      reason: z.enum(['requeue', 'reprint', 'edit_reprint']),
      spoiledAt: z.string().describe('ISO timestamp'),
      spoiledBy: z.string().uuid().nullable(),
      spoiledByName: z.string().nullable(),
      txnDate: z.string().nullable().describe("the check's date"),
    })),
  }),
}), async (req, res) => {
  const bank = req.query['bank_account_id'];
  if (bank !== undefined && !z.string().uuid().safeParse(bank).success) {
    throw AppError.badRequest('bank_account_id must be a UUID', 'VALIDATION_ERROR');
  }
  const data = await checkService.listSpoiledCheckNumbers(req.tenantId, bank as string | undefined, req.companyId);
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
  description: 'Every check must be a queued check of this company (404) drawn on bankAccountId (400 CHECK_NOT_ON_BANK_ACCOUNT); '
    + 'a number in the range held by another check on the account is 409 CHECK_NUMBER_IN_USE (details.checkNumber) (check-reprint-audit-v1). '
    + closedPeriodNote,
  body: printCheckSchema.extend({ closingPassword: closingPasswordDoc }),
}), async (req, res) => {
  const signature = await resolveSignature(req);
  const result = await checkService.printChecks(
    req.tenantId, req.body.bankAccountId, req.body.checkIds,
    req.body.startingCheckNumber, req.body.format, req.userId,
    signature ? { id: req.body.signatureId, maxAmount: signature.maxAmount } : undefined,
    req.companyId,
  );
  res.json(result);
});

// Requeue and reprint (U-106, check-reprint-audit-v1): each check goes back
// to the queue with its number cleared; the old number is listed as spoiled
// on the check's bank account (GET /checks/spoiled; it may be reused) and one audit row per check records
// the before state. The payment is never voided: ledger lines, bill
// applications and balances stay as they are.
const requeuedDoc = z.object({
  message: z.string(),
  checks: z.array(z.object({
    id: z.string().uuid(),
    spoiledCheckNumber: z.number().int().nullable().describe('the number the check carried, now spoiled; null when it had none'),
    bankAccountId: z.string().uuid().nullable(),
  })),
});
const requeueNote = 'The old number is spoiled on the check\'s bank account and audited; the payment stays posted (check-reprint-audit-v1). '
  + 'A numbered check whose bank account can\'t be resolved is 400 CHECK_BANK_ACCOUNT_UNKNOWN (nothing changes). ';

checksRouter.post('/reprint/:batchId', closingPasswordLimiter, lockContextMiddleware, describe({
  summary: 'Return a printed batch to the print queue (numbers spoiled, payments kept)',
  description: requeueNote + '404 when the batch has no check in this company (or was already sent back). ' + closedPeriodNote,
  body: z.object({ closingPassword: closingPasswordDoc }),
  params: z.object({ batchId: z.string().uuid() }),
  response: requeuedDoc,
}), async (req, res) => {
  const parsed = z.string().uuid().safeParse(req.params['batchId']);
  if (!parsed.success) throw AppError.notFound('Print batch not found');
  const checks = await checkService.reprintBatch(req.tenantId, parsed.data, req.userId, req.companyId);
  res.json({ message: 'Batch reset to queue', checks });
});

checksRouter.post('/requeue', closingPasswordLimiter, lockContextMiddleware, describe({
  summary: 'Return checks to the print queue (number and print stamp cleared, number spoiled)',
  description: requeueNote + 'Every id must be a check of this company (404, nothing changes); a void check is 400 CHECK_VOID; a hand-written check (never printed here) is 400 CHECK_NOT_PRINTED. ' + closedPeriodNote,
  body: z.object({ checkIds: z.array(z.string().uuid()), closingPassword: closingPasswordDoc }),
  response: requeuedDoc,
}), async (req, res) => {
  const parsed = z.array(z.string().uuid()).safeParse(req.body?.checkIds);
  if (!parsed.success) throw AppError.badRequest('checkIds must be an array of UUIDs', 'VALIDATION_ERROR');
  const checks = await checkService.requeueChecks(req.tenantId, parsed.data, req.userId, req.companyId);
  res.json({ message: 'Checks returned to queue', checks });
});

// Check settings. U-109 (check-reprint-audit-v1): settings.layouts holds a
// {format, printCompanyBlock} per bank account; GET with ?bank_account_id=
// also returns `layout`: that account's entry, or the company format with
// printCompanyBlock false, with `source`.
const layoutDoc = z.object({
  format: z.enum(CHECK_ACCOUNT_FORMAT_VALUES),
  printCompanyBlock: z.boolean(),
  source: z.enum(['bank_account', 'company']),
});

checksRouter.get('/settings', describe({
  summary: 'Check settings; with bank_account_id also the resolved layout for that account (U-109)',
  query: z.object({ bank_account_id: z.string().uuid().optional() }),
  response: z.object({ settings: z.record(z.string(), z.unknown()), layout: layoutDoc.optional() }),
}), async (req, res) => {
  const { and: andOp } = await import('drizzle-orm');
  const company = await db.query.companies.findFirst({ where: andOp(eq(companies.tenantId, req.tenantId), eq(companies.id, req.companyId)) });
  const settings = (company?.checkSettings as Record<string, unknown>) || {};
  const bank = req.query['bank_account_id'];
  if (bank === undefined) {
    res.json({ settings });
    return;
  }
  if (!z.string().uuid().safeParse(bank).success) throw AppError.badRequest('bank_account_id must be a UUID', 'VALIDATION_ERROR');
  res.json({ settings, layout: resolveCheckLayout(settings, bank as string) });
});

checksRouter.put('/settings', validate(checkSettingsSchema), describe({
  summary: 'Update check settings (shallow merge; a sent `layouts` map replaces the stored one)',
  description: 'layouts (U-109): {bankAccountId: {format (voucher | check_middle | z_fold | standard), printCompanyBlock (default false)}}; '
    + 'keys must be asset (bank) accounts of this company, else 400 VALIDATION_ERROR.',
}), async (req, res) => {
  const { and: andOp } = await import('drizzle-orm');
  if (req.body.layouts) await assertLayoutAccounts(req.tenantId, req.companyId, Object.keys(req.body.layouts));
  const company = await db.query.companies.findFirst({ where: andOp(eq(companies.tenantId, req.tenantId), eq(companies.id, req.companyId)) });
  const current = (company?.checkSettings as Record<string, unknown>) || {};
  const merged = { ...current, ...req.body };
  await db.update(companies).set({ checkSettings: merged }).where(andOp(eq(companies.tenantId, req.tenantId), eq(companies.id, req.companyId)));
  res.json({ settings: merged });
});

/** The check style for one bank account: its own entry, else the company format (U-109). */
export function resolveCheckLayout(settings: Record<string, unknown>, bankAccountId: string) {
  const layouts = (settings['layouts'] ?? {}) as Record<string, { format?: string; printCompanyBlock?: boolean }>;
  const own = layouts[bankAccountId];
  if (own && (CHECK_ACCOUNT_FORMAT_VALUES as readonly string[]).includes(String(own.format))) {
    return { format: String(own.format), printCompanyBlock: own.printCompanyBlock === true, source: 'bank_account' as const };
  }
  const companyFormat = (CHECK_LAYOUT_VALUES as readonly string[]).includes(String(settings['format']))
    ? String(settings['format']) : 'voucher';
  return { format: companyFormat, printCompanyBlock: false, source: 'company' as const };
}

async function assertLayoutAccounts(tenantId: string, companyId: string, ids: string[]) {
  if (ids.length === 0) return;
  const rows = await db.select({ id: accounts.id, companyId: accounts.companyId, accountType: accounts.accountType })
    .from(accounts)
    .where(and(eq(accounts.tenantId, tenantId), inArray(accounts.id, ids)));
  const ok = rows.length === ids.length
    && rows.every((r) => r.accountType === 'asset' && (r.companyId === null || r.companyId === companyId));
  if (!ok) throw AppError.badRequest('Check layouts must be keyed by this company\'s bank accounts', 'VALIDATION_ERROR');
}

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
