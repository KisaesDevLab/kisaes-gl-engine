// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { Router } from 'express';
import { z } from 'zod';
import { salesReceiptSchema, salesReceiptPreviewSchema } from '@kis-books/shared';
import { authenticate } from '../middleware/auth.js';
import { requireResource } from '../middleware/permission.js';
import { companyContext } from '../middleware/company.js';
import { validate } from '../middleware/validate.js';
import { describe } from '../middleware/describe.js';
import { closingPasswordLimiter } from '../middleware/closing-password-limiter.js';
import { lockContextMiddleware } from '../services/lock-context.js';
import { idempotent } from '../middleware/idempotent.js';
import { db } from '../db/index.js';
import * as salesDocs from '../services/sales-docs.service.js';

/**
 * Sales receipts (U-143, sales-receipt-lines-v1): a cash sale on the invoice
 * line model. The same posting type as POST /transactions {txnType:
 * 'cash_sale'} (which is unchanged), under the resource the permission
 * templates already map cash sales to (transactions).
 */
export const salesReceiptsRouter = Router();
salesReceiptsRouter.use(authenticate);
salesReceiptsRouter.use(companyContext);
salesReceiptsRouter.use(requireResource('transactions'));

const closing = {
  closingPassword: z.string().optional().describe('closing-date password (closing-password-v1); never stored or echoed'),
  overrideConfirmed: z.boolean().optional(),
};
const closedPeriodNote = 'A change dated on or before the closing date needs closingPassword (or a staff overrideConfirmed): ' +
  'without it 423 CLOSED_PERIOD; a wrong password 403; too many tries 429.';
const rules = 'Lines as invoice lines (itemId or accountId, quantity, unitPrice, discountPercent, isTaxable, taxRate, tagId, ' +
  'serviceDate); billable-cost fields are 400 VALIDATION_ERROR. Posting: Dr depositToAccountId (default Payments Clearing) the total, ' +
  'Cr each income line, Cr Sales Tax Payable the tax. A total below 0.00 (a return with money back) to Payments Clearing is 400 ' +
  'NEGATIVE_RECEIPT_NEEDS_BANK; a deposit account that is not an asset of this company (or is A/R / Customer Deposits) is 400 ' +
  'DEPOSIT_ACCOUNT_INVALID.';
const recordNote = 'SalesReceiptRecord: {id, number, date, customerId, depositToAccountId, paymentMethod, refNo, lines, totals: ' +
  '{subtotal, taxTotal, total}, memo, customerMessage, hideZeroLines, layoutId, printLater, updatedAt, status, deposited}.';

salesReceiptsRouter.post('/preview', validate(salesReceiptPreviewSchema), describe({
  summary: 'Preview a sales receipt; posts nothing (sales-receipt-lines-v1)',
  description: 'Response {lines, subtotal, taxableBase, taxRate, taxTotal, total, taxGroups, depositToAccountId, contactBalanceBefore, ' +
    `contactBalanceAfter, problems: [{code: NEGATIVE_RECEIPT_NEEDS_BANK | DEPOSIT_ACCOUNT_INVALID}]}; never 4xx for those. ${rules}`,
  body: salesReceiptPreviewSchema,
}), async (req, res) => {
  res.json(await salesDocs.previewSalesReceipt(req.tenantId, req.body, req.companyId));
});

salesReceiptsRouter.post('/', closingPasswordLimiter, lockContextMiddleware, idempotent({
  successStatus: 201,
  replay: async (req, entity) => ({ salesReceipt: await salesDocs.getSalesReceiptRecord(db, req.tenantId, entity!.id, req.companyId), warnings: [] }),
}), validate(salesReceiptSchema), describe({
  summary: 'Create a sales receipt (sales-receipt-lines-v1)',
  description: `Response 201 {salesReceipt: SalesReceiptRecord, warnings}. ${rules} txnNumber: typed or the next from the cash_sale ` +
    `counter. ${closedPeriodNote} ${recordNote}`,
  body: salesReceiptSchema.extend(closing),
}), async (req, res) => {
  res.status(201).json(await salesDocs.createSalesReceipt(req.tenantId, req.body, req.userId, req.companyId));
});

salesReceiptsRouter.get('/:id', describe({
  summary: 'Get a sales receipt (sales-receipt-lines-v1)',
  description: `Response {salesReceipt: SalesReceiptRecord}. Another company's receipt is 404. ${recordNote}`,
  params: z.object({ id: z.string().uuid() }),
}), async (req, res) => {
  res.json({ salesReceipt: await salesDocs.getSalesReceiptRecord(db, req.tenantId, req.params['id']!, req.companyId) });
});

salesReceiptsRouter.put('/:id', closingPasswordLimiter, lockContextMiddleware, idempotent({
  successStatus: 200,
  replay: async (req) => ({ salesReceipt: await salesDocs.getSalesReceiptRecord(db, req.tenantId, req.params['id']!, req.companyId), warnings: [] }),
}), validate(salesReceiptSchema), describe({
  summary: 'Edit a sales receipt (sales-receipt-lines-v1)',
  description: `Response {salesReceipt: SalesReceiptRecord, warnings}. ${rules} expectedUpdatedAt: mismatch 409 STALE; the closing ` +
    'date meets the old and the new date; a receipt in a deposit can\'t change its deposit account or amount (409 TXN_DEPOSITED). ' +
    `depositToAccountId omitted keeps the current one. ${closedPeriodNote}`,
  body: salesReceiptSchema.extend(closing),
  params: z.object({ id: z.string().uuid() }),
}), async (req, res) => {
  res.json(await salesDocs.updateSalesReceipt(req.tenantId, req.params['id']!, req.body, req.userId, req.companyId));
});
