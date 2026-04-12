import { Router } from 'express';
import { createInvoiceSchema, transactionFiltersSchema } from '@kis-books/shared';
import { authenticate } from '../middleware/auth.js';
import { companyContext } from '../middleware/company.js';
import { validate } from '../middleware/validate.js';
import * as ledger from '../services/ledger.service.js';
import * as invoiceService from '../services/invoice.service.js';

export const estimatesRouter = Router();
estimatesRouter.use(authenticate);
estimatesRouter.use(companyContext);

estimatesRouter.get('/', async (req, res) => {
  // Estimates are stored as transactions with txnType='invoice' and status='draft', invoiceStatus='draft'
  // For a proper separation, we'd use a separate type. For now, query by a convention.
  const filters = transactionFiltersSchema.parse(req.query);
  // Estimates could be a separate txn_type in a future iteration
  res.json({ data: [], total: 0 });
});

estimatesRouter.post('/', validate(createInvoiceSchema), async (req, res) => {
  // Create as draft invoice (estimate)
  const estimate = await ledger.postTransaction(req.tenantId, {
    txnType: 'invoice',
    txnDate: req.body.txnDate,
    contactId: req.body.contactId,
    memo: req.body.memo,
    status: 'draft',
    invoiceStatus: 'draft',
    lines: req.body.lines.map((l: { accountId: string; quantity: string; unitPrice: string; description?: string }) => {
      const lineTotal = parseFloat(l.quantity) * parseFloat(l.unitPrice);
      return { accountId: l.accountId, debit: '0', credit: lineTotal.toFixed(4), description: l.description };
    }),
  }, req.userId, req.companyId);

  res.status(201).json({ estimate });
});

estimatesRouter.post('/:id/convert', async (req, res) => {
  // Convert estimate to a real invoice
  const estimate = await ledger.getTransaction(req.tenantId, req.params['id']!);

  const invoiceLines = estimate.lines.map((l) => ({
    accountId: l.accountId,
    description: l.description || undefined,
    quantity: l.quantity || '1',
    unitPrice: l.unitPrice || l.credit || '0',
    isTaxable: l.isTaxable ?? false,
    taxRate: l.taxRate || '0',
  }));

  const invoice = await invoiceService.createInvoice(req.tenantId, {
    txnDate: new Date().toISOString().split('T')[0]!,
    contactId: estimate.contactId!,
    lines: invoiceLines,
    memo: estimate.memo || undefined,
  }, req.userId, req.companyId);

  res.status(201).json({ invoice });
});
