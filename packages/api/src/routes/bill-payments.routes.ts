// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { Router } from 'express';
import { z } from 'zod';
import { payBillsSchema, voidTransactionSchema } from '@kis-books/shared';
import { authenticate } from '../middleware/auth.js';
import { requireResource } from '../middleware/permission.js';
import { companyContext } from '../middleware/company.js';
import { validate } from '../middleware/validate.js';
import { describe } from '../middleware/describe.js';
import { closingPasswordLimiter } from '../middleware/closing-password-limiter.js';
import { lockContextMiddleware } from '../services/lock-context.js';
import { idempotent } from '../middleware/idempotent.js';
import * as billPaymentService from '../services/bill-payment.service.js';

export const billPaymentsRouter = Router();
billPaymentsRouter.use(authenticate);
billPaymentsRouter.use(companyContext);
billPaymentsRouter.use(requireResource('pay_bills'));

// Closed periods (U-83, ap-closing-v1; review S5): paying or voiding a
// payment dated on or before the closing date takes closingPassword.
const closingPasswordDoc = z.string().optional().describe('closing-date password (closing-password-v1); never stored or echoed');
const closedPeriodNote = 'A payment dated on or before the closing date needs closingPassword (or a staff overrideConfirmed): ' +
  '423 TB_PERIOD_LOCKED, 403 CLOSING_PASSWORD_INVALID, 429 CLOSING_PASSWORD_RATE_LIMIT (ap-closing-v1).';

// Payments of the request's company (U-104); rows without a company are
// included, as payBills accepts them.
billPaymentsRouter.get('/', async (req, res) => {
  const data = await billPaymentService.listBillPayments(req.tenantId, {
    contactId: req.query['contactId'] as string | undefined,
    startDate: req.query['startDate'] as string | undefined,
    endDate: req.query['endDate'] as string | undefined,
    limit: req.query['limit'] ? Number(req.query['limit']) : undefined,
    offset: req.query['offset'] ? Number(req.query['offset']) : undefined,
    companyId: req.companyId,
  });
  res.json({ data });
});

const payRules = 'bills[].amount is the bill\'s coverage including the credits applied to it (cash = amount - credits). ' +
  'bills[].discountAmount (bill-discounts-v1): early-payment discount, a decimal string >= 0 with at most 2 places, on top of amount; ' +
  'amount + discountAmount must not exceed the balance due; amount may be 0 only with a discount. Discounts post to discountAccountId, ' +
  'default the company setting billDiscountAccountId (GET/PUT /company/settings): none -> 400 DISCOUNT_ACCOUNT_REQUIRED; ' +
  'an account of another company, inactive, A/P or the bank account -> 400 DISCOUNT_ACCOUNT_INVALID. Each vendor payment posts ' +
  'DR A/P (amounts + discounts), CR bank (cash), CR A/P (credits), CR discount account (discounts). ' +
  'checkNumber (bill-payment-check-number-v1): method check with printLater false only (else 400 VALIDATION_ERROR); each vendor payment ' +
  'that pays cash takes the next number in the order of the response (a payment of credits and discounts only takes none), ' +
  'printStatus hand_written; a number another non-deleted transaction on the bank account holds (a void check keeps its number) -> 409 CHECK_NUMBER_IN_USE (details.checkNumber); ' +
  'the bank account\'s check counter moves past the last number (never back). method check_handwritten takes the next number from the company\'s counter for the bank account inside the payment\'s transaction (Q-PR2b).';

// Idempotency-Key (idempotency-pay-bills-v1, U-102): after the
// closed-period middleware, before validation (bills.routes.ts order).
// Replayed from the stored response; the reader rebuilds it from the
// payments the request posted.
billPaymentsRouter.post('/', closingPasswordLimiter, lockContextMiddleware, idempotent({
  successStatus: 201,
  replay: async (req, entity) => ({
    payments: await billPaymentService.paymentsPostedWith(req.tenantId, entity!.id, req.companyId),
  }),
}), validate(payBillsSchema), describe({
  summary: 'Pay bills',
  description: `Response 201 {payments}: one payment per vendor, each with billsPaid, creditsApplied, netPayment (the cash) and discountTotal. ${closedPeriodNote} ` +
    'Only posted bills and credits: otherwise 400 BILL_NOT_PAYABLE / CREDIT_NOT_AVAILABLE; ' +
    'a bill not marked received is 409 BILL_NOT_RECEIVED (bill-received-v1). Amounts are compared exactly (no tolerance). ' + payRules,
  body: payBillsSchema.extend({ closingPassword: closingPasswordDoc, overrideConfirmed: z.boolean().optional() }),
}), async (req, res) => {
  const result = await billPaymentService.payBills(req.tenantId, req.body, req.userId, req.companyId);
  res.status(201).json(result);
});

billPaymentsRouter.get('/:id', describe({
  summary: 'Get a bill payment',
  description: 'Response {payment} with billApplications (amount = cash, discountAmount) and creditApplications. ' +
    'Each bill application carries `bill` and each credit application `credit` (the vendor credit): ' +
    '{txnNumber, vendorInvoiceNumber, txnDate, total (decimal string)} or null (U-108, check-reprint-audit-v1). ' +
    'A payment of another company is 404 (U-104).',
  params: z.object({ id: z.string().uuid() }),
}), async (req, res) => {
  const payment = await billPaymentService.getBillPayment(req.tenantId, req.params['id']!, req.companyId);
  res.json({ payment });
});

// Idempotency-Key on void (idempotency-ap-v1).
billPaymentsRouter.post('/:id/void', closingPasswordLimiter, lockContextMiddleware, idempotent({
  successStatus: 200,
  replay: async () => ({ voided: true }),
}), validate(voidTransactionSchema), describe({
  summary: 'Void a bill payment',
  description: `Response 200 {voided: true}. ${closedPeriodNote} expectedUpdatedAt (ap-edit-v1): mismatch 409 STALE.`,
  body: voidTransactionSchema.extend({ closingPassword: closingPasswordDoc, overrideConfirmed: z.boolean().optional() }),
  params: z.object({ id: z.string().uuid() }),
}), async (req, res) => {
  await billPaymentService.voidBillPayment(req.tenantId, req.params['id']!, req.body.reason, req.userId, {
    expectedUpdatedAt: req.body.expectedUpdatedAt, companyId: req.companyId,
  });
  res.json({ voided: true });
});
