// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import {
  createJournalEntrySchema, createExpenseSchema, createTransferSchema,
  createDepositSchema, createCashSaleSchema, createCreditMemoSchema,
  createCustomerRefundSchema, voidTransactionSchema, deleteTransactionSchema, transactionFiltersSchema,
  bulkUpdateTransactionsSchema, transactionRangeReportSchema, can,
} from '@kis-books/shared';
import { authenticate } from '../middleware/auth.js';
import { requireResource, resolvePermissionsForRequest } from '../middleware/permission.js';
import { expensiveOpLimiter } from '../middleware/expensive-op-limiter.js';
import { companyContext } from '../middleware/company.js';
import { validate } from '../middleware/validate.js';
import { describe } from '../middleware/describe.js';
import { idempotent } from '../middleware/idempotent.js';
import { apDocumentPermission } from '../middleware/ap-document-permission.js';
import * as ledger from '../services/ledger.service.js';
import * as pdfService from '../services/pdf.service.js';
import * as emailService from '../services/email.service.js';
import * as journalEntryService from '../services/journal-entry.service.js';
import { AppError } from '../utils/errors.js';
import { lockContextMiddleware } from '../services/lock-context.js';
import { closingPasswordLimiter } from '../middleware/closing-password-limiter.js';
import * as expenseService from '../services/expense.service.js';
import * as transferService from '../services/transfer.service.js';
import * as depositService from '../services/deposit.service.js';
import * as cashSaleService from '../services/cash-sale.service.js';
import * as creditMemoService from '../services/credit-memo.service.js';
import * as customerRefundService from '../services/customer-refund.service.js';
import * as attachmentService from '../services/attachment.service.js';
import * as transactionReport from '../services/transaction-report.service.js';
import * as transactionActivity from '../services/transaction-activity.service.js';
import * as txnListExport from '../services/transaction-list-export.service.js';
import { auditLog } from '../middleware/audit.js';
import * as featureFlags from '../services/feature-flags.service.js';

export const transactionsRouter = Router();
transactionsRouter.use(authenticate);
transactionsRouter.use(companyContext);
transactionsRouter.use(requireResource('transactions'));
// Closed-period actor context (TB ADR-TB-04): carries userType +
// overrideConfirmed and the closing-date password (U-15) into the ledger
// choke point without threading it through every posting-service
// signature. The limiter counts failed password attempts and must see the
// body before lockContextMiddleware strips the password from it.
transactionsRouter.use(closingPasswordLimiter);
transactionsRouter.use(lockContextMiddleware);

// Idempotency-Key (idempotency-v1, U-18) on create, edit, void and delete.
// The readers replay the record as it is now, in the route's shape, when
// no stored response is left (the settle failed or the body was too big).
const keyedCreate = idempotent({
  successStatus: 201,
  replay: async (req, entity) => ({ transaction: await ledger.getTransaction(req.tenantId, entity!.id) }),
});
const keyedById = idempotent({
  successStatus: 200,
  replay: async (req) => ({ transaction: await ledger.getTransaction(req.tenantId, req.params['id']!) }),
});

transactionsRouter.get('/', describe({
  summary: 'List transactions',
  description: 'Rows carry `isAdjusting` and `reversesTransactionId` (je-adjusting-v1, je-reversing-v1); `adjusting=include|exclude|only` filters adjusting entries.',
  query: transactionFiltersSchema,
}), async (req, res) => {
  const filters = transactionFiltersSchema.parse(req.query);
  const result = await ledger.listTransactions(req.tenantId, filters, req.companyId);
  res.json(result);
});

// Transactions list → CSV / PDF. The WHOLE filtered + sorted list (every
// page, capped — see TXN_EXPORT_LIMITS), one row per transaction in the
// General Ledger's column layout. Same filters, tenant/company scope and
// permission (the router's requireResource('transactions')) as GET '/'.
// Paging params are accepted and ignored so the screen can pass its query
// string through unchanged. Static path, declared before '/:id'.
const transactionListExportSchema = transactionFiltersSchema
  .omit({ limit: true, offset: true, invoiceStatus: true })
  .extend({
    format: z.enum(['csv', 'pdf']),
    tz: z.string().max(64).optional(),
  });

transactionsRouter.get('/export', expensiveOpLimiter, async (req, res) => {
  const { limit: _l, offset: _o, ...query } = req.query;
  const parsed = transactionListExportSchema.safeParse(query);
  if (!parsed.success) throw AppError.badRequest(parsed.error.issues[0]?.message ?? 'Invalid export filters');
  const { format, tz, ...filters } = parsed.data;
  const data = await txnListExport.buildTransactionListExport(req.tenantId, req.companyId, filters, format);

  // Metadata only — the filters asked for and what came back, never rows.
  await auditLog(req.tenantId, 'download', 'transaction_list_export', null, null, {
    format, rowCount: data.rows.length, matched: data.matched, truncated: data.truncated, companyId: req.companyId, filters,
  }, req.userId);

  res.setHeader('X-Export-Row-Count', String(data.rows.length));
  res.setHeader('X-Export-Truncated', String(data.truncated));
  res.setHeader('Access-Control-Expose-Headers', 'X-Export-Row-Count, X-Export-Truncated, Content-Disposition');
  if (format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${txnListExport.exportFileName('csv')}"`);
    res.send(txnListExport.toTransactionListCsv(data));
    return;
  }
  const pdf = await txnListExport.toTransactionListPdf(data, { timeZone: tz });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${txnListExport.exportFileName('pdf')}"`);
  res.send(pdf);
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

// OpenAPI only: the request bodies this route takes for the register
// entry types ClientLedger posts (deposit, transfer, expense, journal
// entry). Validation stays per txnType in the handler; other types are
// documented elsewhere.
const closingPasswordDoc = z.string().optional().describe('closing-date password (closing-password-v1); never stored or echoed');
const registerEntryBodyDoc = z.discriminatedUnion('txnType', [
  createDepositSchema.extend({ txnType: z.literal('deposit'), closingPassword: closingPasswordDoc }),
  createTransferSchema.extend({ txnType: z.literal('transfer'), closingPassword: closingPasswordDoc }),
  createExpenseSchema.extend({ txnType: z.literal('expense'), closingPassword: closingPasswordDoc }),
  createJournalEntrySchema.extend({ txnType: z.literal('journal_entry'), closingPassword: closingPasswordDoc }),
]);

transactionsRouter.post('/', keyedCreate, describe({
  summary: 'Create a transaction (body per txnType; deposit, transfer, expense and journal entry documented)',
  description: 'Response 201 `{transaction}`; a deposit adds `clearingWouldGoNegative` (boolean): true when Payments Clearing holds a net credit after posting. ' +
    'A journal entry (je-names-v1, je-number-v1, je-adjusting-v1, je-reversing-v1): every A/R or A/P line needs contactId (400 JE_AR_AP_NAME_REQUIRED), any number of such lines is allowed; ' +
    'with reverseOn the response carries `reversalTransactionId` and `reverseOn` of the reversing entry posted with it.',
  body: registerEntryBodyDoc,
}), async (req, res) => {
  const { txnType, ...body } = req.body;
  let result;
  // Deposit warnings (clearingWouldGoNegative); empty for other types.
  let extra: Record<string, unknown> = {};

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
    case 'deposit': {
      const deposit = await depositService.createDepositWithWarnings(req.tenantId, createDepositSchema.parse(body), req.userId, req.companyId);
      result = deposit.transaction;
      extra = { clearingWouldGoNegative: deposit.clearingWouldGoNegative };
      break;
    }
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
      req.tenantId, req.body.draftAttachmentId, txnType, result.id, undefined, req.companyId,
    );
  }

  res.status(201).json({ transaction: result, ...extra });
});

transactionsRouter.put('/:id', apDocumentPermission('update'), keyedById, describe({
  summary: 'Edit a transaction (body per txnType; deposit, transfer, expense and journal entry documented)',
  description: 'Response 200 `{transaction}`; a deposit adds `clearingWouldGoNegative` (boolean). A deposit edit on a transaction that is not a deposit is 404. ' +
    'A journal entry edit: reverseOn omitted keeps the automatic reversal on its stored date (re-posted there when the edit changes it), null removes it, ' +
    'a date moves or creates it; replacing or removing a reversal changed since it was created is 409 REVERSAL_EDITED. ' +
    'ledger-guards-v1: a deposit edit that sends a linked line (payment or vendor refund) back without its sourceTransactionId while keeping an unlinked line on that account is 409 DEPOSIT_LINKS_DROPPED (details.sourceTransactionIds); ' +
    'an expense edit of a printed check that changes its printed face (amount, payee, memo line, bank account, date) is 409 CHECK_PRINTED (details.checkNumber, printedAt, changedFields), edit it with PUT /checks/:id; ' +
    'a check keeps its own header tags.',
  body: registerEntryBodyDoc,
  params: z.object({ id: z.string().uuid() }),
}), async (req, res) => {
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
    case 'deposit': {
      const deposit = await depositService.updateDepositWithWarnings(req.tenantId, txnId, createDepositSchema.parse(body), req.userId, req.companyId);
      res.json({ transaction: deposit.transaction, clearingWouldGoNegative: deposit.clearingWouldGoNegative });
      return;
    }
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

// Activity card: everything recorded about this transaction, oldest first
// (created / edited / voided, the bank-feed item it came from, review marks,
// attachments, review findings, client questions).
transactionsRouter.get('/:id/activity', async (req, res) => {
  const parsed = txnIdParam.safeParse(req.params['id']);
  if (!parsed.success) throw AppError.badRequest('Invalid transaction id');
  const events = await transactionActivity.getTransactionActivity(req.tenantId, parsed.data, req.companyId);
  res.json({ events });
});

// ?activity=1 adds each transaction's activity log under its block; ?tz=
// is the viewer's IANA zone for the activity times (invalid → UTC).
const singleReportQuery = z.object({
  activity: z.string().optional(),
  tz: z.string().max(64).optional(),
}).passthrough();

// Transaction Report: summary of this transaction and everything linked to
// it, followed by their attachments. Launches Chromium, hence the limiter.
transactionsRouter.get('/:id/report.pdf', expensiveOpLimiter, async (req, res) => {
  const parsed = txnIdParam.safeParse(req.params['id']);
  if (!parsed.success) throw AppError.badRequest('Invalid transaction id');
  // The report embeds the attachments themselves, so reading transactions
  // is not enough to get them: without attachment access it is summary-only.
  const perms = await resolvePermissionsForRequest(req);
  const q = singleReportQuery.parse(req.query);
  const report = await transactionReport.generateTransactionReportPdf(req.tenantId, parsed.data, {
    companyId: req.companyId,
    includeAttachments: can(perms, 'attachments', 'read'),
    userId: req.userId,
    includeActivity: q.activity === '1' || q.activity === 'true',
    timeZone: q.tz,
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

// The AJE rules of void run as middleware ahead of idempotent(), so a
// replay of a void is refused exactly like a first attempt (U-18).
async function voidAjeGuard(req: Request, _res: Response, next: NextFunction) {
  // AJE lifecycle is firm-only regardless of ledger permissions (TB3):
  // client-type users never touch it, staff can void here or via /tb.
  const voidType = await ledger.getTransactionType(req.tenantId, req.params['id']!);
  if (voidType === 'aje' && req.userType === 'client') {
    throw AppError.forbidden('Adjusting journal entries are managed by your accounting firm', 'TB_AJE_ROUTE');
  }
  // With TRIAL_BALANCE_V1 off the whole AJE lifecycle is absent (as on
  // /tb), so an AJE can't be voided through this route either.
  if (voidType === 'aje' && !(await featureFlags.isEnabled(req.tenantId, 'TRIAL_BALANCE_V1'))) {
    throw AppError.badRequest('Adjusting journal entries are managed in the Trial Balance module', 'TB_AJE_ROUTE');
  }
  next();
}

transactionsRouter.post('/:id/void', voidAjeGuard, apDocumentPermission('update'), keyedById, validate(voidTransactionSchema), async (req, res) => {
  // A/P documents keep their sub-ledger right here too (ap-edit-v1, review
  // B1): a bill or vendor credit with anything applied is 409
  // BILL_HAS_PAYMENTS / CREDIT_APPLIED; a bill payment is voided with its
  // applications (the bills and credits it settled reopen). A transaction
  // of another company is 404 (review M3).
  await ledger.voidTransaction(req.tenantId, req.params['id']!, req.body.reason, req.userId, {
    expectedUpdatedAt: req.body.expectedUpdatedAt, companyId: req.companyId,
  });
  const txn = await ledger.getTransaction(req.tenantId, req.params['id']!);
  res.json({ transaction: txn });
});

// Soft delete (P12 R7, capability txn-delete-v1). Body optional:
// { reason?, closingPassword?, expectedUpdatedAt? } — the password is taken
// out of the body by lockContextMiddleware and opens a closed period exactly
// as for void. Bills and vendor credits with nothing applied are deletable
// (ap-edit-v1): 409 BILL_HAS_PAYMENTS / CREDIT_APPLIED otherwise.
// Same router permission as void (transactions: update). The transaction
// keeps its lines plus reversing lines and becomes status 'deleted', hidden
// from registers, reports, balances and lists. Errors: 404 not found,
// 409 TXN_ALREADY_DELETED / RECONCILED_TRANSACTION / TXN_DELETE_UNSUPPORTED
// / TXN_DELETE_LINKED, 400 TB_AJE_ROUTE, 423 TB_PERIOD_LOCKED,
// 403 CLOSING_PASSWORD_INVALID, 429 CLOSING_PASSWORD_RATE_LIMIT.
const deleteTransactionBodyDoc = deleteTransactionSchema.extend({
  closingPassword: z.string().optional().describe('closing-date password (closing-password-v1); never stored or echoed'),
});

transactionsRouter.delete('/:id', apDocumentPermission('delete'), keyedById, (req, _res, next) => {
  // A DELETE often has no body at all.
  if (!req.body || typeof req.body !== 'object') req.body = {};
  next();
}, validate(deleteTransactionSchema), describe({
  summary: 'Delete a transaction (soft delete with reversing lines; txn-delete-v1)',
  description: 'ap-edit-v1: bills and vendor credits are deletable while nothing is applied (409 BILL_HAS_PAYMENTS / CREDIT_APPLIED; a refunded credit 409 TXN_DELETE_LINKED; ' +
    'a bill entered from a bill capture 409 TXN_DELETE_LINKED with links ["bill_capture"]). expectedUpdatedAt: mismatch 409 STALE (details.updatedAt).',
  body: deleteTransactionBodyDoc,
  params: z.object({ id: z.string().uuid() }),
}), async (req, res) => {
  const parsed = txnIdParam.safeParse(req.params['id']);
  if (!parsed.success) throw AppError.badRequest('Invalid transaction id');
  await ledger.deleteTransaction(req.tenantId, parsed.data, {
    reason: req.body.reason, userId: req.userId, companyId: req.companyId,
    expectedUpdatedAt: req.body.expectedUpdatedAt,
  });
  const txn = await ledger.getTransaction(req.tenantId, parsed.data);
  res.json({ transaction: txn });
});

transactionsRouter.post('/:id/duplicate', apDocumentPermission('create'), async (req, res) => {
  const original = await ledger.getTransaction(req.tenantId, req.params['id']!);
  // AJE duplication runs through /tb (numbering + firm gate, rule TB3).
  if (original.txnType === 'aje') {
    throw AppError.badRequest('Adjusting journal entries are managed in the Trial Balance module', 'TB_AJE_ROUTE');
  }
  // An A/P document posted as a bare copy would hit A/P with no bill status,
  // balance due or applications behind it (review Notes): enter a new bill
  // or credit instead.
  if (ledger.AP_DOCUMENT_TYPES.includes(original.txnType)) {
    throw AppError.badRequest('Bills, vendor credits and bill payments can’t be duplicated here. Enter a new one instead.', 'TXN_DUPLICATE_UNSUPPORTED', {
      txnType: original.txnType,
    });
  }
  const lines = original.lines.map((l) => ({
    accountId: l.accountId,
    debit: l.debit,
    credit: l.credit,
    description: l.description || undefined,
    // Line names (U-58) come along, so a JE's A/R / A/P line stays named.
    contactId: l.contactId ?? null,
  }));

  const result = await ledger.postTransaction(req.tenantId, {
    txnType: original.txnType as any,
    txnDate: new Date().toISOString().split('T')[0]!,
    contactId: original.contactId || undefined,
    memo: original.memo || undefined,
    total: original.total || undefined,
    // A duplicated adjusting entry is still adjusting (U-60).
    isAdjusting: original.isAdjusting === true,
    lines,
  }, req.userId, req.companyId);

  res.status(201).json({ transaction: result });
});
