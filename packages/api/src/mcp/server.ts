import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { resolveMcpAuth, checkScope } from './auth.js';
import { resolveCompany, setActiveCompany, getActiveCompany, getUserCompanies } from './context.js';
import { logMcpRequest } from './audit.js';
import { checkRateLimit } from './rate-limiter.js';
import type { McpAuthContext } from '@kis-books/shared';

// Helper to get tenantId from companyId
async function getTenantId(companyId: string): Promise<string> {
  const { db } = await import('../db/index.js');
  const { companies } = await import('../db/schema/index.js');
  const { eq } = await import('drizzle-orm');
  const company = await db.query.companies.findFirst({ where: eq(companies.id, companyId) });
  if (!company) throw new Error('NOT_FOUND: Company not found');
  return company.tenantId;
}

// ─── Tool Registry ──────────────────────────────────────────────

interface ToolDef {
  description: string;
  schema: Record<string, any>;
  handler: (params: any, auth: McpAuthContext) => Promise<any>;
}

const tools = new Map<string, ToolDef>();

function registerTool(name: string, description: string, schema: Record<string, any>, handler: ToolDef['handler']) {
  tools.set(name, { description, schema, handler });
}

// Bounds applied to every tool-call payload before it reaches a handler.
// The per-tool `schema` on ToolDef is a hint object used to advertise shape
// to the MCP client (`tools/list`); it's not a runtime validator. Without
// these coarse guards, a caller can send `{ limit: 1e12 }` or a 10MB
// payload and the handler will happily forward it to Drizzle / the DB.
//
// This isn't a replacement for per-tool input validation — a future
// iteration should give each tool a Zod schema. Until then, these bounds
// close the obvious DoS/resource-exhaustion surface.
const MCP_MAX_PARAMS_BYTES = 32 * 1024;
const MCP_MAX_NUMERIC_LIMIT = 1000;

function sanitizeMcpParams(params: unknown): Record<string, unknown> {
  if (params === null || params === undefined) return {};
  if (typeof params !== 'object' || Array.isArray(params)) {
    throw new Error('INVALID_PARAMS: tool arguments must be an object');
  }
  // Serialized-size ceiling — catches deeply nested or array-bomb payloads
  // without us needing to walk the object recursively.
  const serialized = JSON.stringify(params);
  if (serialized.length > MCP_MAX_PARAMS_BYTES) {
    throw new Error('INVALID_PARAMS: tool arguments exceed maximum size');
  }
  const out: Record<string, unknown> = { ...(params as Record<string, unknown>) };
  // Cap common pagination / range parameters. Handlers using different
  // names still pay the serialized-size ceiling above.
  for (const key of ['limit', 'months', 'count'] as const) {
    if (key in out) {
      const n = Number(out[key]);
      if (!Number.isFinite(n) || n < 0) {
        throw new Error(`INVALID_PARAMS: "${key}" must be a non-negative number`);
      }
      out[key] = Math.min(Math.floor(n), MCP_MAX_NUMERIC_LIMIT);
    }
  }
  if ('offset' in out) {
    const n = Number(out['offset']);
    if (!Number.isFinite(n) || n < 0) throw new Error('INVALID_PARAMS: "offset" must be non-negative');
    out['offset'] = Math.floor(n);
  }
  return out;
}

// ─── Context Tools ──────────────────────────────────────────────

registerTool('list_companies', 'List all companies the user has access to', {}, async (_p, auth) => {
  const companies = await getUserCompanies(auth.userId);
  return companies.map((c: any) => ({ id: c.id, name: c.businessName, tenantId: c.tenantId }));
});

registerTool('set_active_company', 'Set the active company for subsequent calls', { company_id: 'string' }, async (p, auth) => {
  const companyId = await resolveCompany(auth, { company_id: p.company_id });
  setActiveCompany(auth.userId, companyId);
  return { active_company_id: companyId };
});

registerTool('get_active_company', 'Get the currently active company', {}, async (_p, auth) => {
  return { active_company_id: getActiveCompany(auth.userId) || null };
});

// ─── COA Tools ──────────────────────────────────────────────────

registerTool('list_accounts', 'List chart of accounts', { company_id: 'string?' }, async (p, auth) => {
  checkScope(auth, 'read');
  const tenantId = await getTenantId(await resolveCompany(auth, p));
  const { list } = await import('../services/accounts.service.js');
  return list(tenantId, { limit: 500, offset: 0 });
});

registerTool('get_account_balance', 'Get balance for an account', { company_id: 'string?', account_id: 'string' }, async (p, auth) => {
  checkScope(auth, 'read');
  const tenantId = await getTenantId(await resolveCompany(auth, p));
  const { db } = await import('../db/index.js');
  const { accounts } = await import('../db/schema/index.js');
  const { eq, and } = await import('drizzle-orm');
  const account = await db.query.accounts.findFirst({ where: and(eq(accounts.tenantId, tenantId), eq(accounts.id, p.account_id)) });
  if (!account) throw new Error('NOT_FOUND: Account not found');
  return { id: account.id, name: account.name, balance: account.balance, accountType: account.accountType };
});

// ─── Contact Tools ──────────────────────────────────────────────

registerTool('list_contacts', 'List contacts', { company_id: 'string?', type: 'string?' }, async (p, auth) => {
  checkScope(auth, 'read');
  const tenantId = await getTenantId(await resolveCompany(auth, p));
  const { list } = await import('../services/contacts.service.js');
  return list(tenantId, { limit: 200, offset: 0, contactType: p.type });
});

registerTool('create_contact', 'Create a contact', { company_id: 'string?', display_name: 'string', type: 'string', email: 'string?', phone: 'string?' }, async (p, auth) => {
  checkScope(auth, 'write');
  const tenantId = await getTenantId(await resolveCompany(auth, p));
  const { create } = await import('../services/contacts.service.js');
  return create(tenantId, { displayName: p.display_name, contactType: p.type, email: p.email, phone: p.phone });
});

// ─── Transaction Tools ──────────────────────────────────────────

registerTool('list_transactions', 'List transactions', { company_id: 'string?', type: 'string?', limit: 'number?' }, async (p, auth) => {
  checkScope(auth, 'read');
  const tenantId = await getTenantId(await resolveCompany(auth, p));
  const { db } = await import('../db/index.js');
  const { transactions } = await import('../db/schema/index.js');
  const { eq, and, desc } = await import('drizzle-orm');
  const conds: any[] = [eq(transactions.tenantId, tenantId)];
  if (p.type) conds.push(eq(transactions.txnType, p.type));
  return db.select().from(transactions).where(and(...conds)).orderBy(desc(transactions.txnDate)).limit(p.limit || 50);
});

registerTool('create_expense', 'Create an expense', { company_id: 'string?', date: 'string', payee_id: 'string', bank_account_id: 'string', lines: 'string', memo: 'string?' }, async (p, auth) => {
  checkScope(auth, 'write');
  const tenantId = await getTenantId(await resolveCompany(auth, p));
  const { createExpense } = await import('../services/expense.service.js');
  const lines = typeof p.lines === 'string' ? JSON.parse(p.lines) : p.lines;
  return createExpense(tenantId, { txnDate: p.date, contactId: p.payee_id, payFromAccountId: p.bank_account_id, lines, memo: p.memo || '' }, auth.userId);
});

registerTool('create_journal_entry', 'Create a journal entry', { company_id: 'string?', date: 'string', lines: 'string', memo: 'string?' }, async (p, auth) => {
  checkScope(auth, 'write');
  const tenantId = await getTenantId(await resolveCompany(auth, p));
  const { createJournalEntry: create } = await import('../services/journal-entry.service.js');
  const lines = typeof p.lines === 'string' ? JSON.parse(p.lines) : p.lines;
  return create(tenantId, { txnDate: p.date, lines, memo: p.memo || '' }, auth.userId);
});

registerTool('void_transaction', 'Void a transaction', { company_id: 'string?', transaction_id: 'string', reason: 'string?' }, async (p, auth) => {
  checkScope(auth, 'write');
  const tenantId = await getTenantId(await resolveCompany(auth, p));
  const { voidTransaction } = await import('../services/ledger.service.js');
  await voidTransaction(tenantId, p.transaction_id, p.reason || 'Voided via MCP', auth.userId);
  return { voided: true };
});

// ─── Report Tools ───────────────────────────────────────────────

registerTool('run_profit_loss', 'Generate P&L report', { company_id: 'string?', start_date: 'string', end_date: 'string', basis: 'string?' }, async (p, auth) => {
  checkScope(auth, 'reports');
  const tenantId = await getTenantId(await resolveCompany(auth, p));
  const { buildProfitAndLoss } = await import('../services/report.service.js');
  return buildProfitAndLoss(tenantId, p.start_date, p.end_date, p.basis || 'accrual');
});

registerTool('run_balance_sheet', 'Generate Balance Sheet', { company_id: 'string?', as_of_date: 'string' }, async (p, auth) => {
  checkScope(auth, 'reports');
  const tenantId = await getTenantId(await resolveCompany(auth, p));
  const { buildBalanceSheet } = await import('../services/report.service.js');
  return buildBalanceSheet(tenantId, p.as_of_date, 'accrual');
});

registerTool('run_trial_balance', 'Generate Trial Balance', { company_id: 'string?', start_date: 'string', end_date: 'string' }, async (p, auth) => {
  checkScope(auth, 'reports');
  const tenantId = await getTenantId(await resolveCompany(auth, p));
  const { buildTrialBalance } = await import('../services/report.service.js');
  return buildTrialBalance(tenantId, p.start_date, p.end_date);
});

registerTool('run_general_ledger', 'Generate General Ledger', { company_id: 'string?', start_date: 'string', end_date: 'string' }, async (p, auth) => {
  checkScope(auth, 'reports');
  const tenantId = await getTenantId(await resolveCompany(auth, p));
  const { buildGeneralLedger } = await import('../services/report.service.js');
  return buildGeneralLedger(tenantId, p.start_date, p.end_date);
});

// ─── Invoice Tools ──────────────────────────────────────────────

registerTool('list_invoices', 'List invoices', { company_id: 'string?', status: 'string?' }, async (p, auth) => {
  checkScope(auth, 'read');
  const tenantId = await getTenantId(await resolveCompany(auth, p));
  const { db } = await import('../db/index.js');
  const { transactions } = await import('../db/schema/index.js');
  const { eq, and, desc } = await import('drizzle-orm');
  const conds: any[] = [eq(transactions.tenantId, tenantId), eq(transactions.txnType, 'invoice' as any)];
  if (p.status) conds.push(eq(transactions.invoiceStatus, p.status));
  return db.select().from(transactions).where(and(...conds)).orderBy(desc(transactions.txnDate)).limit(100);
});

// ─── Bank Feed Tools ────────────────────────────────────────────

registerTool('list_bank_feed_items', 'List bank feed items', { company_id: 'string?', status: 'string?' }, async (p, auth) => {
  checkScope(auth, 'banking');
  const tenantId = await getTenantId(await resolveCompany(auth, p));
  const { db } = await import('../db/index.js');
  const { bankFeedItems } = await import('../db/schema/index.js');
  const { eq, and, desc } = await import('drizzle-orm');
  const conds: any[] = [eq(bankFeedItems.tenantId, tenantId), eq(bankFeedItems.status, p.status || 'pending')];
  return db.select().from(bankFeedItems).where(and(...conds)).orderBy(desc(bankFeedItems.feedDate)).limit(100);
});

// ─── Search Tool ────────────────────────────────────────────────

registerTool('search', 'Search transactions and contacts', { company_id: 'string?', query: 'string' }, async (p, auth) => {
  checkScope(auth, 'read');
  const tenantId = await getTenantId(await resolveCompany(auth, p));
  const { db } = await import('../db/index.js');
  const { transactions, contacts } = await import('../db/schema/index.js');
  const { eq, and, ilike } = await import('drizzle-orm');
  const q = `%${p.query}%`;
  const txns = await db.select().from(transactions).where(and(eq(transactions.tenantId, tenantId), ilike(transactions.memo, q))).limit(20);
  const ctcts = await db.select().from(contacts).where(and(eq(contacts.tenantId, tenantId), ilike(contacts.displayName, q))).limit(20);
  return { transactions: txns, contacts: ctcts };
});

// ─── Items Tools ────────────────────────────────────────────────

registerTool('list_items', 'List products/services', { company_id: 'string?' }, async (p, auth) => {
  checkScope(auth, 'read');
  const tenantId = await getTenantId(await resolveCompany(auth, p));
  const { list } = await import('../services/items.service.js');
  return list(tenantId, { limit: 200, offset: 0 });
});

// ─── Tags Tools ─────────────────────────────────────────────────

registerTool('list_tags', 'List tag groups and tags', { company_id: 'string?' }, async (p, auth) => {
  checkScope(auth, 'read');
  const tenantId = await getTenantId(await resolveCompany(auth, p));
  const { list } = await import('../services/tags.service.js');
  return list(tenantId);
});

// ─── Additional Transaction Tools ───────────────────────────────

registerTool('create_invoice', 'Create an invoice', {
  company_id: 'string?', customer_id: 'string', date: 'string', due_date: 'string', lines: 'string', memo: 'string?',
}, async (p, auth) => {
  checkScope(auth, 'invoicing');
  const tenantId = await getTenantId(await resolveCompany(auth, p));
  const { createInvoice } = await import('../services/invoice.service.js');
  const lines = typeof p.lines === 'string' ? JSON.parse(p.lines) : p.lines;
  return createInvoice(tenantId, { txnDate: p.date, dueDate: p.due_date, contactId: p.customer_id, lines, memo: p.memo || '' }, auth.userId);
});

registerTool('send_invoice', 'Send an invoice via email', { company_id: 'string?', invoice_id: 'string', email: 'string?' }, async (p, auth) => {
  checkScope(auth, 'invoicing');
  const tenantId = await getTenantId(await resolveCompany(auth, p));
  const { sendInvoice } = await import('../services/invoice.service.js');
  return sendInvoice(tenantId, p.invoice_id, auth.userId);
});

registerTool('record_payment', 'Record a customer payment and apply it to open invoices', {
  company_id: 'string?', customer_id: 'string', amount: 'string', date: 'string',
  deposit_to: 'string', applications: 'string', payment_method: 'string?', memo: 'string?',
}, async (p, auth) => {
  checkScope(auth, 'invoicing');
  const tenantId = await getTenantId(await resolveCompany(auth, p));
  const { receivePaymentSchema } = await import('@kis-books/shared');
  const { receivePayment } = await import('../services/payment.service.js');
  const applications = typeof p.applications === 'string' ? JSON.parse(p.applications) : p.applications;
  const input = receivePaymentSchema.parse({
    customerId: p.customer_id, date: p.date, amount: p.amount, depositTo: p.deposit_to,
    paymentMethod: p.payment_method, memo: p.memo, applications,
  });
  return receivePayment(tenantId, input, auth.userId);
});

registerTool('get_open_invoices', 'List open invoices for a customer (for payment application)', {
  company_id: 'string?', customer_id: 'string',
}, async (p, auth) => {
  checkScope(auth, 'read');
  const tenantId = await getTenantId(await resolveCompany(auth, p));
  const { getOpenInvoicesForCustomer } = await import('../services/payment.service.js');
  return getOpenInvoicesForCustomer(tenantId, p.customer_id);
});

registerTool('create_deposit', 'Create a bank deposit', {
  company_id: 'string?', date: 'string', account_id: 'string', amount: 'string', lines: 'string', memo: 'string?',
}, async (p, auth) => {
  checkScope(auth, 'write');
  const tenantId = await getTenantId(await resolveCompany(auth, p));
  const { createDeposit } = await import('../services/deposit.service.js');
  const lines = typeof p.lines === 'string' ? JSON.parse(p.lines) : p.lines;
  return createDeposit(tenantId, { txnDate: p.date, depositToAccountId: p.account_id, lines, memo: p.memo || '' }, auth.userId);
});

registerTool('create_transfer', 'Transfer between accounts', {
  company_id: 'string?', from_account_id: 'string', to_account_id: 'string', amount: 'string', date: 'string', memo: 'string?',
}, async (p, auth) => {
  checkScope(auth, 'write');
  const tenantId = await getTenantId(await resolveCompany(auth, p));
  const { createTransfer } = await import('../services/transfer.service.js');
  return createTransfer(tenantId, { txnDate: p.date, fromAccountId: p.from_account_id, toAccountId: p.to_account_id, amount: p.amount, memo: p.memo || '' }, auth.userId);
});

registerTool('create_cash_sale', 'Create a cash sale', {
  company_id: 'string?', customer_id: 'string', date: 'string', lines: 'string', payment_account_id: 'string?', memo: 'string?',
}, async (p, auth) => {
  checkScope(auth, 'write');
  const tenantId = await getTenantId(await resolveCompany(auth, p));
  const { createCashSale } = await import('../services/cash-sale.service.js');
  const lines = typeof p.lines === 'string' ? JSON.parse(p.lines) : p.lines;
  return createCashSale(tenantId, { txnDate: p.date, contactId: p.customer_id, lines, memo: p.memo || '' } as any, auth.userId);
});

registerTool('get_transaction', 'Get transaction detail with journal lines', { company_id: 'string?', transaction_id: 'string' }, async (p, auth) => {
  checkScope(auth, 'read');
  const tenantId = await getTenantId(await resolveCompany(auth, p));
  const { db } = await import('../db/index.js');
  const { transactions, journalLines } = await import('../db/schema/index.js');
  const { eq, and } = await import('drizzle-orm');
  const txn = await db.query.transactions.findFirst({ where: and(eq(transactions.tenantId, tenantId), eq(transactions.id, p.transaction_id)) });
  if (!txn) throw new Error('NOT_FOUND: Transaction not found');
  const lines = await db.select().from(journalLines).where(eq(journalLines.transactionId, txn.id));
  return { ...txn, lines };
});

// ─── Additional Contact Tools ───────────────────────────────────

registerTool('get_contact', 'Get contact detail', { company_id: 'string?', contact_id: 'string' }, async (p, auth) => {
  checkScope(auth, 'read');
  const tenantId = await getTenantId(await resolveCompany(auth, p));
  const { db } = await import('../db/index.js');
  const { contacts } = await import('../db/schema/index.js');
  const { eq, and } = await import('drizzle-orm');
  const contact = await db.query.contacts.findFirst({ where: and(eq(contacts.tenantId, tenantId), eq(contacts.id, p.contact_id)) });
  if (!contact) throw new Error('NOT_FOUND: Contact not found');
  return contact;
});

// ─── Additional Item Tools ──────────────────────────────────────

registerTool('create_item', 'Create a product/service', {
  company_id: 'string?', name: 'string', unit_price: 'string', income_account_id: 'string', description: 'string?',
}, async (p, auth) => {
  checkScope(auth, 'write');
  const tenantId = await getTenantId(await resolveCompany(auth, p));
  const { create } = await import('../services/items.service.js');
  return create(tenantId, { name: p.name, unitPrice: p.unit_price, incomeAccountId: p.income_account_id, description: p.description || '' });
});

// ─── Bank Connection Tools ──────────────────────────────────────

registerTool('get_bank_connections', 'List Plaid bank connections', { company_id: 'string?' }, async (p, auth) => {
  checkScope(auth, 'banking');
  const { getItemsForUser } = await import('../services/plaid-connection.service.js');
  return getItemsForUser(auth.userId);
});

registerTool('sync_bank_connection', 'Trigger manual bank sync', { company_id: 'string?', connection_id: 'string' }, async (p, auth) => {
  checkScope(auth, 'banking');
  const { syncItem } = await import('../services/plaid-sync.service.js');
  return syncItem(p.connection_id);
});

registerTool('categorize_feed_item', 'Categorize a bank feed item', {
  company_id: 'string?', feed_item_id: 'string', account_id: 'string', contact_id: 'string?', memo: 'string?',
}, async (p, auth) => {
  checkScope(auth, 'banking');
  const tenantId = await getTenantId(await resolveCompany(auth, p));
  const { categorize } = await import('../services/bank-feed.service.js');
  return categorize(tenantId, p.feed_item_id, { accountId: p.account_id, contactId: p.contact_id, memo: p.memo } as any);
});

// ─── Reconciliation Tools ───────────────────────────────────────

registerTool('get_reconciliation_status', 'Get reconciliation status for an account', { company_id: 'string?', account_id: 'string' }, async (p, auth) => {
  checkScope(auth, 'read');
  const tenantId = await getTenantId(await resolveCompany(auth, p));
  const { db } = await import('../db/index.js');
  const { reconciliations } = await import('../db/schema/index.js');
  const { eq, and, desc } = await import('drizzle-orm');
  const last = await db.select().from(reconciliations).where(and(eq(reconciliations.tenantId, tenantId), eq(reconciliations.accountId, p.account_id))).orderBy(desc(reconciliations.statementDate)).limit(1);
  return { lastReconciliation: last[0] || null };
});

// ─── Additional Report Tools ────────────────────────────────────

registerTool('run_ar_aging', 'Accounts receivable aging report', { company_id: 'string?', as_of_date: 'string' }, async (p, auth) => {
  checkScope(auth, 'reports');
  const tenantId = await getTenantId(await resolveCompany(auth, p));
  const { buildARAgingSummary } = await import('../services/report.service.js');
  return buildARAgingSummary(tenantId, p.as_of_date);
});

registerTool('run_cash_flow', 'Generate Cash Flow Statement', { company_id: 'string?', start_date: 'string', end_date: 'string' }, async (p, auth) => {
  checkScope(auth, 'reports');
  const tenantId = await getTenantId(await resolveCompany(auth, p));
  const { buildCashFlowStatement } = await import('../services/report.service.js');
  return buildCashFlowStatement(tenantId, p.start_date, p.end_date);
});

registerTool('run_expense_by_vendor', 'Expense by vendor report', { company_id: 'string?', start_date: 'string', end_date: 'string' }, async (p, auth) => {
  checkScope(auth, 'reports');
  const tenantId = await getTenantId(await resolveCompany(auth, p));
  const { buildExpenseByVendor } = await import('../services/report.service.js');
  return buildExpenseByVendor(tenantId, p.start_date, p.end_date);
});

// ─── Tag Transaction Tool ───────────────────────────────────────

registerTool('tag_transaction', 'Apply tags to a transaction', { company_id: 'string?', transaction_id: 'string', tag_ids: 'string' }, async (p, auth) => {
  checkScope(auth, 'write');
  const tenantId = await getTenantId(await resolveCompany(auth, p));
  const { addTags } = await import('../services/tags.service.js');
  const tagIds = typeof p.tag_ids === 'string' ? JSON.parse(p.tag_ids) : p.tag_ids;
  // Route through the service so its tenant-ownership checks
  // (assertTransactionInTenant + assertTagsInTenant) run. Going directly
  // to the table would let a caller insert rows with a tenant_id they
  // own but a transaction_id / tag_id from a different tenant.
  await addTags(tenantId, p.transaction_id, tagIds);
  return { tagged: true, tagCount: tagIds.length };
});

// ─── Overdue Summary Tool ───────────────────────────────────────

registerTool('get_overdue_summary', 'Get overdue invoice summary', { company_id: 'string?' }, async (p, auth) => {
  checkScope(auth, 'read');
  const tenantId = await getTenantId(await resolveCompany(auth, p));
  const { db } = await import('../db/index.js');
  const { transactions } = await import('../db/schema/index.js');
  const { eq, and, sql } = await import('drizzle-orm');
  const overdue = await db.select().from(transactions).where(and(
    eq(transactions.tenantId, tenantId), eq(transactions.txnType, 'invoice' as any),
    eq(transactions.invoiceStatus, 'sent'), sql`due_date < CURRENT_DATE`,
  ));
  const totalOverdue = overdue.reduce((s, i) => s + parseFloat(i.balanceDue || '0'), 0);
  return { overdueCount: overdue.length, totalOverdue, invoices: overdue.map((i) => ({ id: i.id, txnNumber: i.txnNumber, total: i.total, balanceDue: i.balanceDue, dueDate: i.dueDate })) };
});

// ─── Company Info Tool ──────────────────────────────────────────

registerTool('get_company_info', 'Get company details', { company_id: 'string?' }, async (p, auth) => {
  checkScope(auth, 'read');
  const companyId = await resolveCompany(auth, p);
  const { db } = await import('../db/index.js');
  const { companies } = await import('../db/schema/index.js');
  const { eq } = await import('drizzle-orm');
  const company = await db.query.companies.findFirst({ where: eq(companies.id, companyId) });
  if (!company) throw new Error('NOT_FOUND: Company not found');
  return company;
});

// ─── Bills / Accounts Payable ───────────────────────────────────

registerTool('list_bills', 'List bills / AP (?status, ?contact_id, ?overdue_only)', {
  company_id: 'string?', status: 'string?', contact_id: 'string?', start_date: 'string?', end_date: 'string?',
  overdue_only: 'boolean?', limit: 'number?',
}, async (p, auth) => {
  checkScope(auth, 'read');
  const tenantId = await getTenantId(await resolveCompany(auth, p));
  const { listBills } = await import('../services/bill.service.js');
  return listBills(tenantId, {
    billStatus: p.status, contactId: p.contact_id, startDate: p.start_date, endDate: p.end_date,
    overdueOnly: p.overdue_only, limit: p.limit || 50, offset: 0,
  } as any, undefined);
});

registerTool('get_bill', 'Get a bill with journal lines', { company_id: 'string?', bill_id: 'string' }, async (p, auth) => {
  checkScope(auth, 'read');
  const tenantId = await getTenantId(await resolveCompany(auth, p));
  const { getBill } = await import('../services/bill.service.js');
  return getBill(tenantId, p.bill_id);
});

registerTool('create_bill', 'Record a bill from a vendor', {
  company_id: 'string?', vendor_id: 'string', date: 'string', due_date: 'string?',
  payment_terms: 'string?', vendor_invoice_number: 'string?', lines: 'string', memo: 'string?',
}, async (p, auth) => {
  checkScope(auth, 'write');
  const tenantId = await getTenantId(await resolveCompany(auth, p));
  const { createBillSchema } = await import('@kis-books/shared');
  const { createBill } = await import('../services/bill.service.js');
  const lines = typeof p.lines === 'string' ? JSON.parse(p.lines) : p.lines;
  const input = createBillSchema.parse({
    contactId: p.vendor_id, txnDate: p.date, dueDate: p.due_date,
    paymentTerms: p.payment_terms, vendorInvoiceNumber: p.vendor_invoice_number,
    memo: p.memo, lines,
  });
  return createBill(tenantId, input, auth.userId);
});

registerTool('void_bill', 'Void a bill (creates reversing entry)', {
  company_id: 'string?', bill_id: 'string', reason: 'string',
}, async (p, auth) => {
  checkScope(auth, 'write');
  const tenantId = await getTenantId(await resolveCompany(auth, p));
  const { voidBill } = await import('../services/bill.service.js');
  await voidBill(tenantId, p.bill_id, p.reason, auth.userId);
  return { voided: true };
});

registerTool('get_payable_bills', 'Unpaid bills with balance due', {
  company_id: 'string?', contact_id: 'string?', due_on_or_before: 'string?',
}, async (p, auth) => {
  checkScope(auth, 'read');
  const tenantId = await getTenantId(await resolveCompany(auth, p));
  const { getPayableBills } = await import('../services/bill.service.js');
  return getPayableBills(tenantId, { contactId: p.contact_id, dueOnOrBefore: p.due_on_or_before });
});

// ─── Bill Payments ──────────────────────────────────────────────

registerTool('list_bill_payments', 'List bill payments', {
  company_id: 'string?', contact_id: 'string?', start_date: 'string?', end_date: 'string?', limit: 'number?',
}, async (p, auth) => {
  checkScope(auth, 'read');
  const tenantId = await getTenantId(await resolveCompany(auth, p));
  const { listBillPayments } = await import('../services/bill-payment.service.js');
  return listBillPayments(tenantId, {
    contactId: p.contact_id, startDate: p.start_date, endDate: p.end_date, limit: p.limit || 50, offset: 0,
  });
});

registerTool('pay_bills', 'Pay one or more bills from a bank account', {
  company_id: 'string?', bank_account_id: 'string', date: 'string', method: 'string',
  bills: 'string', credits: 'string?', print_later: 'boolean?', memo: 'string?',
}, async (p, auth) => {
  checkScope(auth, 'write');
  const tenantId = await getTenantId(await resolveCompany(auth, p));
  const { payBillsSchema } = await import('@kis-books/shared');
  const { payBills } = await import('../services/bill-payment.service.js');
  const bills = typeof p.bills === 'string' ? JSON.parse(p.bills) : p.bills;
  const credits = p.credits ? (typeof p.credits === 'string' ? JSON.parse(p.credits) : p.credits) : undefined;
  const input = payBillsSchema.parse({
    bankAccountId: p.bank_account_id, txnDate: p.date, method: p.method,
    printLater: p.print_later, memo: p.memo, bills, credits,
  });
  return payBills(tenantId, input, auth.userId);
});

registerTool('void_bill_payment', 'Void a bill payment', {
  company_id: 'string?', payment_id: 'string', reason: 'string',
}, async (p, auth) => {
  checkScope(auth, 'write');
  const tenantId = await getTenantId(await resolveCompany(auth, p));
  const { voidBillPayment } = await import('../services/bill-payment.service.js');
  await voidBillPayment(tenantId, p.payment_id, p.reason, auth.userId);
  return { voided: true };
});

// ─── Vendor Credits ─────────────────────────────────────────────

registerTool('list_vendor_credits', 'List vendor credits', {
  company_id: 'string?', contact_id: 'string?', start_date: 'string?', end_date: 'string?', search: 'string?', limit: 'number?',
}, async (p, auth) => {
  checkScope(auth, 'read');
  const tenantId = await getTenantId(await resolveCompany(auth, p));
  const { listVendorCredits } = await import('../services/vendor-credit.service.js');
  return listVendorCredits(tenantId, {
    contactId: p.contact_id, startDate: p.start_date, endDate: p.end_date, search: p.search,
    limit: p.limit || 50, offset: 0,
  });
});

registerTool('create_vendor_credit', 'Create a vendor credit', {
  company_id: 'string?', vendor_id: 'string', date: 'string', vendor_invoice_number: 'string?',
  lines: 'string', memo: 'string?',
}, async (p, auth) => {
  checkScope(auth, 'write');
  const tenantId = await getTenantId(await resolveCompany(auth, p));
  const { createVendorCreditSchema } = await import('@kis-books/shared');
  const { createVendorCredit } = await import('../services/vendor-credit.service.js');
  const lines = typeof p.lines === 'string' ? JSON.parse(p.lines) : p.lines;
  const input = createVendorCreditSchema.parse({
    contactId: p.vendor_id, txnDate: p.date, vendorInvoiceNumber: p.vendor_invoice_number,
    memo: p.memo, lines,
  });
  return createVendorCredit(tenantId, input, auth.userId);
});

registerTool('get_available_vendor_credits', 'Credits with remaining balance for a vendor', {
  company_id: 'string?', vendor_id: 'string',
}, async (p, auth) => {
  checkScope(auth, 'read');
  const tenantId = await getTenantId(await resolveCompany(auth, p));
  const { getAvailableCredits } = await import('../services/vendor-credit.service.js');
  return getAvailableCredits(tenantId, p.vendor_id);
});

// ─── Checks ─────────────────────────────────────────────────────

registerTool('list_checks', 'List written checks', {
  company_id: 'string?', bank_account_id: 'string?', print_status: 'string?',
  start_date: 'string?', end_date: 'string?', limit: 'number?',
}, async (p, auth) => {
  checkScope(auth, 'read');
  const tenantId = await getTenantId(await resolveCompany(auth, p));
  const { listChecks } = await import('../services/check.service.js');
  return listChecks(tenantId, {
    bankAccountId: p.bank_account_id, printStatus: p.print_status,
    startDate: p.start_date, endDate: p.end_date, limit: p.limit || 50, offset: 0,
  });
});

registerTool('write_check', 'Write a check to a payee', {
  company_id: 'string?', bank_account_id: 'string', date: 'string',
  payee_name: 'string', amount: 'string', lines: 'string',
  contact_id: 'string?', payee_address: 'string?', memo: 'string?',
  printed_memo: 'string?', print_later: 'boolean?',
}, async (p, auth) => {
  checkScope(auth, 'write');
  const tenantId = await getTenantId(await resolveCompany(auth, p));
  const { writeCheckSchema } = await import('@kis-books/shared');
  const { createCheck } = await import('../services/check.service.js');
  const lines = typeof p.lines === 'string' ? JSON.parse(p.lines) : p.lines;
  const input = writeCheckSchema.parse({
    bankAccountId: p.bank_account_id, txnDate: p.date,
    payeeNameOnCheck: p.payee_name, amount: p.amount,
    contactId: p.contact_id, payeeAddress: p.payee_address,
    memo: p.memo, printedMemo: p.printed_memo,
    printLater: p.print_later ?? false, lines,
  });
  return createCheck(tenantId, input, auth.userId);
});

registerTool('get_check_print_queue', 'Checks queued for printing', {
  company_id: 'string?', bank_account_id: 'string?',
}, async (p, auth) => {
  checkScope(auth, 'read');
  const tenantId = await getTenantId(await resolveCompany(auth, p));
  const { getPrintQueue } = await import('../services/check.service.js');
  return getPrintQueue(tenantId, p.bank_account_id);
});

// ─── Recurring Transactions ─────────────────────────────────────

registerTool('list_recurring', 'List recurring schedules', { company_id: 'string?' }, async (p, auth) => {
  checkScope(auth, 'read');
  const tenantId = await getTenantId(await resolveCompany(auth, p));
  const { list } = await import('../services/recurring.service.js');
  return list(tenantId);
});

registerTool('post_recurring_now', 'Post the next occurrence of a recurring schedule immediately', {
  company_id: 'string?', schedule_id: 'string',
}, async (p, auth) => {
  checkScope(auth, 'write');
  const tenantId = await getTenantId(await resolveCompany(auth, p));
  const { postNext } = await import('../services/recurring.service.js');
  return postNext(tenantId, p.schedule_id);
});

// ─── Budgets ────────────────────────────────────────────────────

registerTool('list_budgets', 'List budgets', { company_id: 'string?' }, async (p, auth) => {
  checkScope(auth, 'read');
  const tenantId = await getTenantId(await resolveCompany(auth, p));
  const { list } = await import('../services/budget.service.js');
  return list(tenantId);
});

registerTool('get_budget', 'Get a budget with lines', { company_id: 'string?', budget_id: 'string' }, async (p, auth) => {
  checkScope(auth, 'read');
  const tenantId = await getTenantId(await resolveCompany(auth, p));
  const { getById, getLines } = await import('../services/budget.service.js');
  const budget = await getById(tenantId, p.budget_id);
  const lines = await getLines(tenantId, p.budget_id);
  return { budget, lines };
});

registerTool('run_budget_vs_actual', 'Budget vs Actual for a period', {
  company_id: 'string?', budget_id: 'string', start_date: 'string', end_date: 'string',
}, async (p, auth) => {
  checkScope(auth, 'reports');
  const tenantId = await getTenantId(await resolveCompany(auth, p));
  const { buildBudgetVsActual } = await import('../services/budget.service.js');
  return buildBudgetVsActual(tenantId, p.budget_id, p.start_date, p.end_date);
});

// ─── Dashboard ──────────────────────────────────────────────────

registerTool('get_dashboard_snapshot', 'Overall financial snapshot', { company_id: 'string?' }, async (p, auth) => {
  checkScope(auth, 'read');
  const tenantId = await getTenantId(await resolveCompany(auth, p));
  const { getFinancialSnapshot } = await import('../services/dashboard.service.js');
  return getFinancialSnapshot(tenantId);
});

registerTool('get_cash_position', 'Cash across all bank accounts', { company_id: 'string?' }, async (p, auth) => {
  checkScope(auth, 'read');
  const tenantId = await getTenantId(await resolveCompany(auth, p));
  const { getCashPosition } = await import('../services/dashboard.service.js');
  return getCashPosition(tenantId);
});

registerTool('get_receivables_summary', 'AR summary with aging buckets', { company_id: 'string?' }, async (p, auth) => {
  checkScope(auth, 'read');
  const tenantId = await getTenantId(await resolveCompany(auth, p));
  const { getReceivablesSummary } = await import('../services/dashboard.service.js');
  return getReceivablesSummary(tenantId);
});

registerTool('get_payables_summary', 'AP summary with aging buckets', { company_id: 'string?' }, async (p, auth) => {
  checkScope(auth, 'read');
  const tenantId = await getTenantId(await resolveCompany(auth, p));
  const { getPayablesSummary } = await import('../services/dashboard.service.js');
  return getPayablesSummary(tenantId);
});

registerTool('get_action_items', 'Overdue invoices, bills due, pending feed items', { company_id: 'string?' }, async (p, auth) => {
  checkScope(auth, 'read');
  const tenantId = await getTenantId(await resolveCompany(auth, p));
  const { getActionItems } = await import('../services/dashboard.service.js');
  return getActionItems(tenantId);
});

registerTool('get_revexp_trend', 'Revenue/expense trend (?months)', { company_id: 'string?', months: 'number?' }, async (p, auth) => {
  checkScope(auth, 'read');
  const tenantId = await getTenantId(await resolveCompany(auth, p));
  const { getRevExpTrend } = await import('../services/dashboard.service.js');
  return getRevExpTrend(tenantId, p.months || 6);
});

// ─── Bank Feed Actions ──────────────────────────────────────────

registerTool('match_feed_item', 'Match a bank feed item to an existing transaction', {
  company_id: 'string?', feed_item_id: 'string', transaction_id: 'string',
}, async (p, auth) => {
  checkScope(auth, 'banking');
  const tenantId = await getTenantId(await resolveCompany(auth, p));
  const { match } = await import('../services/bank-feed.service.js');
  await match(tenantId, p.feed_item_id, p.transaction_id);
  return { matched: true };
});

registerTool('find_feed_match_candidates', 'Find existing transactions that may match a feed item', {
  company_id: 'string?', feed_item_id: 'string',
}, async (p, auth) => {
  checkScope(auth, 'banking');
  const tenantId = await getTenantId(await resolveCompany(auth, p));
  const { findMatchCandidates } = await import('../services/bank-feed.service.js');
  return findMatchCandidates(tenantId, p.feed_item_id);
});

registerTool('exclude_feed_item', 'Exclude a feed item from the ledger', {
  company_id: 'string?', feed_item_id: 'string',
}, async (p, auth) => {
  checkScope(auth, 'banking');
  const tenantId = await getTenantId(await resolveCompany(auth, p));
  const { exclude } = await import('../services/bank-feed.service.js');
  await exclude(tenantId, p.feed_item_id);
  return { excluded: true };
});

registerTool('bulk_approve_feed_items', 'Bulk approve bank feed items (applies AI suggestions)', {
  company_id: 'string?', feed_item_ids: 'string',
}, async (p, auth) => {
  checkScope(auth, 'banking');
  const tenantId = await getTenantId(await resolveCompany(auth, p));
  const ids = typeof p.feed_item_ids === 'string' ? JSON.parse(p.feed_item_ids) : p.feed_item_ids;
  const { bulkApprove } = await import('../services/bank-feed.service.js');
  return bulkApprove(tenantId, ids);
});

// ─── Reconciliation ─────────────────────────────────────────────

registerTool('get_reconciliation_history', 'Reconciliation history for an account', {
  company_id: 'string?', account_id: 'string',
}, async (p, auth) => {
  checkScope(auth, 'read');
  const tenantId = await getTenantId(await resolveCompany(auth, p));
  const { getHistory } = await import('../services/reconciliation.service.js');
  return getHistory(tenantId, p.account_id);
});

registerTool('start_reconciliation', 'Start a bank reconciliation session', {
  company_id: 'string?', account_id: 'string', statement_date: 'string', statement_ending_balance: 'string',
}, async (p, auth) => {
  checkScope(auth, 'banking');
  const tenantId = await getTenantId(await resolveCompany(auth, p));
  const { start } = await import('../services/reconciliation.service.js');
  return start(tenantId, p.account_id, p.statement_date, p.statement_ending_balance);
});

// ─── Attachments ────────────────────────────────────────────────

registerTool('list_attachments', 'List attachment metadata (optionally filtered by attachable type/id)', {
  company_id: 'string?', attachable_type: 'string?', attachable_id: 'string?', limit: 'number?',
}, async (p, auth) => {
  checkScope(auth, 'read');
  const tenantId = await getTenantId(await resolveCompany(auth, p));
  const { list } = await import('../services/attachment.service.js');
  return list(tenantId, {
    attachableType: p.attachable_type, attachableId: p.attachable_id, limit: p.limit || 50, offset: 0,
  });
});

// ─── Additional Reports ─────────────────────────────────────────

registerTool('run_balance_sheet_basis', 'Balance sheet with basis option', {
  company_id: 'string?', as_of_date: 'string', basis: 'string?',
}, async (p, auth) => {
  checkScope(auth, 'reports');
  const tenantId = await getTenantId(await resolveCompany(auth, p));
  const { buildBalanceSheet } = await import('../services/report.service.js');
  return buildBalanceSheet(tenantId, p.as_of_date, (p.basis as any) || 'accrual');
});

registerTool('run_expense_by_category', 'Expense by category (account)', {
  company_id: 'string?', start_date: 'string', end_date: 'string',
}, async (p, auth) => {
  checkScope(auth, 'reports');
  const tenantId = await getTenantId(await resolveCompany(auth, p));
  const { buildExpenseByCategory } = await import('../services/report.service.js');
  return buildExpenseByCategory(tenantId, p.start_date, p.end_date);
});

registerTool('run_vendor_balance', 'Vendor balance summary (outstanding AP by vendor)', { company_id: 'string?' }, async (p, auth) => {
  checkScope(auth, 'reports');
  const tenantId = await getTenantId(await resolveCompany(auth, p));
  const { buildVendorBalanceSummary } = await import('../services/report.service.js');
  return buildVendorBalanceSummary(tenantId);
});

registerTool('run_customer_balance', 'Customer balance summary (outstanding AR by customer)', { company_id: 'string?' }, async (p, auth) => {
  checkScope(auth, 'reports');
  const tenantId = await getTenantId(await resolveCompany(auth, p));
  const { buildCustomerBalanceSummary } = await import('../services/report.service.js');
  return buildCustomerBalanceSummary(tenantId);
});

registerTool('run_1099_vendor_summary', '1099-reportable vendor totals for a year', {
  company_id: 'string?', year: 'string',
}, async (p, auth) => {
  checkScope(auth, 'reports');
  const tenantId = await getTenantId(await resolveCompany(auth, p));
  const { build1099VendorSummary } = await import('../services/report.service.js');
  return build1099VendorSummary(tenantId, p.year);
});

registerTool('run_sales_tax_liability', 'Sales tax collected and owed', {
  company_id: 'string?', start_date: 'string', end_date: 'string',
}, async (p, auth) => {
  checkScope(auth, 'reports');
  const tenantId = await getTenantId(await resolveCompany(auth, p));
  const { buildSalesTaxLiability } = await import('../services/report.service.js');
  return buildSalesTaxLiability(tenantId, p.start_date, p.end_date);
});

registerTool('run_check_register', 'Check register for a bank account', {
  company_id: 'string?', account_id: 'string', start_date: 'string?', end_date: 'string?',
}, async (p, auth) => {
  checkScope(auth, 'reports');
  const tenantId = await getTenantId(await resolveCompany(auth, p));
  const { buildCheckRegister } = await import('../services/report.service.js');
  return buildCheckRegister(tenantId, p.account_id, p.start_date && p.end_date ? { startDate: p.start_date, endDate: p.end_date } : undefined);
});

// ─── Express Handler (JSON-RPC over HTTP) ────────────────────────

export async function handleMcpRequest(req: Request, res: Response) {
  const start = Date.now();
  let auth: McpAuthContext | null = null;

  try {
    // Check system MCP enabled
    const { db: database } = await import('../db/index.js');
    const { mcpConfig: mcpConfigTable } = await import('../db/schema/index.js');
    const config = await database.query.mcpConfig.findFirst();
    if (config && !config.isEnabled) {
      res.status(403).json({ jsonrpc: '2.0', id: req.body?.id, error: { code: -32000, message: 'MCP is disabled system-wide', data: { code: 'MCP_DISABLED' } } });
      return;
    }

    // Authenticate
    const token = (req.headers.authorization || '').replace('Bearer ', '');
    auth = await resolveMcpAuth(token);

    // Rate limit
    const rateKey = auth.keyId || auth.userId;
    const rateCheck = checkRateLimit(rateKey, 60);
    if (!rateCheck.allowed) {
      await logMcpRequest({ auth, status: 'rate_limited', ipAddress: req.ip, userAgent: req.headers['user-agent'] });
      res.status(429).json({ jsonrpc: '2.0', id: req.body?.id, error: { code: -32000, message: 'Rate limit exceeded', data: { code: 'RATE_LIMITED', retry_after_seconds: rateCheck.retryAfterSeconds } } });
      return;
    }

    const body = req.body;

    // ─── Resources ──────────────────────────────────────────────
    if (body.method === 'resources/list') {
      const resourceList = [
        { uri: 'kisbooks://companies', name: 'Companies', description: 'Companies the user has access to' },
        { uri: 'kisbooks://company/{id}/chart-of-accounts', name: 'Chart of Accounts', description: 'Full COA for a company' },
        { uri: 'kisbooks://company/{id}/contacts', name: 'Contacts', description: 'Contact list' },
        { uri: 'kisbooks://company/{id}/recent-transactions', name: 'Recent Transactions', description: 'Last 50 transactions' },
        { uri: 'kisbooks://company/{id}/bank-feed/pending', name: 'Pending Bank Feed', description: 'Pending bank feed items' },
        { uri: 'kisbooks://company/{id}/invoices/overdue', name: 'Overdue Invoices', description: 'Overdue invoices' },
        { uri: 'kisbooks://company/{id}/bills/payable', name: 'Payable Bills', description: 'Unpaid bills with balance due' },
        { uri: 'kisbooks://company/{id}/bill-payments', name: 'Bill Payments', description: 'Recent bill payments' },
        { uri: 'kisbooks://company/{id}/vendor-credits', name: 'Vendor Credits', description: 'Vendor credits with remaining balance' },
        { uri: 'kisbooks://company/{id}/recurring', name: 'Recurring Schedules', description: 'Active recurring transactions' },
        { uri: 'kisbooks://company/{id}/budgets', name: 'Budgets', description: 'Budgets defined for this company' },
        { uri: 'kisbooks://company/{id}/checks/print-queue', name: 'Check Print Queue', description: 'Checks queued for printing' },
        { uri: 'kisbooks://company/{id}/reconciliations', name: 'Reconciliations', description: 'Reconciliation history' },
        { uri: 'kisbooks://company/{id}/items', name: 'Items', description: 'Products / services catalog' },
        { uri: 'kisbooks://company/{id}/tags', name: 'Tags', description: 'Tag groups and tags' },
        { uri: 'kisbooks://company/{id}/dashboard', name: 'Dashboard', description: 'Dashboard summary' },
      ];
      res.json({ jsonrpc: '2.0', id: body.id, result: { resources: resourceList } });
      return;
    }

    if (body.method === 'resources/read') {
      const uri = body.params?.uri as string;
      if (!uri) { res.json({ jsonrpc: '2.0', id: body.id, error: { code: -32602, message: 'URI required' } }); return; }

      let data: any;
      if (uri === 'kisbooks://companies') {
        const companies = await getUserCompanies(auth.userId);
        data = companies.map((c: any) => ({ id: c.id, name: c.businessName }));
      } else {
        const match = uri.match(/kisbooks:\/\/company\/([^/]+)\/(.+)/);
        if (!match) { res.json({ jsonrpc: '2.0', id: body.id, error: { code: -32602, message: 'Invalid URI' } }); return; }
        const companyId = match[1]!;
        const resource = match[2]!;
        await resolveCompany(auth, { company_id: companyId }); // access check
        const tenantId = await getTenantId(companyId);
        const { db: database } = await import('../db/index.js');
        const { accounts, contacts, transactions, bankFeedItems } = await import('../db/schema/index.js');
        const { eq, and, desc, sql } = await import('drizzle-orm');

        switch (resource) {
          case 'chart-of-accounts':
            data = await database.select().from(accounts).where(and(eq(accounts.tenantId, tenantId), eq(accounts.isActive, true)));
            break;
          case 'contacts':
            data = await database.select().from(contacts).where(eq(contacts.tenantId, tenantId)).limit(200);
            break;
          case 'recent-transactions':
            data = await database.select().from(transactions).where(eq(transactions.tenantId, tenantId)).orderBy(desc(transactions.txnDate)).limit(50);
            break;
          case 'bank-feed/pending':
            data = await database.select().from(bankFeedItems).where(and(eq(bankFeedItems.tenantId, tenantId), eq(bankFeedItems.status, 'pending'))).limit(100);
            break;
          case 'invoices/overdue':
            data = await database.select().from(transactions).where(and(eq(transactions.tenantId, tenantId), eq(transactions.txnType, 'invoice' as any), sql`due_date < CURRENT_DATE`)).limit(50);
            break;
          case 'bills/payable': {
            const { getPayableBills } = await import('../services/bill.service.js');
            data = await getPayableBills(tenantId, {});
            break;
          }
          case 'bill-payments': {
            const { listBillPayments } = await import('../services/bill-payment.service.js');
            data = await listBillPayments(tenantId, { limit: 100, offset: 0 });
            break;
          }
          case 'vendor-credits': {
            const { listVendorCredits } = await import('../services/vendor-credit.service.js');
            data = await listVendorCredits(tenantId, { limit: 100, offset: 0 });
            break;
          }
          case 'recurring': {
            const { list: listRecurring } = await import('../services/recurring.service.js');
            data = await listRecurring(tenantId);
            break;
          }
          case 'budgets': {
            const { list: listBudgets } = await import('../services/budget.service.js');
            data = await listBudgets(tenantId);
            break;
          }
          case 'checks/print-queue': {
            const { getPrintQueue } = await import('../services/check.service.js');
            data = await getPrintQueue(tenantId);
            break;
          }
          case 'reconciliations': {
            const { reconciliations } = await import('../db/schema/index.js');
            data = await database.select().from(reconciliations)
              .where(eq(reconciliations.tenantId, tenantId))
              .orderBy(desc(reconciliations.statementDate))
              .limit(50);
            break;
          }
          case 'items': {
            const { list: listItems } = await import('../services/items.service.js');
            data = await listItems(tenantId, { limit: 200, offset: 0 });
            break;
          }
          case 'tags': {
            const { list: listTags, listGroups } = await import('../services/tags.service.js');
            const [tags, groups] = await Promise.all([listTags(tenantId), listGroups(tenantId)]);
            data = { tags, groups };
            break;
          }
          case 'dashboard': {
            const { getFinancialSnapshot } = await import('../services/dashboard.service.js');
            data = await getFinancialSnapshot(tenantId);
            break;
          }
          default:
            res.json({ jsonrpc: '2.0', id: body.id, error: { code: -32602, message: `Unknown resource: ${resource}` } });
            return;
        }
      }

      await logMcpRequest({ auth, resourceUri: uri, status: 'success', durationMs: Date.now() - start, ipAddress: req.ip, userAgent: req.headers['user-agent'] });
      res.json({ jsonrpc: '2.0', id: body.id, result: { contents: [{ uri, text: JSON.stringify(data) }] } });
      return;
    }

    // ─── Tools ──────────────────────────────────────────────────
    if (body.method === 'tools/list') {
      const toolList = Array.from(tools.entries()).map(([name, def]) => ({
        name, description: def.description, inputSchema: { type: 'object', properties: def.schema },
      }));
      res.json({ jsonrpc: '2.0', id: body.id, result: { tools: toolList } });
      return;
    }

    if (body.method === 'tools/call') {
      const toolName = body.params?.name;
      const rawParams = body.params?.arguments || {};
      const toolDef = tools.get(toolName);
      if (!toolDef) {
        res.json({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: `Unknown tool: ${toolName}` } });
        return;
      }

      const toolParams = sanitizeMcpParams(rawParams);
      const result = await toolDef.handler(toolParams, auth);
      const loggedCompanyId = typeof toolParams['company_id'] === 'string' ? toolParams['company_id'] : undefined;
      await logMcpRequest({ auth, toolName, companyId: loggedCompanyId, parameters: toolParams, status: 'success', responseSummary: typeof result === 'object' ? JSON.stringify(result).slice(0, 200) : String(result), durationMs: Date.now() - start, ipAddress: req.ip, userAgent: req.headers['user-agent'] });
      res.json({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: JSON.stringify(result) }] } });
      return;
    }

    if (body.method === 'initialize') {
      res.json({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2024-11-05', serverInfo: { name: 'kis-books', version: '1.0.0' }, capabilities: { tools: {} } } });
      return;
    }

    res.json({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: `Method not supported: ${body.method}` } });
  } catch (err: any) {
    const errMsg = err.message || 'Internal error';
    const code = errMsg.split(':')[0] || 'INTERNAL_ERROR';
    if (auth) {
      await logMcpRequest({ auth, status: 'error', errorCode: code, ipAddress: req.ip, userAgent: req.headers['user-agent'], durationMs: Date.now() - start }).catch(() => {});
    }
    const httpStatus = code.includes('AUTH') ? 401 : code.includes('ACCESS') || code.includes('SCOPE') || code.includes('MCP_DISABLED') ? 403 : code === 'RATE_LIMITED' ? 429 : 400;
    res.status(httpStatus).json({ jsonrpc: '2.0', id: req.body?.id, error: { code: -32000, message: errMsg, data: { code } } });
  }
}
