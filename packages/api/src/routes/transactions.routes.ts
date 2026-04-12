import { Router } from 'express';
import {
  createJournalEntrySchema, createExpenseSchema, createTransferSchema,
  createDepositSchema, createCashSaleSchema, createCreditMemoSchema,
  createCustomerRefundSchema, voidTransactionSchema, transactionFiltersSchema,
} from '@kis-books/shared';
import { authenticate } from '../middleware/auth.js';
import { companyContext } from '../middleware/company.js';
import { validate } from '../middleware/validate.js';
import * as ledger from '../services/ledger.service.js';
import * as pdfService from '../services/pdf.service.js';
import * as emailService from '../services/email.service.js';
import * as journalEntryService from '../services/journal-entry.service.js';
import * as expenseService from '../services/expense.service.js';
import * as transferService from '../services/transfer.service.js';
import * as depositService from '../services/deposit.service.js';
import * as cashSaleService from '../services/cash-sale.service.js';
import * as creditMemoService from '../services/credit-memo.service.js';
import * as customerRefundService from '../services/customer-refund.service.js';
import * as attachmentService from '../services/attachment.service.js';

export const transactionsRouter = Router();
transactionsRouter.use(authenticate);
transactionsRouter.use(companyContext);

transactionsRouter.get('/', async (req, res) => {
  const filters = transactionFiltersSchema.parse(req.query);
  const result = await ledger.listTransactions(req.tenantId, filters, req.companyId);
  res.json(result);
});

transactionsRouter.post('/', async (req, res) => {
  const { txnType, ...body } = req.body;
  let result;

  switch (txnType) {
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

transactionsRouter.get('/:id', async (req, res) => {
  const txn = await ledger.getTransaction(req.tenantId, req.params['id']!);
  res.json({ transaction: txn });
});

transactionsRouter.post('/:id/void', validate(voidTransactionSchema), async (req, res) => {
  await ledger.voidTransaction(req.tenantId, req.params['id']!, req.body.reason, req.userId);
  const txn = await ledger.getTransaction(req.tenantId, req.params['id']!);
  res.json({ transaction: txn });
});

transactionsRouter.post('/:id/duplicate', async (req, res) => {
  const original = await ledger.getTransaction(req.tenantId, req.params['id']!);
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
