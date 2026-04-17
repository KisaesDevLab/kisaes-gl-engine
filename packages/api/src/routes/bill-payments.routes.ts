// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { Router } from 'express';
import { payBillsSchema, voidTransactionSchema } from '@kis-books/shared';
import { authenticate } from '../middleware/auth.js';
import { companyContext } from '../middleware/company.js';
import { validate } from '../middleware/validate.js';
import * as billPaymentService from '../services/bill-payment.service.js';

export const billPaymentsRouter = Router();
billPaymentsRouter.use(authenticate);
billPaymentsRouter.use(companyContext);

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

billPaymentsRouter.post('/', validate(payBillsSchema), async (req, res) => {
  const result = await billPaymentService.payBills(req.tenantId, req.body, req.userId, req.companyId);
  res.status(201).json(result);
});

billPaymentsRouter.get('/:id', async (req, res) => {
  const payment = await billPaymentService.getBillPayment(req.tenantId, req.params['id']!);
  res.json({ payment });
});

billPaymentsRouter.post('/:id/void', validate(voidTransactionSchema), async (req, res) => {
  await billPaymentService.voidBillPayment(req.tenantId, req.params['id']!, req.body.reason, req.userId);
  res.json({ voided: true });
});
