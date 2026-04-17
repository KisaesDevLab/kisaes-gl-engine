// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { Router } from 'express';
import { receivePaymentSchema } from '@kis-books/shared';
import { authenticate } from '../middleware/auth.js';
import { companyContext } from '../middleware/company.js';
import { validate } from '../middleware/validate.js';
import * as paymentService from '../services/payment.service.js';

export const paymentsRouter = Router();
paymentsRouter.use(authenticate);
paymentsRouter.use(companyContext);

paymentsRouter.post('/receive', validate(receivePaymentSchema), async (req, res) => {
  const payment = await paymentService.receivePayment(req.tenantId, req.body, req.userId, req.companyId);
  res.status(201).json({ payment });
});

paymentsRouter.get('/open-invoices/:customerId', async (req, res) => {
  const invoices = await paymentService.getOpenInvoicesForCustomer(req.tenantId, req.params['customerId']!);
  res.json({ invoices });
});

paymentsRouter.get('/for-invoice/:invoiceId', async (req, res) => {
  const payments = await paymentService.getPaymentsForInvoice(req.tenantId, req.params['invoiceId']!);
  res.json({ payments });
});

paymentsRouter.get('/pending-deposits', async (req, res) => {
  const result = await paymentService.getPendingDeposits(req.tenantId);
  res.json(result);
});

paymentsRouter.post('/unapply', async (req, res) => {
  await paymentService.unapplyPayment(req.tenantId, req.body.paymentId, req.body.invoiceId);
  res.json({ message: 'Payment unapplied' });
});
