// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { Router } from 'express';
import { createInvoiceSchema, recordPaymentSchema, voidTransactionSchema, transactionFiltersSchema } from '@kis-books/shared';
import { authenticate } from '../middleware/auth.js';
import { companyContext } from '../middleware/company.js';
import { validate } from '../middleware/validate.js';
import * as invoiceService from '../services/invoice.service.js';
import * as ledger from '../services/ledger.service.js';
import * as pdfService from '../services/pdf.service.js';
import * as emailService from '../services/email.service.js';

export const invoicesRouter = Router();
invoicesRouter.use(authenticate);
invoicesRouter.use(companyContext);

invoicesRouter.get('/', async (req, res) => {
  const filters = transactionFiltersSchema.parse(req.query);
  const result = await ledger.listTransactions(req.tenantId, { ...filters, txnType: 'invoice' }, req.companyId);
  res.json(result);
});

invoicesRouter.post('/', validate(createInvoiceSchema), async (req, res) => {
  const invoice = await invoiceService.createInvoice(req.tenantId, req.body, req.userId, req.companyId);
  res.status(201).json({ invoice });
});

invoicesRouter.get('/:id', async (req, res) => {
  const invoice = await ledger.getTransaction(req.tenantId, req.params['id']!);
  res.json({ invoice });
});

invoicesRouter.put('/:id', validate(createInvoiceSchema), async (req, res) => {
  const invoice = await invoiceService.updateInvoice(req.tenantId, req.params['id']!, req.body, req.userId, req.companyId);
  res.json({ invoice });
});

invoicesRouter.post('/:id/mark-sent', async (req, res) => {
  await invoiceService.markAsSent(req.tenantId, req.params['id']!, req.userId);
  const invoice = await ledger.getTransaction(req.tenantId, req.params['id']!);
  res.json({ invoice });
});

invoicesRouter.post('/:id/send', async (req, res) => {
  await invoiceService.sendInvoice(req.tenantId, req.params['id']!, req.userId);
  const invoice = await ledger.getTransaction(req.tenantId, req.params['id']!);
  res.json({ invoice });
});

invoicesRouter.post('/:id/payment', validate(recordPaymentSchema), async (req, res) => {
  const payment = await invoiceService.recordPayment(req.tenantId, req.params['id']!, req.body, req.userId, req.companyId);
  res.status(201).json({ payment });
});

invoicesRouter.post('/:id/void', validate(voidTransactionSchema), async (req, res) => {
  await invoiceService.voidInvoice(req.tenantId, req.params['id']!, req.body.reason, req.userId);
  const invoice = await ledger.getTransaction(req.tenantId, req.params['id']!);
  res.json({ invoice });
});

invoicesRouter.get('/:id/pdf', async (req, res) => {
  const pdf = await pdfService.generateInvoicePdf(req.tenantId, req.params['id']!);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="invoice-${req.params['id']}.pdf"`);
  res.send(pdf);
});

invoicesRouter.post('/:id/remind', async (req, res) => {
  await emailService.sendPaymentReminder(req.tenantId, req.params['id']!);
  res.json({ message: 'Reminder sent' });
});

invoicesRouter.post('/:id/share-link', async (req, res) => {
  if (req.userRole === 'readonly') {
    res.status(403).json({ error: { message: 'Readonly users cannot generate share links' } });
    return;
  }
  const link = await invoiceService.generateShareLink(req.tenantId, req.params['id']!, req.userId);
  res.json({ link });
});

invoicesRouter.post('/:id/duplicate', async (req, res) => {
  const invoice = await invoiceService.duplicateInvoice(req.tenantId, req.params['id']!, req.userId, req.companyId);
  res.status(201).json({ invoice });
});
