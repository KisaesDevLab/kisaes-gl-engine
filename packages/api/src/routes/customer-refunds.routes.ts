// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { Router } from 'express';
import { z } from 'zod';
import { createCustomerRefundSchema } from '@kis-books/shared';
import { authenticate } from '../middleware/auth.js';
import { requireResource } from '../middleware/permission.js';
import { companyContext } from '../middleware/company.js';
import { validate } from '../middleware/validate.js';
import { describe } from '../middleware/describe.js';
import { closingPasswordLimiter } from '../middleware/closing-password-limiter.js';
import { lockContextMiddleware } from '../services/lock-context.js';
import { idempotent } from '../middleware/idempotent.js';
import * as ledger from '../services/ledger.service.js';
import * as customerRefundService from '../services/customer-refund.service.js';

/**
 * Customer refunds (U-133 payment-settle-v1). The same posting as POST
 * /transactions {txnType: 'customer_refund'}, with its own route so a
 * refund of a payment's credit carries the Receive Payment permission and
 * Idempotency-Key.
 */
export const customerRefundsRouter = Router();
customerRefundsRouter.use(authenticate);
customerRefundsRouter.use(companyContext);
customerRefundsRouter.use(requireResource('receive_payment'));

customerRefundsRouter.post('/', closingPasswordLimiter, lockContextMiddleware, idempotent({
  successStatus: 201,
  replay: async (req, entity) => ({ transaction: await ledger.getTransaction(req.tenantId, entity!.id, req.companyId) }),
}), validate(createCustomerRefundSchema), describe({
  summary: 'Refund a customer (payment-settle-v1)',
  description: 'Response 201 {transaction}: a customer_refund, Dr A/R / Cr refundFromAccountId. sourcePaymentId (optional): the ' +
    'customer payment whose unapplied credit this refunds, locked; the refund must be within its remaining credit (409 ' +
    'CREDIT_NOT_AVAILABLE {sourcePaymentId, remaining}); a bounced payment is 409 PAYMENT_BOUNCED; a payment of another client is 400 ' +
    'CREDIT_NOT_FOR_CUSTOMER. Voiding the refund gives the credit back; a payment with a live refund can\'t be voided or bounced ' +
    '(409 PAYMENT_REFUNDED, Q-P21j). Amounts whole cents (at most 2 places). A refund dated on or before the closing date needs ' +
    'closingPassword. U-139 (refund-credit-memo-v1, refund-checks-v1): sourcePaymentId (alias sourceId) may be a credit memo of the client; ' +
    'a refund dated before its source is 400 REFUND_DATE_BEFORE_SOURCE {sourceId, sourceDate}; refundFromAccountId must be a bank-type ' +
    'account of the company (not Payments Clearing, A/R or Customer Deposits): 400 REFUND_ACCOUNT_INVALID; printLater puts the refund ' +
    'in the check print queue (GET /checks/print-queue, payee address = the client billing address); paymentMethod check with no ' +
    'checkNumber defaults to printLater (Q-P22d); a typed checkNumber already used on the bank account is 409 CHECK_NUMBER_IN_USE; ' +
    'printLater true with a checkNumber is 400 CHECK_NUMBER_WITH_PRINT_LATER {field: checkNumber} (the print run numbers queued checks). ' +
    'Voiding the refund (POST /transactions/:id/void) takes it out of the queue and gives the credit back.',
  body: createCustomerRefundSchema.extend({ closingPassword: z.string().optional(), overrideConfirmed: z.boolean().optional() }),
}), async (req, res) => {
  const txn = await customerRefundService.createCustomerRefund(req.tenantId, req.body, req.userId, req.companyId, { strictAccount: true });
  res.status(201).json({ transaction: txn });
});

customerRefundsRouter.get('/:id', describe({
  summary: 'Get a customer refund (refund-credit-memo-v1)',
  description: 'Response {refund: RefundRecord}: {id, date, customerId, amount, method, refNo, checkNumber, printStatus (queue | ' +
    'printed | hand_written | null), refundFromAccountId, source: {id, kind: payment | credit_memo | deposit, number} | null, updatedAt, ' +
    'status}. Another company\'s refund is 404. Void it through POST /transactions/:id/void.',
  params: z.object({ id: z.string().uuid() }),
}), async (req, res) => {
  res.json({ refund: await customerRefundService.getRefundRecord(req.tenantId, req.params['id']!, req.companyId) });
});
