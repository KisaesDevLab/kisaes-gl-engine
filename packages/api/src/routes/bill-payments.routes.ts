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

billPaymentsRouter.get('/', async (req, res) => {
  const data = await billPaymentService.listBillPayments(req.tenantId, {
    contactId: req.query['contactId'] as string | undefined,
    startDate: req.query['startDate'] as string | undefined,
    endDate: req.query['endDate'] as string | undefined,
    limit: req.query['limit'] ? Number(req.query['limit']) : undefined,
    offset: req.query['offset'] ? Number(req.query['offset']) : undefined,
  });
  res.json({ data });
});

billPaymentsRouter.post('/', closingPasswordLimiter, lockContextMiddleware, validate(payBillsSchema), describe({
  summary: 'Pay bills',
  description: `Response 201 {payments}. ${closedPeriodNote} Only posted bills and credits: otherwise 400 BILL_NOT_PAYABLE / CREDIT_NOT_AVAILABLE; ` +
    'a bill not marked received is 409 BILL_NOT_RECEIVED (bill-received-v1). Amounts are compared exactly (no tolerance).',
  body: payBillsSchema.extend({ closingPassword: closingPasswordDoc, overrideConfirmed: z.boolean().optional() }),
}), async (req, res) => {
  const result = await billPaymentService.payBills(req.tenantId, req.body, req.userId, req.companyId);
  res.status(201).json(result);
});

billPaymentsRouter.get('/:id', async (req, res) => {
  const payment = await billPaymentService.getBillPayment(req.tenantId, req.params['id']!);
  res.json({ payment });
});

billPaymentsRouter.post('/:id/void', closingPasswordLimiter, lockContextMiddleware, validate(voidTransactionSchema), describe({
  summary: 'Void a bill payment',
  description: `Response 200 {voided: true}. ${closedPeriodNote} expectedUpdatedAt (ap-edit-v1): mismatch 409 STALE.`,
  body: voidTransactionSchema.extend({ closingPassword: closingPasswordDoc, overrideConfirmed: z.boolean().optional() }),
  params: z.object({ id: z.string().uuid() }),
}), async (req, res) => {
  await billPaymentService.voidBillPayment(req.tenantId, req.params['id']!, req.body.reason, req.userId, { expectedUpdatedAt: req.body.expectedUpdatedAt });
  res.json({ voided: true });
});
