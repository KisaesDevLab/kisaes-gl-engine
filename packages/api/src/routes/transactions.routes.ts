// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { Router } from 'express';
import { z } from 'zod';
import {
  createJournalEntrySchema, createExpenseSchema, createTransferSchema,
  createDepositSchema, createCashSaleSchema, createCreditMemoSchema,
  createCustomerRefundSchema, voidTransactionSchema, transactionFiltersSchema,
  bulkUpdateTransactionsSchema, transactionRangeReportSchema, can,
} from '@kis-books/shared';
import { authenticate } from '../middleware/auth.js';
import { requireResource, resolvePermissionsForRequest } from '../middleware/permission.js';
import { expensiveOpLimiter } from '../middleware/expensive-op-limiter.js';
import { companyContext } from '../middleware/company.js';
import { validate } from '../middleware/validate.js';
import * as ledger from '../services/ledger.service.js';
import * as pdfService from '../services/pdf.service.js';
import * as emailService from '../services/email.service.js';
import * as journalEntryService from '../services/journal-entry.service.js';
import { AppError } from '../utils/errors.js';
import { lockContextMiddleware } from '../services/lock-context.js';
import * as expenseService from '../services/expense.service.js';
import * as transferService from '../services/transfer.service.js';
import * as depositService from '../services/deposit.service.js';
import * as cashSaleService from '../services/cash-sale.service.js';
import * as creditMemoService from '../services/credit-memo.service.js';
import * as customerRefundService from '../services/customer-refund.service.js';
import * as attachmentService from '../services/attachment.service.js';
import * as transactionReport from '../services/transaction-report.service.js';

export const transactionsRouter = Router();
transactionsRouter.use(authenticate);
transactionsRouter.use(companyContext);
transactionsRouter.use(requireResource('transactions'));
// Closed-period actor context (TB ADR-TB-04): carries userType +
// overrideConfirmed into the ledger choke point without threading it
// through every posting-service signature.
transactionsRouter.use(lockContextMiddleware);

transactionsRouter.get('/', async (req, res) => {
  const filters = transactionFiltersSchema.parse(req.query);
  const result = await ledger.listTransactions(req.tenantId, filters, req.companyId);
  res.json(result);
});

// How a date-range Transaction Report will be split: the parts, each with
// its dates and counts, so the screen can offer one link per part. Cheap —
// list query plus two attachment counts, no rendering.
transactionsRouter.get('/report-plan', async (req, res) => {
  const parsed = transactionRangeReportSchema.safeParse(req.query);
  if (!parsed.success) throw AppError.badRequest(parsed.error.issues[0]?.message ?? 'Invalid report filters');
  const { part: _part, ...filters } = parsed.data;
  const { plan } = await transactionReport.planTransactionRangeReport(req.tenantId, filters, req.companyId);
  res.json(plan);
});

// Transaction Report for a date range: every matching transaction's block,
// several to a page, then their attachments. Static path, declared before
// '/:id' so "report.pdf" is not read as an id. Same limiter and the same
// attachment-permission rule as the single-transaction report below.
transactionsRouter.get('/report.pdf', expensiveOpLimiter, async (req, res) => {
  const parsed = transactionRangeReportSchema.safeParse(req.query);
  if (!parsed.success) throw AppError.badRequest(parsed.error.issues[0]?.message ?? 'Invalid report filters');
  const perms = await resolvePermissionsForRequest(req);
  const report = await transactionReport.generateTransactionRangeReportPdf(req.tenantId, parsed.data, {
    companyId: req.companyId,
    includeAttachments: can(perms, 'attachments', 'read'),
    userId: req.userId,
  });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${report.fileName}"`);
  res.setHeader('X-Report-Warnings', String(report.warnings.length));
  res.setHeader('Access-Control-Expose-Headers', 'X-Report-Warnings, Content-Disposition');
  res.send(report.buffer);
});

// Bulk-edit Payee / Category / Tag across selected transactions from the
// list view. Static path declared before the '/:id' routes so it isn't
// captured as an id.
transactionsRouter.post('/bulk-update', validate(bulkUpdateTransactionsSchema), async (req, res) => {
  const result = await ledger.bulkUpdateTransactions(req.tenantId, req.body, req.userId, req.companyId);
  res.json(result);
});

transactionsRouter.post('/', async (req, res) => {
  const { txnType, ...body } = req.body;
  let result;

  switch (txnType) {
    case 'aje':
      // AJEs are created only through the TB module router, which is
      // firm-only and handles AJE numbering (rule TB3).
      throw AppError.badRequest('Adjusting journal entries are managed in the Trial Balance module', 'TB_AJE_ROUTE');
    case 'journal_entry':
      result = await journalEntryService.createJournalEntry(req.tenantId, createJournalEntrySchema.parse(body), req.userId, req.companyId);
      break;
    case 'expense':
      result = await expenseService.createExpense(req.tenantId, createExpenseSchema.parse(body), req.userId, req.companyId);
      break;
    case 'transfer':
      result = await transferService.createTransfer(req.tenantId, createTransferSchema.parse(body), req.userId, req.companyId);
      break;
    case 'deposit':
      result = await depositService.createDeposit(req.tenantId, createDepositSchema.parse(body), req.userId, req.companyId);
      break;
    case 'cash_sale':
      result = await cashSaleService.createCashSale(req.tenantId, createCashSaleSchema.parse(body), req.userId, req.companyId);
      break;
    case 'credit_memo':
      result = await creditMemoService.createCreditMemo(req.tenantId, createCreditMemoSchema.parse(body), req.userId, req.companyId);
      break;
    case 'customer_refund':
      result = await customerRefundService.createCustomerRefund(req.tenantId, createCustomerRefundSchema.parse(body), req.userId, req.companyId);
      break;
    default:
      res.status(400).json({ error: { message: `Unknown transaction type: ${txnType}` } });
      return;
  }

  // Reassign any draft attachments to the newly created transaction
  if (req.body.draftAttachmentId && result?.id) {
    await attachmentService.reassignDraftAttachments(
      req.tenantId, req.body.draftAttachmentId, txnType, result.id,
    );
  }

  res.status(201).json({ transaction: result });
});

transactionsRouter.put('/:id', async (req, res) => {
  const txnId = req.params['id']!;
  const { txnType, ...body } = req.body;
  let result;

  // An AJE can't be edited here — nor re-typed into an editable kind by
  // sending a different txnType against its id (rule TB3).
  const existingType = await ledger.getTransactionType(req.tenantId, txnId);
  if (txnType === 'aje' || existingType === 'aje') {
    throw AppError.badRequest('Adjusting journal entries are managed in the Trial Balance module', 'TB_AJE_ROUTE');
  }

  switch (txnType) {
    case 'journal_entry':
      result = await journalEntryService.updateJournalEntry(req.tenantId, txnId, createJournalEntrySchema.parse(body), req.userId, req.companyId);
      break;
    case 'expense':
      result = await expenseService.updateExpense(req.tenantId, txnId, createExpenseSchema.parse(body), req.userId, req.companyId);
      break;
    case 'transfer':
      result = await transferService.updateTransfer(req.tenantId, txnId, createTransferSchema.parse(body), req.userId, req.companyId);
      break;
    case 'deposit':
      result = await depositService.updateDeposit(req.tenantId, txnId, createDepositSchema.parse(body), req.userId, req.companyId);
      break;
    case 'cash_sale':
      result = await cashSaleService.updateCashSale(req.tenantId, txnId, createCashSaleSchema.parse(body), req.userId, req.companyId);
      break;
    default:
      res.status(400).json({ error: { message: `Editing ${txnType} transactions is not supported` } });
      return;
  }

  res.json({ transaction: result });
});

transactionsRouter.get('/:id/pdf', async (req, res) => {
  const pdf = await pdfService.generateInvoicePdf(req.tenantId, req.params['id']!);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="receipt-${req.params['id']}.pdf"`);
  res.send(pdf);
});

const txnIdParam = z.string().uuid();

// Everything directly tied to this transaction: payments applied to a bill,
// bills a payment paid, and the invoice-side equivalents.
transactionsRouter.get('/:id/related', async (req, res) => {
  const parsed = txnIdParam.safeParse(req.params['id']);
  if (!parsed.success) throw AppError.badRequest('Invalid transaction id');
  res.json(await transactionReport.getRelatedTransactions(req.tenantId, parsed.data, req.companyId));
});

// Transaction Report: summary of this transaction and everything linked to
// it, followed by their attachments. Launches Chromium, hence the limiter.
transactionsRouter.get('/:id/report.pdf', expensiveOpLimiter, async (req, res) => {
  const parsed = txnIdParam.safeParse(req.params['id']);
  if (!parsed.success) throw AppError.badRequest('Invalid transaction id');
  // The report embeds the attachments themselves, so reading transactions
  // is not enough to get them: without attachment access it is summary-only.
  const perms = await resolvePermissionsForRequest(req);
  const report = await transactionReport.generateTransactionReportPdf(req.tenantId, parsed.data, {
    companyId: req.companyId,
    includeAttachments: can(perms, 'attachments', 'read'),
    userId: req.userId,
  });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${report.fileName}"`);
  res.setHeader('X-Report-Warnings', String(report.warnings.length));
  res.setHeader('Access-Control-Expose-Headers', 'X-Report-Warnings, Content-Disposition');
  res.send(report.buffer);
});

transactionsRouter.get('/:id', async (req, res) => {
  const txn = await transactionReport.getTransactionDetail(req.tenantId, req.params['id']!);
  res.json({ transaction: txn });
});

transactionsRouter.post('/:id/void', validate(voidTransactionSchema), async (req, res) => {
  // AJE lifecycle is firm-only regardless of ledger permissions (TB3):
  // client-type users never touch it, staff can void here or via /tb.
  const voidType = await ledger.getTransactionType(req.tenantId, req.params['id']!);
  if (voidType === 'aje' && req.userType === 'client') {
    throw AppError.forbidden('Adjusting journal entries are managed by your accounting firm', 'TB_AJE_ROUTE');
  }
  await ledger.voidTransaction(req.tenantId, req.params['id']!, req.body.reason, req.userId);
  const txn = await ledger.getTransaction(req.tenantId, req.params['id']!);
  res.json({ transaction: txn });
});

transactionsRouter.post('/:id/duplicate', async (req, res) => {
  const original = await ledger.getTransaction(req.tenantId, req.params['id']!);
  // AJE duplication runs through /tb (numbering + firm gate, rule TB3).
  if (original.txnType === 'aje') {
    throw AppError.badRequest('Adjusting journal entries are managed in the Trial Balance module', 'TB_AJE_ROUTE');
  }
  const lines = original.lines.map((l) => ({
    accountId: l.accountId,
    debit: l.debit,
    credit: l.credit,
    description: l.description || undefined,
  }));

  const result = await ledger.postTransaction(req.tenantId, {
    txnType: original.txnType as any,
    txnDate: new Date().toISOString().split('T')[0]!,
    contactId: original.contactId || undefined,
    memo: original.memo || undefined,
    total: original.total || undefined,
    lines,
  }, req.userId, req.companyId);

  res.status(201).json({ transaction: result });
});
