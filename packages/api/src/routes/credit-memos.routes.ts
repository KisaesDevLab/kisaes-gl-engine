// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { Router } from 'express';
import { z } from 'zod';
import { applyCreditMemoSchema, unapplyCreditMemoSchema, creditMemoSchema, creditMemoPreviewSchema } from '@kis-books/shared';
import { authenticate } from '../middleware/auth.js';
import { requireResource } from '../middleware/permission.js';
import { companyContext } from '../middleware/company.js';
import { validate } from '../middleware/validate.js';
import { describe } from '../middleware/describe.js';
import { closingPasswordLimiter } from '../middleware/closing-password-limiter.js';
import { lockContextMiddleware } from '../services/lock-context.js';
import { idempotent } from '../middleware/idempotent.js';
import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import * as paymentService from '../services/payment.service.js';
import * as salesDocs from '../services/sales-docs.service.js';

/**
 * Credit memos as A/R credit sources (U-137, credit-memo-apply-v1). A memo's
 * remaining credit = total - live applications - live refunds drawn on it.
 * Applications use the Receive Payment machinery (payment_applications,
 * the lock order credit sources -> invoices, expectedBalanceDue tokens).
 * Money writes take Idempotency-Key (idempotency-credit-memo-v1).
 */
export const creditMemosRouter = Router();
creditMemosRouter.use(authenticate);
creditMemosRouter.use(companyContext);
// Credit memos are a Sales document under the invoices resource, as the
// permission templates already map them (templates/permissions.ts).
creditMemosRouter.use(requireResource('invoices'));

const closing = {
  closingPassword: z.string().optional().describe('closing-date password (closing-password-v1); never stored or echoed'),
  overrideConfirmed: z.boolean().optional(),
};
const closedPeriodNote = 'A change dated on or before the closing date needs closingPassword (or a staff overrideConfirmed): ' +
  'without it 423 CLOSED_PERIOD; a wrong password 403; too many tries 429.';

async function remainingOf(tenantId: string, memoId: string): Promise<string> {
  const res = await db.execute(sql`
    SELECT (t.total
      - COALESCE((SELECT SUM(pa.amount) FROM payment_applications pa WHERE pa.tenant_id = t.tenant_id AND pa.payment_id = t.id
                  AND pa.voided_at IS NULL AND pa.reversed_by_txn_id IS NULL), 0)
      - COALESCE((SELECT SUM(r.total) FROM transactions r WHERE r.tenant_id = t.tenant_id AND r.source_payment_id = t.id
                  AND r.txn_type = 'customer_refund' AND r.status = 'posted'), 0))::numeric(19,2)::text AS remaining
    FROM transactions t WHERE t.tenant_id = ${tenantId} AND t.id = ${memoId}
  `);
  const r = (res.rows as Array<{ remaining: string }>)[0]?.remaining ?? '0.00';
  return r.startsWith('-') ? '0.00' : r;
}

creditMemosRouter.post('/:id/apply', closingPasswordLimiter, lockContextMiddleware, idempotent({
  successStatus: 200,
  replay: async (req) => ({ applied: [], remaining: await remainingOf(req.tenantId, req.params['id']!) }),
}), validate(applyCreditMemoSchema), describe({
  summary: 'Apply a credit memo to invoices (credit-memo-apply-v1)',
  description: 'Response {applied: [{invoiceId, amount}], remaining}. Applies the remaining credit of the memo to open invoices of the ' +
    'same client on `date`, with no GL effect (the memo\'s A/R credit meets the invoice\'s A/R debit). Rows: {invoiceId, amount?, ' +
    'expectedBalanceDue} (amount omitted = min(remaining, cent balance)). The memo is locked, then the invoices in id order. ' +
    'Errors: 400 VALIDATION_ERROR (more than 2 places, an invoice twice), 400 INVOICE_NOT_FOR_CUSTOMER, 400 OVERAPPLIED ' +
    '{invoiceId, balanceDue}, 400 APPLY_DATE_BEFORE_SOURCE {sourceId, sourceDate} (date before the memo\'s date), 400 ' +
    'TOO_MANY_APPLICATIONS (over 1,000); 409 CREDIT_NOT_AVAILABLE {sourceId, remaining}, 409 INVOICE_BALANCE_CHANGED ' +
    '{invoiceId, balanceDue, balanceDueExact}, 409 STALE (expectedUpdatedAt); 404 for a memo or invoice of another company. ' +
    `Closing date on \`date\`. ${closedPeriodNote} Idempotency-Key: a replay answers {applied: [], remaining}.`,
  body: applyCreditMemoSchema.extend(closing),
  params: z.object({ id: z.string().uuid() }),
}), async (req, res) => {
  const result = await paymentService.applyCreditMemo(req.tenantId, req.params['id']!, req.body, req.userId, req.companyId);
  res.json(result);
});

creditMemosRouter.post('/:id/unapply', closingPasswordLimiter, lockContextMiddleware, idempotent({
  successStatus: 200,
  replay: async (req) => ({ remaining: await remainingOf(req.tenantId, req.params['id']!) }),
}), validate(unapplyCreditMemoSchema), describe({
  summary: 'Take one invoice off a credit memo (credit-memo-apply-v1)',
  description: 'Response {remaining}. The invoice reopens (status from its cent balance) and the amount is back in the memo\'s ' +
    'remaining credit; audited. 404 when the memo has no live application to the invoice; 409 STALE (expectedUpdatedAt, the memo\'s). ' +
    `Closing date on the row's applied date (the memo's date for rows applied when it was saved). ${closedPeriodNote}`,
  body: unapplyCreditMemoSchema.extend(closing),
  params: z.object({ id: z.string().uuid() }),
}), async (req, res) => {
  const result = await paymentService.unapplyCreditMemo(req.tenantId, req.params['id']!, req.body.invoiceId, {
    expectedUpdatedAt: req.body.expectedUpdatedAt, companyId: req.companyId, userId: req.userId,
  });
  res.json(result);
});

// ─── U-138 credit-memo-edit-v1: create, preview, read, edit ─────────

const lineRules = 'Lines as invoice lines (itemId or accountId, quantity, unitPrice (at most 4 places), discountPercent, isTaxable, ' +
  'taxRate, tagId, serviceDate); billable-cost fields are 400 VALIDATION_ERROR. Line = round2(qty x rate) half away from zero; ' +
  'tax once per rate (P20). Posting: Dr each income line, Dr Sales Tax Payable the tax, Cr A/R the total.';
const memoRecordNote = 'CreditMemoRecord: {id, number, date, customerId, lines: [{accountId, itemId, description, quantity, unitPrice, ' +
  'amount, isTaxable, taxRate, taxAmount, tagId, serviceDate}], totals: {subtotal, taxTotal, total}, memo, customerMessage, hideZeroLines, ' +
  'layoutId, printLater, updatedAt, status, applications: [{invoiceId, invoiceNumber, amount, appliedDate, voided}], refunds: [{refundId, ' +
  'date, amount, method, voided}], remaining}.';

creditMemosRouter.post('/preview', validate(creditMemoPreviewSchema), describe({
  summary: 'Preview a credit memo; posts nothing (credit-memo-edit-v1)',
  description: 'Response {lines: [{itemId, itemType, quantity, unitPrice, unitPriceSource, discountPercent, amount, isTaxable, taxRate, ' +
    'taxAmount}], subtotal, taxableBase, taxRate, taxTotal, total, taxGroups, contactBalanceBefore, contactBalanceAfter, openInvoices: ' +
    '[{invoiceId, number, date, dueDate, balanceDue, balanceDueExact}], suggestedApplications: [{invoiceId, amount}] (oldest first up to ' +
    'the total), remainingCredit, problems: [{code: CREDIT_MEMO_TOTAL_NOT_POSITIVE}]}. The same compute as POST, so preview = post. ' +
    `editingId: the memo being edited (its own applications count as open again). ${lineRules}`,
  body: creditMemoPreviewSchema,
}), async (req, res) => {
  res.json(await salesDocs.previewCreditMemo(req.tenantId, req.body, req.companyId));
});

creditMemosRouter.post('/', closingPasswordLimiter, lockContextMiddleware, idempotent({
  successStatus: 201,
  replay: async (req, entity) => ({ creditMemo: await salesDocs.getCreditMemoRecord(db, req.tenantId, entity!.id, req.companyId), warnings: [] }),
}), validate(creditMemoSchema), describe({
  summary: 'Create a credit memo (credit-memo-edit-v1)',
  description: `Response 201 {creditMemo: CreditMemoRecord, warnings}. ${lineRules} Stores subtotal and tax_amount. Total 0.00 or less ` +
    'is 400 CREDIT_MEMO_TOTAL_NOT_POSITIVE (record a return with money back as a sales receipt). applications: [{invoiceId, amount, ' +
    'expectedBalanceDue}] are applied in the same database transaction, dated with the memo (applied_date NULL); errors as POST ' +
    '/credit-memos/:id/apply (OVERAPPLIED, INVOICE_NOT_FOR_CUSTOMER, 409 INVOICE_BALANCE_CHANGED, CREDIT_NOT_AVAILABLE); any failure ' +
    `posts nothing. txnNumber: typed or the next from the credit_memo counter (409 DOCUMENT_NUMBER_IN_USE). ${closedPeriodNote} ${memoRecordNote}`,
  body: creditMemoSchema.extend(closing),
}), async (req, res) => {
  const result = await salesDocs.createCreditMemoDocument(req.tenantId, req.body, req.userId, req.companyId);
  res.status(201).json(result);
});

creditMemosRouter.get('/:id', describe({
  summary: 'Get a credit memo (credit-memo-edit-v1)',
  description: `Response {creditMemo: CreditMemoRecord}. Another company's memo is 404. ${memoRecordNote}`,
  params: z.object({ id: z.string().uuid() }),
}), async (req, res) => {
  res.json({ creditMemo: await salesDocs.getCreditMemoRecord(db, req.tenantId, req.params['id']!, req.companyId) });
});

creditMemosRouter.put('/:id', closingPasswordLimiter, lockContextMiddleware, idempotent({
  successStatus: 200,
  replay: async (req) => ({ creditMemo: await salesDocs.getCreditMemoRecord(db, req.tenantId, req.params['id']!, req.companyId), warnings: [] }),
}), validate(creditMemoSchema), describe({
  summary: 'Edit a credit memo (credit-memo-edit-v1)',
  description: `Response {creditMemo: CreditMemoRecord, warnings}. ${lineRules} expectedUpdatedAt: mismatch 409 STALE. The closing ` +
    'date meets the old date, the new date and every live refund\'s date. 409 CREDIT_IN_USE {inUse} when the new total is below what ' +
    'is applied and refunded, or the client changes while an application or refund is live; 400 SOURCE_DATE_AFTER_USE {firstUsed} ' +
    'when the new date is after its first later use; 400 CREDIT_MEMO_TOTAL_NOT_POSITIVE. Live applications are kept; ' +
    `applications in the body are ignored on PUT (use /apply, /unapply). ${closedPeriodNote}`,
  body: creditMemoSchema.extend(closing),
  params: z.object({ id: z.string().uuid() }),
}), async (req, res) => {
  res.json(await salesDocs.updateCreditMemoDocument(req.tenantId, req.params['id']!, req.body, req.userId, req.companyId));
});
