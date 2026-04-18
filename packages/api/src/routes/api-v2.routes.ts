// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { authenticate } from '../middleware/auth.js';
import { companyContext } from '../middleware/company.js';
import { auditLog } from '../middleware/audit.js';
import * as authService from '../services/auth.service.js';
import * as companyService from '../services/company.service.js';
import * as reportService from '../services/report.service.js';
import * as ledger from '../services/ledger.service.js';
import * as expenseService from '../services/expense.service.js';
import * as depositService from '../services/deposit.service.js';
import * as transferService from '../services/transfer.service.js';
import * as journalEntryService from '../services/journal-entry.service.js';
import * as cashSaleService from '../services/cash-sale.service.js';
import * as invoiceService from '../services/invoice.service.js';
import * as billService from '../services/bill.service.js';
import * as billPaymentService from '../services/bill-payment.service.js';
import * as vendorCreditService from '../services/vendor-credit.service.js';
import * as paymentService from '../services/payment.service.js';
import * as checkService from '../services/check.service.js';
import * as recurringService from '../services/recurring.service.js';
import * as budgetService from '../services/budget.service.js';
import * as dashboardService from '../services/dashboard.service.js';
import * as tagsService from '../services/tags.service.js';
import * as bankFeedService from '../services/bank-feed.service.js';
import * as bankConnectionService from '../services/bank-connection.service.js';
import * as reconciliationService from '../services/reconciliation.service.js';
import * as attachmentService from '../services/attachment.service.js';
import { db } from '../db/index.js';
import { accounts, contacts, items } from '../db/schema/index.js';
import { eq, and, sql } from 'drizzle-orm';
import { parseLimit, parseOffset } from '../utils/pagination.js';
import {
  createExpenseSchema, createTransferSchema, createDepositSchema,
  createJournalEntrySchema, createCashSaleSchema, createInvoiceSchema,
  transactionFiltersSchema, voidTransactionSchema,
  createBillSchema, billFiltersSchema, payableBillsQuerySchema, payBillsSchema,
  createVendorCreditSchema, receivePaymentSchema,
  writeCheckSchema, categorizeSchema, matchSchema, bankFeedFiltersSchema,
  startReconciliationSchema, createTagSchema, transactionTagsSchema,
  createAccountSchema, createContactSchema, createItemSchema,
} from '@kis-books/shared';
import { z } from 'zod';

// Schemas for the few v2-only endpoints not backed by a shared schema.
// Defining them inline keeps the shared package clean and ensures v2
// matches v1's "every write is Zod-validated" guarantee (CLAUDE.md #9).
const switchTenantBodySchema = z.object({ tenantId: z.string().uuid() });

export const apiV2Router = Router();

// IP-based rate limiter (before auth — protects against brute force)
const ipLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  keyGenerator: (req) => req.ip || 'unknown',
  message: { error: { message: 'Too many requests from this IP.', code: 'RATE_LIMIT' } },
});

apiV2Router.use(ipLimiter);
apiV2Router.use(authenticate);

// Per-user rate limiter (after auth — fair usage per account)
const userLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  keyGenerator: (req) => req.userId || 'unknown',
  message: { error: { message: 'Rate limit exceeded. Max 100 requests per minute.', code: 'RATE_LIMIT' } },
});

apiV2Router.use(userLimiter);
apiV2Router.use(companyContext);

// ─── Auth & Context ─────────────────────────────────────────────

apiV2Router.get('/me', async (req, res) => {
  const user = await authService.getMe(req.userId);
  const companies = await companyService.listCompanies(req.tenantId, req.userId);
  const tenants = await authService.getAccessibleTenants(req.userId);
  res.json({
    user: { id: user.id, email: user.email, displayName: user.displayName, role: user.role },
    activeTenantId: req.tenantId,
    activeCompanyId: req.companyId,
    companies,
    tenants,
  });
});

apiV2Router.get('/tenants', async (req, res) => {
  const tenants = await authService.getAccessibleTenants(req.userId);
  res.json({ tenants });
});

apiV2Router.post('/tenants/switch', async (req, res) => {
  const { tenantId } = switchTenantBodySchema.parse(req.body);
  const tokens = await authService.switchTenant(req.userId, tenantId);
  res.json({ tokens });
});

// ─── Chart of Accounts ──────────────────────────────────────────

apiV2Router.get('/accounts', async (req, res) => {
  const rows = await db.select().from(accounts)
    .where(eq(accounts.tenantId, req.tenantId))
    .orderBy(accounts.accountNumber, accounts.name);
  res.json({ data: rows, total: rows.length });
});

apiV2Router.get('/accounts/:id', async (req, res) => {
  const account = await db.query.accounts.findFirst({
    where: and(eq(accounts.tenantId, req.tenantId), eq(accounts.id, req.params['id']!)),
  });
  if (!account) { res.status(404).json({ error: { message: 'Account not found' } }); return; }
  res.json({ account });
});

apiV2Router.post('/accounts', async (req, res) => {
  const input = createAccountSchema.parse(req.body);
  const [account] = await db.insert(accounts).values({
    tenantId: req.tenantId,
    companyId: req.companyId || null,
    name: input.name,
    accountNumber: input.accountNumber ?? null,
    accountType: input.accountType,
    detailType: input.detailType ?? null,
    description: input.description ?? null,
    parentId: input.parentId ?? null,
  }).returning();
  if (account) await auditLog(req.tenantId, 'create', 'account', account.id, null, account, req.userId);
  res.status(201).json({ account });
});

// ─── Contacts ───────────────────────────────────────────────────

apiV2Router.get('/contacts', async (req, res) => {
  const rows = await db.select().from(contacts)
    .where(eq(contacts.tenantId, req.tenantId))
    .orderBy(contacts.displayName);
  res.json({ data: rows, total: rows.length });
});

apiV2Router.get('/contacts/:id', async (req, res) => {
  const contact = await db.query.contacts.findFirst({
    where: and(eq(contacts.tenantId, req.tenantId), eq(contacts.id, req.params['id']!)),
  });
  if (!contact) { res.status(404).json({ error: { message: 'Contact not found' } }); return; }
  res.json({ contact });
});

apiV2Router.post('/contacts', async (req, res) => {
  const input = createContactSchema.parse(req.body);
  const [contact] = await db.insert(contacts).values({
    tenantId: req.tenantId,
    companyId: req.companyId || null,
    contactType: input.contactType,
    displayName: input.displayName,
    companyName: input.companyName ?? null,
    firstName: input.firstName ?? null,
    lastName: input.lastName ?? null,
    email: input.email || null,
    phone: input.phone ?? null,
    billingLine1: input.billingLine1 ?? null,
    billingLine2: input.billingLine2 ?? null,
    billingCity: input.billingCity ?? null,
    billingState: input.billingState ?? null,
    billingZip: input.billingZip ?? null,
    billingCountry: input.billingCountry,
    shippingLine1: input.shippingLine1 ?? null,
    shippingLine2: input.shippingLine2 ?? null,
    shippingCity: input.shippingCity ?? null,
    shippingState: input.shippingState ?? null,
    shippingZip: input.shippingZip ?? null,
    shippingCountry: input.shippingCountry,
    defaultPaymentTerms: input.defaultPaymentTerms ?? null,
    openingBalance: input.openingBalance,
  }).returning();
  if (contact) await auditLog(req.tenantId, 'create', 'contact', contact.id, null, contact, req.userId);
  res.status(201).json({ contact });
});

// ─── Transactions ───────────────────────────────────────────────

apiV2Router.get('/transactions', async (req, res) => {
  const filters = transactionFiltersSchema.parse(req.query);
  const result = await ledger.listTransactions(req.tenantId, filters, req.companyId);
  res.json(result);
});

apiV2Router.get('/transactions/:id', async (req, res) => {
  const txn = await ledger.getTransaction(req.tenantId, req.params['id']!);
  res.json({ transaction: txn });
});

apiV2Router.post('/transactions', async (req, res) => {
  const { txnType, ...body } = req.body;
  let result;

  switch (txnType) {
    case 'expense':
      result = await expenseService.createExpense(req.tenantId, createExpenseSchema.parse(body), req.userId);
      break;
    case 'deposit':
      result = await depositService.createDeposit(req.tenantId, createDepositSchema.parse(body), req.userId);
      break;
    case 'transfer':
      result = await transferService.createTransfer(req.tenantId, createTransferSchema.parse(body), req.userId);
      break;
    case 'journal_entry':
      result = await journalEntryService.createJournalEntry(req.tenantId, createJournalEntrySchema.parse(body), req.userId);
      break;
    case 'cash_sale':
      result = await cashSaleService.createCashSale(req.tenantId, createCashSaleSchema.parse(body), req.userId);
      break;
    default:
      // Don't echo the caller-supplied txnType — it's user input, and
      // reflecting it in the error string adds no debug value the caller
      // didn't already have.
      res.status(400).json({ error: { message: 'Unsupported transaction type. Use: expense, deposit, transfer, journal_entry, cash_sale' } });
      return;
  }

  res.status(201).json({ transaction: result });
});

apiV2Router.post('/transactions/:id/void', async (req, res) => {
  const { reason } = voidTransactionSchema.parse(req.body);
  await ledger.voidTransaction(req.tenantId, req.params['id']!, reason, req.userId);
  const txn = await ledger.getTransaction(req.tenantId, req.params['id']!);
  res.json({ transaction: txn });
});

// ─── Invoices ───────────────────────────────────────────────────

apiV2Router.get('/invoices', async (req, res) => {
  const filters = transactionFiltersSchema.parse(req.query);
  const result = await ledger.listTransactions(req.tenantId, { ...filters, txnType: 'invoice' });
  res.json(result);
});

apiV2Router.get('/invoices/:id', async (req, res) => {
  const invoice = await ledger.getTransaction(req.tenantId, req.params['id']!);
  res.json({ invoice });
});

apiV2Router.post('/invoices', async (req, res) => {
  const invoice = await invoiceService.createInvoice(req.tenantId, createInvoiceSchema.parse(req.body), req.userId);
  res.status(201).json({ invoice });
});

apiV2Router.put('/invoices/:id', async (req, res) => {
  const invoice = await invoiceService.updateInvoice(req.tenantId, req.params['id']!, createInvoiceSchema.parse(req.body), req.userId);
  res.json({ invoice });
});

// ─── Items ──────────────────────────────────────────────────────

apiV2Router.get('/items', async (req, res) => {
  const rows = await db.select().from(items)
    .where(eq(items.tenantId, req.tenantId))
    .orderBy(items.name);
  res.json({ data: rows, total: rows.length });
});

apiV2Router.post('/items', async (req, res) => {
  const input = createItemSchema.parse(req.body);
  // Caller-supplied incomeAccountId is a UUID — verify the account lives in
  // the caller's tenant before accepting it, or the item row ends up with a
  // dangling cross-tenant FK that later corrupts revenue posting.
  const [accountOk] = await db.select({ id: accounts.id }).from(accounts)
    .where(and(eq(accounts.tenantId, req.tenantId), eq(accounts.id, input.incomeAccountId)))
    .limit(1);
  if (!accountOk) { res.status(400).json({ error: { message: 'Invalid income account' } }); return; }
  const [item] = await db.insert(items).values({
    tenantId: req.tenantId,
    companyId: req.companyId || null,
    name: input.name,
    description: input.description ?? null,
    unitPrice: input.unitPrice ?? null,
    incomeAccountId: input.incomeAccountId,
    isTaxable: input.isTaxable,
  }).returning();
  if (item) await auditLog(req.tenantId, 'create', 'item', item.id, null, item, req.userId);
  res.status(201).json({ item });
});

// ─── Bills (Accounts Payable) ───────────────────────────────────

apiV2Router.get('/bills', async (req, res) => {
  const filters = billFiltersSchema.parse(req.query);
  const result = await billService.listBills(req.tenantId, filters, req.companyId);
  res.json(result);
});

apiV2Router.get('/bills/payable', async (req, res) => {
  const query = payableBillsQuerySchema.parse(req.query);
  const result = await billService.getPayableBills(req.tenantId, query);
  res.json(result);
});

apiV2Router.get('/bills/:id', async (req, res) => {
  const bill = await billService.getBill(req.tenantId, req.params['id']!);
  res.json({ bill });
});

apiV2Router.post('/bills', async (req, res) => {
  const bill = await billService.createBill(req.tenantId, createBillSchema.parse(req.body), req.userId, req.companyId);
  res.status(201).json({ bill });
});

apiV2Router.put('/bills/:id', async (req, res) => {
  const bill = await billService.updateBill(req.tenantId, req.params['id']!, createBillSchema.parse(req.body), req.userId, req.companyId);
  res.json({ bill });
});

apiV2Router.post('/bills/:id/void', async (req, res) => {
  const { reason } = voidTransactionSchema.parse(req.body);
  await billService.voidBill(req.tenantId, req.params['id']!, reason, req.userId);
  const bill = await billService.getBill(req.tenantId, req.params['id']!);
  res.json({ bill });
});

// ─── Bill Payments ──────────────────────────────────────────────

apiV2Router.get('/bill-payments', async (req, res) => {
  const data = await billPaymentService.listBillPayments(req.tenantId, {
    contactId: req.query['contactId'] as string | undefined,
    startDate: req.query['startDate'] as string | undefined,
    endDate: req.query['endDate'] as string | undefined,
    limit: req.query['limit'] ? Number(req.query['limit']) : undefined,
    offset: req.query['offset'] ? Number(req.query['offset']) : undefined,
  });
  res.json({ data });
});

apiV2Router.get('/bill-payments/:id', async (req, res) => {
  const payment = await billPaymentService.getBillPayment(req.tenantId, req.params['id']!);
  res.json({ payment });
});

apiV2Router.post('/bill-payments', async (req, res) => {
  const result = await billPaymentService.payBills(req.tenantId, payBillsSchema.parse(req.body), req.userId, req.companyId);
  res.status(201).json(result);
});

apiV2Router.post('/bill-payments/:id/void', async (req, res) => {
  const { reason } = voidTransactionSchema.parse(req.body);
  await billPaymentService.voidBillPayment(req.tenantId, req.params['id']!, reason, req.userId);
  res.json({ voided: true });
});

// ─── Vendor Credits ─────────────────────────────────────────────

apiV2Router.get('/vendor-credits', async (req, res) => {
  const result = await vendorCreditService.listVendorCredits(req.tenantId, {
    contactId: req.query['contactId'] as string | undefined,
    startDate: req.query['startDate'] as string | undefined,
    endDate: req.query['endDate'] as string | undefined,
    search: req.query['search'] as string | undefined,
    limit: req.query['limit'] ? Number(req.query['limit']) : undefined,
    offset: req.query['offset'] ? Number(req.query['offset']) : undefined,
  }, req.companyId);
  res.json(result);
});

apiV2Router.get('/vendor-credits/available/:vendorId', async (req, res) => {
  const credits = await vendorCreditService.getAvailableCredits(req.tenantId, req.params['vendorId']!);
  res.json({ credits });
});

apiV2Router.get('/vendor-credits/:id', async (req, res) => {
  const credit = await vendorCreditService.getVendorCredit(req.tenantId, req.params['id']!);
  res.json({ credit });
});

apiV2Router.post('/vendor-credits', async (req, res) => {
  const credit = await vendorCreditService.createVendorCredit(req.tenantId, createVendorCreditSchema.parse(req.body), req.userId, req.companyId);
  res.status(201).json({ credit });
});

apiV2Router.post('/vendor-credits/:id/void', async (req, res) => {
  const { reason } = voidTransactionSchema.parse(req.body);
  await vendorCreditService.voidVendorCredit(req.tenantId, req.params['id']!, reason, req.userId);
  const credit = await vendorCreditService.getVendorCredit(req.tenantId, req.params['id']!);
  res.json({ credit });
});

// ─── Customer Payments ──────────────────────────────────────────

apiV2Router.post('/payments/receive', async (req, res) => {
  const payment = await paymentService.receivePayment(req.tenantId, receivePaymentSchema.parse(req.body), req.userId, req.companyId);
  res.status(201).json({ payment });
});

apiV2Router.get('/payments/open-invoices/:customerId', async (req, res) => {
  const invoices = await paymentService.getOpenInvoicesForCustomer(req.tenantId, req.params['customerId']!);
  res.json({ invoices });
});

// ─── Checks ─────────────────────────────────────────────────────

apiV2Router.get('/checks', async (req, res) => {
  const result = await checkService.listChecks(req.tenantId, {
    bankAccountId: req.query['bank_account_id'] as string,
    printStatus: req.query['print_status'] as string,
    startDate: req.query['start_date'] as string,
    endDate: req.query['end_date'] as string,
    limit: parseLimit(req.query['limit']),
    offset: parseOffset(req.query['offset']),
  }, req.companyId);
  res.json(result);
});

apiV2Router.post('/checks', async (req, res) => {
  const check = await checkService.createCheck(req.tenantId, writeCheckSchema.parse(req.body), req.userId, req.companyId);
  res.status(201).json({ check });
});

apiV2Router.get('/checks/print-queue', async (req, res) => {
  const data = await checkService.getPrintQueue(req.tenantId, req.query['bank_account_id'] as string, req.companyId);
  res.json({ data });
});

// ─── Recurring Transactions ─────────────────────────────────────

apiV2Router.get('/recurring', async (req, res) => {
  const schedules = await recurringService.list(req.tenantId);
  res.json({ schedules });
});

apiV2Router.post('/recurring', async (req, res) => {
  const { templateTransactionId, ...schedule } = req.body;
  if (!templateTransactionId) { res.status(400).json({ error: { message: 'templateTransactionId is required' } }); return; }
  const sched = await recurringService.create(req.tenantId, templateTransactionId, schedule);
  res.status(201).json({ schedule: sched });
});

apiV2Router.put('/recurring/:id', async (req, res) => {
  const sched = await recurringService.update(req.tenantId, req.params['id']!, req.body);
  res.json({ schedule: sched });
});

apiV2Router.delete('/recurring/:id', async (req, res) => {
  await recurringService.deactivate(req.tenantId, req.params['id']!);
  res.json({ message: 'Deactivated' });
});

apiV2Router.post('/recurring/:id/post-now', async (req, res) => {
  const txn = await recurringService.postNext(req.tenantId, req.params['id']!);
  res.status(201).json({ transaction: txn });
});

// ─── Budgets ────────────────────────────────────────────────────

apiV2Router.get('/budgets', async (req, res) => {
  const budgets = await budgetService.list(req.tenantId);
  res.json({ budgets });
});

apiV2Router.get('/budgets/:id', async (req, res) => {
  const budget = await budgetService.getById(req.tenantId, req.params['id']!);
  res.json({ budget });
});

apiV2Router.get('/budgets/:id/lines', async (req, res) => {
  const lines = await budgetService.getLines(req.tenantId, req.params['id']!);
  res.json({ lines });
});

apiV2Router.get('/budgets/:id/vs-actual', async (req, res) => {
  const { start_date, end_date } = req.query as Record<string, string>;
  const today = new Date();
  const data = await budgetService.buildBudgetVsActual(
    req.tenantId, req.params['id']!,
    start_date || `${today.getFullYear()}-01-01`,
    end_date || today.toISOString().split('T')[0]!,
  );
  res.json(data);
});

// ─── Dashboard ──────────────────────────────────────────────────

apiV2Router.get('/dashboard/snapshot', async (req, res) => {
  const data = await dashboardService.getFinancialSnapshot(req.tenantId);
  res.json(data);
});

apiV2Router.get('/dashboard/trend', async (req, res) => {
  const months = parseInt(req.query['months'] as string) || 6;
  const data = await dashboardService.getRevExpTrend(req.tenantId, months);
  res.json({ data });
});

apiV2Router.get('/dashboard/cash-position', async (req, res) => {
  const data = await dashboardService.getCashPosition(req.tenantId);
  res.json(data);
});

apiV2Router.get('/dashboard/receivables', async (req, res) => {
  const data = await dashboardService.getReceivablesSummary(req.tenantId);
  res.json(data);
});

apiV2Router.get('/dashboard/payables', async (req, res) => {
  const data = await dashboardService.getPayablesSummary(req.tenantId);
  res.json(data);
});

apiV2Router.get('/dashboard/action-items', async (req, res) => {
  const data = await dashboardService.getActionItems(req.tenantId);
  res.json(data);
});

// ─── Tags ───────────────────────────────────────────────────────

apiV2Router.get('/tags', async (req, res) => {
  const tags = await tagsService.list(req.tenantId, {
    groupId: req.query['group_id'] as string,
    isActive: req.query['is_active'] === 'true' ? true : req.query['is_active'] === 'false' ? false : undefined,
    search: req.query['search'] as string,
  });
  res.json({ tags });
});

apiV2Router.get('/tags/groups', async (req, res) => {
  const groups = await tagsService.listGroups(req.tenantId);
  res.json({ groups });
});

apiV2Router.post('/tags', async (req, res) => {
  const tag = await tagsService.create(req.tenantId, createTagSchema.parse(req.body));
  res.status(201).json({ tag });
});

apiV2Router.post('/transactions/:id/tags', async (req, res) => {
  const { tagIds } = transactionTagsSchema.parse(req.body);
  await tagsService.replaceTags(req.tenantId, req.params['id']!, tagIds);
  res.json({ tagged: true, count: tagIds.length });
});

// ─── Banking: Connections, Feed, Reconciliation ─────────────────

apiV2Router.get('/banking/connections', async (req, res) => {
  const connections = await bankConnectionService.list(req.tenantId);
  res.json({ connections });
});

apiV2Router.get('/banking/feed', async (req, res) => {
  const filters = bankFeedFiltersSchema.parse(req.query);
  const result = await bankFeedService.list(req.tenantId, filters);
  res.json(result);
});

apiV2Router.get('/banking/feed/:id/match-candidates', async (req, res) => {
  const candidates = await bankFeedService.findMatchCandidates(req.tenantId, req.params['id']!);
  res.json({ candidates });
});

apiV2Router.put('/banking/feed/:id/categorize', async (req, res) => {
  const txn = await bankFeedService.categorize(req.tenantId, req.params['id']!, categorizeSchema.parse(req.body), req.userId, req.companyId);
  res.json({ transaction: txn });
});

apiV2Router.put('/banking/feed/:id/match', async (req, res) => {
  const { transactionId } = matchSchema.parse(req.body);
  await bankFeedService.match(req.tenantId, req.params['id']!, transactionId);
  res.json({ message: 'Matched' });
});

apiV2Router.put('/banking/feed/:id/exclude', async (req, res) => {
  await bankFeedService.exclude(req.tenantId, req.params['id']!);
  res.json({ message: 'Excluded' });
});

apiV2Router.post('/banking/feed/bulk-approve', async (req, res) => {
  const result = await bankFeedService.bulkApprove(req.tenantId, req.body.feedItemIds);
  res.json(result);
});

apiV2Router.get('/banking/reconciliations', async (req, res) => {
  const history = await reconciliationService.getHistory(req.tenantId, req.query['account_id'] as string);
  res.json({ reconciliations: history });
});

apiV2Router.post('/banking/reconciliations', async (req, res) => {
  const { accountId, statementDate, statementEndingBalance } = startReconciliationSchema.parse(req.body);
  const recon = await reconciliationService.start(req.tenantId, accountId, statementDate, statementEndingBalance);
  res.status(201).json({ reconciliation: recon });
});

apiV2Router.get('/banking/reconciliations/:id', async (req, res) => {
  const recon = await reconciliationService.getReconciliation(req.tenantId, req.params['id']!);
  res.json({ reconciliation: recon });
});

// ─── Attachments (metadata only — upload via /api/v1/attachments) ─

apiV2Router.get('/attachments', async (req, res) => {
  const result = await attachmentService.list(req.tenantId, {
    attachableType: req.query['attachableType'] as string | undefined,
    attachableId: req.query['attachableId'] as string | undefined,
    limit: req.query['limit'] ? Number(req.query['limit']) : undefined,
    offset: req.query['offset'] ? Number(req.query['offset']) : undefined,
  });
  res.json(result);
});

apiV2Router.get('/attachments/:id', async (req, res) => {
  const attachment = await attachmentService.getById(req.tenantId, req.params['id']!);
  res.json({ attachment });
});

// ─── Reports ────────────────────────────────────────────────────

apiV2Router.get('/reports/trial-balance', async (req, res) => {
  const { start_date, end_date } = req.query as Record<string, string>;
  const today = new Date().toISOString().split('T')[0]!;
  const year = new Date().getFullYear();
  const scope = req.query['scope'] === 'consolidated' ? null : req.companyId;
  const data = await reportService.buildTrialBalance(req.tenantId, start_date || `${year}-01-01`, end_date || today, scope);
  res.json(data);
});

apiV2Router.get('/reports/profit-loss', async (req, res) => {
  const { start_date, end_date, basis } = req.query as Record<string, string>;
  const today = new Date().toISOString().split('T')[0]!;
  const year = new Date().getFullYear();
  const scope = req.query['scope'] === 'consolidated' ? null : req.companyId;
  const data = await reportService.buildProfitAndLoss(req.tenantId, start_date || `${year}-01-01`, end_date || today, (basis as any) || 'accrual', scope);
  res.json(data);
});

apiV2Router.get('/reports/balance-sheet', async (req, res) => {
  const { as_of_date, basis } = req.query as Record<string, string>;
  const today = new Date().toISOString().split('T')[0]!;
  const scope = req.query['scope'] === 'consolidated' ? null : req.companyId;
  const data = await reportService.buildBalanceSheet(req.tenantId, as_of_date || today, (basis as any) || 'accrual', scope);
  res.json(data);
});

apiV2Router.get('/reports/cash-flow', async (req, res) => {
  const { start_date, end_date } = req.query as Record<string, string>;
  const today = new Date().toISOString().split('T')[0]!;
  const year = new Date().getFullYear();
  const scope = req.query['scope'] === 'consolidated' ? null : req.companyId;
  const data = await reportService.buildCashFlowStatement(req.tenantId, start_date || `${year}-01-01`, end_date || today, scope);
  res.json(data);
});

apiV2Router.get('/reports/general-ledger', async (req, res) => {
  const { start_date, end_date } = req.query as Record<string, string>;
  const today = new Date().toISOString().split('T')[0]!;
  const year = new Date().getFullYear();
  const scope = req.query['scope'] === 'consolidated' ? null : req.companyId;
  const data = await reportService.buildGeneralLedger(req.tenantId, start_date || `${year}-01-01`, end_date || today, scope);
  res.json(data);
});

apiV2Router.get('/reports/ar-aging', async (req, res) => {
  const asOf = (req.query['as_of_date'] as string) || new Date().toISOString().split('T')[0]!;
  const scope = req.query['scope'] === 'consolidated' ? null : req.companyId;
  const data = await reportService.buildARAgingSummary(req.tenantId, asOf, scope);
  res.json(data);
});

apiV2Router.get('/reports/expense-by-vendor', async (req, res) => {
  const { start_date, end_date } = req.query as Record<string, string>;
  const today = new Date().toISOString().split('T')[0]!;
  const year = new Date().getFullYear();
  const scope = req.query['scope'] === 'consolidated' ? null : req.companyId;
  const data = await reportService.buildExpenseByVendor(req.tenantId, start_date || `${year}-01-01`, end_date || today, scope);
  res.json(data);
});

apiV2Router.get('/reports/expense-by-category', async (req, res) => {
  const { start_date, end_date } = req.query as Record<string, string>;
  const today = new Date().toISOString().split('T')[0]!;
  const year = new Date().getFullYear();
  const scope = req.query['scope'] === 'consolidated' ? null : req.companyId;
  const data = await reportService.buildExpenseByCategory(req.tenantId, start_date || `${year}-01-01`, end_date || today, scope);
  res.json(data);
});

apiV2Router.get('/reports/vendor-balance', async (req, res) => {
  const scope = req.query['scope'] === 'consolidated' ? null : req.companyId;
  const data = await reportService.buildVendorBalanceSummary(req.tenantId, scope);
  res.json(data);
});

apiV2Router.get('/reports/customer-balance', async (req, res) => {
  const scope = req.query['scope'] === 'consolidated' ? null : req.companyId;
  const data = await reportService.buildCustomerBalanceSummary(req.tenantId, scope);
  res.json(data);
});

apiV2Router.get('/reports/1099-vendor-summary', async (req, res) => {
  const year = (req.query['year'] as string) || String(new Date().getFullYear());
  const scope = req.query['scope'] === 'consolidated' ? null : req.companyId;
  const data = await reportService.build1099VendorSummary(req.tenantId, year, scope);
  res.json(data);
});

apiV2Router.get('/reports/sales-tax-liability', async (req, res) => {
  const { start_date, end_date } = req.query as Record<string, string>;
  const today = new Date().toISOString().split('T')[0]!;
  const year = new Date().getFullYear();
  const scope = req.query['scope'] === 'consolidated' ? null : req.companyId;
  const data = await reportService.buildSalesTaxLiability(req.tenantId, start_date || `${year}-01-01`, end_date || today, scope);
  res.json(data);
});

apiV2Router.get('/reports/check-register', async (req, res) => {
  const accountId = req.query['account_id'] as string;
  if (!accountId) { res.status(400).json({ error: { message: 'account_id is required' } }); return; }
  const start = req.query['start_date'] as string | undefined;
  const end = req.query['end_date'] as string | undefined;
  const scope = req.query['scope'] === 'consolidated' ? null : req.companyId;
  const data = await reportService.buildCheckRegister(req.tenantId, accountId, start && end ? { startDate: start, endDate: end } : undefined, scope);
  res.json(data);
});

// ─── API Documentation ──────────────────────────────────────────

apiV2Router.get('/docs', (_req, res) => {
  res.json({
    name: 'Vibe MyBooks API',
    version: '2.0',
    auth: {
      methods: ['API Key (X-API-Key header)', 'JWT Bearer token'],
      apiKeyGeneration: 'POST /api/v1/api-keys or Settings > API Keys in the web UI',
      rateLimit: '100 requests/minute per key',
    },
    endpoints: {
      context: {
        'GET /api/v2/me': 'Current user, tenant, and companies',
        'GET /api/v2/tenants': 'List accessible tenants',
        'POST /api/v2/tenants/switch': 'Switch active tenant { tenantId }',
      },
      accounts: {
        'GET /api/v2/accounts': 'List chart of accounts',
        'GET /api/v2/accounts/:id': 'Get account detail',
        'POST /api/v2/accounts': 'Create account { name, accountNumber, accountType }',
      },
      contacts: {
        'GET /api/v2/contacts': 'List contacts',
        'GET /api/v2/contacts/:id': 'Get contact detail',
        'POST /api/v2/contacts': 'Create contact { displayName, contactType, email }',
      },
      transactions: {
        'GET /api/v2/transactions': 'List transactions (supports ?search, ?txnType, ?startDate, ?endDate, ?contactId, ?accountId, ?tagId)',
        'GET /api/v2/transactions/:id': 'Get transaction with journal lines',
        'POST /api/v2/transactions': 'Create transaction { txnType: expense|deposit|transfer|journal_entry|cash_sale, ... }',
        'POST /api/v2/transactions/:id/void': 'Void a transaction { reason } — creates a reversing entry',
        'POST /api/v2/transactions/:id/tags': 'Replace tags on a transaction { tagIds: [] }',
      },
      invoices: {
        'GET /api/v2/invoices': 'List invoices',
        'GET /api/v2/invoices/:id': 'Get invoice detail',
        'POST /api/v2/invoices': 'Create invoice { txnDate, contactId, lines, paymentTerms }',
        'PUT /api/v2/invoices/:id': 'Update invoice',
      },
      bills: {
        'GET /api/v2/bills': 'List bills (?contactId, ?billStatus, ?startDate, ?endDate, ?overdueOnly, ?search)',
        'GET /api/v2/bills/payable': 'Unpaid bills with balance due (?contactId, ?dueOnOrBefore)',
        'GET /api/v2/bills/:id': 'Get bill detail',
        'POST /api/v2/bills': 'Create bill { contactId, txnDate, dueDate, lines }',
        'PUT /api/v2/bills/:id': 'Update bill',
        'POST /api/v2/bills/:id/void': 'Void bill { reason }',
      },
      billPayments: {
        'GET /api/v2/bill-payments': 'List bill payments',
        'GET /api/v2/bill-payments/:id': 'Get bill payment detail',
        'POST /api/v2/bill-payments': 'Pay bills { bankAccountId, txnDate, method, bills: [{billId, amount}], credits?: [] }',
        'POST /api/v2/bill-payments/:id/void': 'Void bill payment { reason }',
      },
      vendorCredits: {
        'GET /api/v2/vendor-credits': 'List vendor credits',
        'GET /api/v2/vendor-credits/available/:vendorId': 'Credits with remaining balance for a vendor',
        'GET /api/v2/vendor-credits/:id': 'Get credit detail',
        'POST /api/v2/vendor-credits': 'Create vendor credit { contactId, txnDate, lines }',
        'POST /api/v2/vendor-credits/:id/void': 'Void credit { reason }',
      },
      customerPayments: {
        'POST /api/v2/payments/receive': 'Receive customer payment { customerId, date, amount, depositTo, applications: [{invoiceId, amount}] }',
        'GET /api/v2/payments/open-invoices/:customerId': 'Open invoices for applying payments',
      },
      checks: {
        'GET /api/v2/checks': 'List checks (?bank_account_id, ?print_status, ?start_date, ?end_date)',
        'GET /api/v2/checks/print-queue': 'Checks queued for printing',
        'POST /api/v2/checks': 'Write a check { bankAccountId, txnDate, payeeId, lines }',
      },
      recurring: {
        'GET /api/v2/recurring': 'List recurring schedules',
        'POST /api/v2/recurring': 'Create schedule { templateTransactionId, frequency, startDate, ... }',
        'PUT /api/v2/recurring/:id': 'Update schedule',
        'DELETE /api/v2/recurring/:id': 'Deactivate schedule',
        'POST /api/v2/recurring/:id/post-now': 'Post next occurrence immediately',
      },
      budgets: {
        'GET /api/v2/budgets': 'List budgets',
        'GET /api/v2/budgets/:id': 'Get budget detail',
        'GET /api/v2/budgets/:id/lines': 'Get budget lines',
        'GET /api/v2/budgets/:id/vs-actual': 'Budget vs Actual (?start_date, ?end_date)',
      },
      dashboard: {
        'GET /api/v2/dashboard/snapshot': 'Financial snapshot (revenue, expenses, net income)',
        'GET /api/v2/dashboard/trend': 'Revenue/expense trend (?months)',
        'GET /api/v2/dashboard/cash-position': 'Cash across all bank accounts',
        'GET /api/v2/dashboard/receivables': 'AR summary with aging buckets',
        'GET /api/v2/dashboard/payables': 'AP summary with aging buckets',
        'GET /api/v2/dashboard/action-items': 'Overdue invoices, bills due, pending feed items',
      },
      tags: {
        'GET /api/v2/tags': 'List tags (?group_id, ?is_active, ?search)',
        'GET /api/v2/tags/groups': 'List tag groups',
        'POST /api/v2/tags': 'Create tag { name, groupId, color? }',
      },
      banking: {
        'GET /api/v2/banking/connections': 'List bank connections (Plaid + manual)',
        'GET /api/v2/banking/feed': 'List bank feed items (?status, ?accountId, ?startDate, ?endDate)',
        'GET /api/v2/banking/feed/:id/match-candidates': 'Suggest matching transactions',
        'PUT /api/v2/banking/feed/:id/categorize': 'Categorize feed item { accountId, contactId?, memo? }',
        'PUT /api/v2/banking/feed/:id/match': 'Match feed item to existing transaction { transactionId }',
        'PUT /api/v2/banking/feed/:id/exclude': 'Exclude feed item from ledger',
        'POST /api/v2/banking/feed/bulk-approve': 'Bulk approve { feedItemIds: [] }',
        'GET /api/v2/banking/reconciliations': 'Reconciliation history (?account_id)',
        'POST /api/v2/banking/reconciliations': 'Start reconciliation { accountId, statementDate, statementEndingBalance }',
        'GET /api/v2/banking/reconciliations/:id': 'Get reconciliation detail',
      },
      items: {
        'GET /api/v2/items': 'List items/products',
        'POST /api/v2/items': 'Create item { name, unitPrice, incomeAccountId }',
      },
      attachments: {
        'GET /api/v2/attachments': 'List attachment metadata (?attachableType, ?attachableId)',
        'GET /api/v2/attachments/:id': 'Get attachment metadata',
        'note': 'Uploads (multipart) still go through POST /api/v1/attachments',
      },
      reports: {
        'GET /api/v2/reports/trial-balance': 'Trial Balance (?start_date, ?end_date)',
        'GET /api/v2/reports/profit-loss': 'Profit & Loss (?start_date, ?end_date, ?basis)',
        'GET /api/v2/reports/balance-sheet': 'Balance Sheet (?as_of_date, ?basis)',
        'GET /api/v2/reports/cash-flow': 'Cash Flow Statement (?start_date, ?end_date)',
        'GET /api/v2/reports/general-ledger': 'General Ledger (?start_date, ?end_date)',
        'GET /api/v2/reports/ar-aging': 'AR Aging Summary (?as_of_date)',
        'GET /api/v2/reports/expense-by-vendor': 'Expense by Vendor (?start_date, ?end_date)',
        'GET /api/v2/reports/expense-by-category': 'Expense by Category (?start_date, ?end_date)',
        'GET /api/v2/reports/vendor-balance': 'Vendor balance summary',
        'GET /api/v2/reports/customer-balance': 'Customer balance summary',
        'GET /api/v2/reports/1099-vendor-summary': '1099 vendor summary (?year)',
        'GET /api/v2/reports/sales-tax-liability': 'Sales tax liability (?start_date, ?end_date)',
        'GET /api/v2/reports/check-register': 'Check register (?account_id, ?start_date, ?end_date)',
      },
    },
  });
});
