// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { Router } from 'express';
import { z } from 'zod';
import { applyCreditMemoSchema, unapplyCreditMemoSchema } from '@kis-books/shared';
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
