// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { Router } from 'express';
import { z } from 'zod';
import { createVendorCreditSchema, voidTransactionSchema } from '@kis-books/shared';
import { authenticate } from '../middleware/auth.js';
import { requireResource } from '../middleware/permission.js';
import { companyContext } from '../middleware/company.js';
import { validate } from '../middleware/validate.js';
import { describe } from '../middleware/describe.js';
import { closingPasswordLimiter } from '../middleware/closing-password-limiter.js';
import { lockContextMiddleware } from '../services/lock-context.js';
import * as vendorCreditService from '../services/vendor-credit.service.js';
import { pickEnum } from '../utils/list-query.js';

export const vendorCreditsRouter = Router();
vendorCreditsRouter.use(authenticate);
vendorCreditsRouter.use(companyContext);
vendorCreditsRouter.use(requireResource('vendor_credits'));

// Closed periods (U-83, ap-closing-v1): limiter → lock context → validate,
// as on checks and bills.
const closingPasswordDoc = z.string().optional().describe('closing-date password (closing-password-v1); never stored or echoed');
const closedPeriodNote = 'A credit dated on or before the closing date (for an edit, the old or the new date) needs closingPassword (or a staff overrideConfirmed): ' +
  '423 TB_PERIOD_LOCKED, 403 CLOSING_PASSWORD_INVALID, 429 CLOSING_PASSWORD_RATE_LIMIT (ap-closing-v1).';
const lineRules = 'Lines take itemId, quantity, unitPrice, tagId and contactId as bill lines do (bill-lines-v1); isBillable may only be false or absent.';
const creditBodyDoc = createVendorCreditSchema.extend({ closingPassword: closingPasswordDoc, overrideConfirmed: z.boolean().optional() });
const voidBodyDoc = voidTransactionSchema.extend({ closingPassword: closingPasswordDoc, overrideConfirmed: z.boolean().optional() });
const idParams = z.object({ id: z.string().uuid() });

vendorCreditsRouter.get('/', describe({
  summary: 'List vendor credits',
  description: 'Rows carry vendorInvoiceNumber and updatedAt; search also matches vendorInvoiceNumber.',
}), async (req, res) => {
  const result = await vendorCreditService.listVendorCredits(req.tenantId, {
    contactId: req.query['contactId'] as string | undefined,
    startDate: req.query['startDate'] as string | undefined,
    endDate: req.query['endDate'] as string | undefined,
    search: req.query['search'] as string | undefined,
    sortBy: pickEnum(req.query['sortBy'], vendorCreditService.VENDOR_CREDIT_SORT_KEYS),
    sortDir: pickEnum(req.query['sortDir'], ['asc', 'desc'] as const),
    limit: req.query['limit'] ? Number(req.query['limit']) : undefined,
    offset: req.query['offset'] ? Number(req.query['offset']) : undefined,
  }, req.companyId);
  res.json(result);
});

vendorCreditsRouter.get('/available/:vendorId', async (req, res) => {
  const credits = await vendorCreditService.getAvailableCredits(req.tenantId, req.params['vendorId']!);
  res.json({ credits });
});

vendorCreditsRouter.post('/', closingPasswordLimiter, lockContextMiddleware, validate(createVendorCreditSchema), describe({
  summary: 'Enter a vendor credit',
  description: `Response 201 {credit}. ${closedPeriodNote} ${lineRules} draftAttachmentId: relinked (attachable type "vendor_credit") in the same database transaction.`,
  body: creditBodyDoc,
}), async (req, res) => {
  const credit = await vendorCreditService.createVendorCredit(req.tenantId, req.body, req.userId, req.companyId);
  res.status(201).json({ credit: await vendorCreditService.getVendorCredit(req.tenantId, credit.id) });
});

vendorCreditsRouter.get('/:id', describe({ summary: 'Get a vendor credit', params: idParams }), async (req, res) => {
  const credit = await vendorCreditService.getVendorCredit(req.tenantId, req.params['id']!);
  res.json({ credit });
});

// U-84 (ap-edit-v1): edit with the create body.
vendorCreditsRouter.put('/:id', closingPasswordLimiter, lockContextMiddleware, validate(createVendorCreditSchema), describe({
  summary: 'Edit a vendor credit',
  description: `Response 200 {credit} as committed. ${closedPeriodNote} ${lineRules} ` +
    'Refused while a bill payment applies it or a deposit refunds it: 409 CREDIT_APPLIED (details.applications, details.refundDepositIds). ' +
    'expectedUpdatedAt: mismatch 409 STALE (details.updatedAt). The open balance is recomputed.',
  body: creditBodyDoc,
  params: idParams,
}), async (req, res) => {
  const credit = await vendorCreditService.updateVendorCredit(req.tenantId, req.params['id']!, req.body, req.userId, req.companyId);
  res.json({ credit });
});

vendorCreditsRouter.post('/:id/void', closingPasswordLimiter, lockContextMiddleware, validate(voidTransactionSchema), describe({
  summary: 'Void a vendor credit',
  description: `Response 200 {credit}. ${closedPeriodNote} Refused while applied to a bill (409 CREDIT_APPLIED) or refunded by a deposit (409 TXN_DEPOSITED). ` +
    'expectedUpdatedAt: mismatch 409 STALE.',
  body: voidBodyDoc,
  params: idParams,
}), async (req, res) => {
  await vendorCreditService.voidVendorCredit(req.tenantId, req.params['id']!, req.body.reason, req.userId, { expectedUpdatedAt: req.body.expectedUpdatedAt });
  const credit = await vendorCreditService.getVendorCredit(req.tenantId, req.params['id']!);
  res.json({ credit });
});
