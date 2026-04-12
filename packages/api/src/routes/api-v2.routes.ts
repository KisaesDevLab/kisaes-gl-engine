import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { authenticate } from '../middleware/auth.js';
import { companyContext } from '../middleware/company.js';
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
import { db } from '../db/index.js';
import { accounts, contacts, items } from '../db/schema/index.js';
import { eq, and, sql } from 'drizzle-orm';
import {
  createExpenseSchema, createTransferSchema, createDepositSchema,
  createJournalEntrySchema, createCashSaleSchema, createInvoiceSchema,
  transactionFiltersSchema,
} from '@kis-books/shared';

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
  const tokens = await authService.switchTenant(req.userId, req.body.tenantId);
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
  const { name, accountNumber, accountType, detailType, description } = req.body;
  if (!name || !accountType) { res.status(400).json({ error: { message: 'name and accountType are required' } }); return; }
  const [account] = await db.insert(accounts).values({
    tenantId: req.tenantId,
    companyId: req.companyId || null,
    name, accountNumber: accountNumber || null, accountType, detailType: detailType || null, description: description || null,
  }).returning();
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
  const { displayName, contactType, email, phone, billingLine1, billingCity, billingState, billingZip } = req.body;
  if (!displayName) { res.status(400).json({ error: { message: 'displayName is required' } }); return; }
  const [contact] = await db.insert(contacts).values({
    tenantId: req.tenantId,
    companyId: req.companyId || null,
    displayName, contactType: contactType || 'customer', email: email || null, phone: phone || null,
    billingLine1: billingLine1 || null, billingCity: billingCity || null, billingState: billingState || null, billingZip: billingZip || null,
  }).returning();
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
      res.status(400).json({ error: { message: `Unsupported transaction type: ${txnType}. Use: expense, deposit, transfer, journal_entry, cash_sale` } });
      return;
  }

  res.status(201).json({ transaction: result });
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
  const { name, description, unitPrice, incomeAccountId, isTaxable } = req.body;
  if (!name || !incomeAccountId) { res.status(400).json({ error: { message: 'name and incomeAccountId are required' } }); return; }
  const [item] = await db.insert(items).values({
    tenantId: req.tenantId,
    companyId: req.companyId || null,
    name, description: description || null, unitPrice: unitPrice || null,
    incomeAccountId, isTaxable: isTaxable ?? true,
  }).returning();
  res.status(201).json({ item });
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
        'GET /api/v2/transactions': 'List transactions (supports ?search, ?txnType, ?startDate, ?endDate)',
        'GET /api/v2/transactions/:id': 'Get transaction with journal lines',
        'POST /api/v2/transactions': 'Create transaction { txnType: expense|deposit|transfer|journal_entry|cash_sale, ... }',
      },
      invoices: {
        'GET /api/v2/invoices': 'List invoices',
        'GET /api/v2/invoices/:id': 'Get invoice detail',
        'POST /api/v2/invoices': 'Create invoice { txnDate, contactId, lines, paymentTerms }',
        'PUT /api/v2/invoices/:id': 'Update invoice',
      },
      items: {
        'GET /api/v2/items': 'List items/products',
        'POST /api/v2/items': 'Create item { name, unitPrice, incomeAccountId }',
      },
      reports: {
        'GET /api/v2/reports/trial-balance': 'Trial Balance (?start_date, ?end_date)',
        'GET /api/v2/reports/profit-loss': 'Profit & Loss (?start_date, ?end_date, ?basis)',
        'GET /api/v2/reports/balance-sheet': 'Balance Sheet (?as_of_date, ?basis)',
        'GET /api/v2/reports/cash-flow': 'Cash Flow Statement (?start_date, ?end_date)',
        'GET /api/v2/reports/general-ledger': 'General Ledger (?start_date, ?end_date)',
      },
    },
  });
});
