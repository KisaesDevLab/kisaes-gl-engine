// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { Router } from 'express';
import { createInvoiceSchema, recordPaymentSchema, voidTransactionSchema, transactionFiltersSchema } from '@kis-books/shared';
import { authenticate } from '../middleware/auth.js';
import { requireResource } from '../middleware/permission.js';
import { companyContext } from '../middleware/company.js';
import { validate } from '../middleware/validate.js';
import { idempotent } from '../middleware/idempotent.js';
import { describe } from '../middleware/describe.js';
import * as invoiceService from '../services/invoice.service.js';
import * as ledger from '../services/ledger.service.js';
import * as pdfService from '../services/pdf.service.js';
import * as emailService from '../services/email.service.js';
import { auditLog } from '../middleware/audit.js';

export const invoicesRouter = Router();
invoicesRouter.use(authenticate);
invoicesRouter.use(companyContext);
invoicesRouter.use(requireResource('invoices'));

invoicesRouter.get('/', async (req, res) => {
  const filters = transactionFiltersSchema.parse(req.query);
  const result = await ledger.listTransactions(req.tenantId, { ...filters, txnType: 'invoice' }, req.companyId);
  res.json(result);
});

// Idempotency-Key (idempotency-v1, U-18).
invoicesRouter.post('/', idempotent({
  successStatus: 201,
  replay: async (req, entity) => ({ invoice: await ledger.getTransaction(req.tenantId, entity!.id) }),
}), validate(createInvoiceSchema), describe({
  summary: 'Create an invoice',
  description: 'Response 201 `{invoice, warnings}`. No txnNumber: the next free number from the company\'s invoice counter '
    + '(numbers a live invoice already holds are skipped; a refused post takes no number). A typed txnNumber already used by '
    + 'an invoice of the company is 409 DOCUMENT_NUMBER_IN_USE (details {txnNumber, transactionId}), or posts with it listed in '
    + '`warnings` when warnOnly is true (document-numbers-v1). An idempotent replay (same Idempotency-Key) returns only '
    + '`{invoice}`, without `warnings`: treat it as absent-safe.',
}), async (req, res) => {
  // warnings (U-111): duplicate-number warnings of a warnOnly request; [] otherwise.
  const { invoice, warnings } = await invoiceService.createInvoiceWithWarnings(req.tenantId, req.body, req.userId, req.companyId);
  res.status(201).json({ invoice, warnings });
});

invoicesRouter.get('/:id', async (req, res) => {
  const invoice = await ledger.getTransaction(req.tenantId, req.params['id']!);
  res.json({ invoice });
});

invoicesRouter.put('/:id', validate(createInvoiceSchema), async (req, res) => {
  const { invoice, warnings } = await invoiceService.updateInvoiceWithWarnings(req.tenantId, req.params['id']!, req.body, req.userId, req.companyId);
  res.json({ invoice, warnings });
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
  const { baseUrlFor } = await import('../utils/base-url.js');
  await emailService.sendPaymentReminder(req.tenantId, req.params['id']!, baseUrlFor(req));
  res.json({ message: 'Reminder sent' });
});

invoicesRouter.post('/:id/share-link', async (req, res) => {
  if (req.userRole === 'readonly') {
    res.status(403).json({ error: { message: 'Readonly users cannot generate share links' } });
    return;
  }
  const { baseUrlFor } = await import('../utils/base-url.js');
  const link = await invoiceService.generateShareLink(req.tenantId, req.params['id']!, req.userId, baseUrlFor(req));
  res.json({ link });
});

// Kill an issued public link (see revokePublicToken). Owners/accountants
// only — same gate as minting.
invoicesRouter.delete('/:id/share-link', async (req, res) => {
  if (req.userRole === 'readonly') {
    res.status(403).json({ error: { message: 'Readonly users cannot manage share links' } });
    return;
  }
  const publicInvoice = await import('../services/public-invoice.service.js');
  const result = await publicInvoice.revokePublicToken(req.tenantId, req.params['id']!);
  await auditLog(req.tenantId, 'update', 'invoice', req.params['id']!, null, { action: 'share_link_revoked' }, req.userId);
  res.json(result);
});

invoicesRouter.post('/:id/duplicate', async (req, res) => {
  const invoice = await invoiceService.duplicateInvoice(req.tenantId, req.params['id']!, req.userId, req.companyId);
  res.status(201).json({ invoice });
});
