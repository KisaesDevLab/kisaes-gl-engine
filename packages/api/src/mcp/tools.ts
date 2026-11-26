// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

// The MCP tools. Each declares its input, the token scope it needs and the
// permission it needs in the client's books (the resource its REST router
// is gated on); server.ts checks all of that before the handler runs, so a
// handler starts with a client it may work in (ctx.tenantId / ctx.companyId).
//
// Line items and other lists are real arrays in the published schema. A
// JSON-encoded string of the same array is still accepted, for clients that
// can only send strings.

import { z, type ZodTypeAny } from 'zod';
import { and, desc, eq, ilike, inArray, isNull, or, sql, type AnyColumn } from 'drizzle-orm';
import {
  createBillSchema, createCashSaleSchema, createDepositSchema, createExpenseSchema, createInvoiceSchema,
  createJournalEntrySchema, createTransferSchema, createVendorCreditSchema, payBillsSchema,
  receivePaymentSchema, startReconciliationSchema, updateReconciliationSchema, writeCheckSchema,
} from '@kis-books/shared';
import { db } from '../db/index.js';
import {
  accounts, bankConnections, bankFeedItems, companies, contacts, journalLines, reconciliations, transactions,
} from '../db/schema/index.js';
import { env } from '../config/env.js';
import { escapeLike } from '../utils/sql-like.js';
import { getActiveCompany, getUserCompanies, resolveClient, setActiveCompany, clearActiveCompany } from './context.js';
import {
  McpToolError, companyTool, date, id, jsonArray, money, optBool, optDate, optId, optInt, optText,
  sessionTool, text, userTool, type ToolContext,
} from './registry.js';

const FIN_REPORT = ['reports', 'financial_reports'] as const;
const AR_REPORT = ['reports', 'invoices'] as const;
const AP_REPORT = ['reports', 'bills'] as const;

// ─── One company of a client file ───────────────────────────────
//
// A client file (tenant) can hold more than one company. A row stamped with
// a company is that company's; a row with no company belongs to the whole
// file (the chart of accounts, contacts, tags, older rows). A tool runs in
// the company it was called for: it lists that company's rows and the
// file's, as the app's screens do, and it refuses to act on a row stamped
// with a sibling company. What the app itself keeps file-wide stays so
// here: accounts, contacts, tags, recurring schedules and the dashboard.

/** The selected company's rows, and the file's. */
const inCompany = (column: AnyColumn, ctx: ToolContext) => or(isNull(column), eq(column, ctx.companyId));

function assertSameCompany(what: string, rowCompanyId: string | null | undefined, ctx: ToolContext): void {
  if (rowCompanyId && rowCompanyId !== ctx.companyId) {
    throw new McpToolError(
      'WRONG_COMPANY',
      `This ${what} belongs to another company in the same client file, not ${ctx.companyName}. `
        + 'Nothing was changed. Call the tool with that company\'s company_id (list_companies shows them).',
    );
  }
}

/** A transaction id that is missing is left to the service to report. */
async function transactionInCompany(ctx: ToolContext, transactionId: string): Promise<void> {
  const [row] = await db.select({ companyId: transactions.companyId }).from(transactions)
    .where(and(eq(transactions.tenantId, ctx.tenantId), eq(transactions.id, transactionId))).limit(1);
  assertSameCompany('transaction', row?.companyId, ctx);
}

/** A feed item is its own company's, or else its bank connection's. */
async function feedItemsInCompany(ctx: ToolContext, feedItemIds: string[]): Promise<void> {
  if (feedItemIds.length === 0) return;
  const rows = await db.select({ own: bankFeedItems.companyId, connection: bankConnections.companyId })
    .from(bankFeedItems)
    .leftJoin(bankConnections, eq(bankConnections.id, bankFeedItems.bankConnectionId))
    .where(and(eq(bankFeedItems.tenantId, ctx.tenantId), inArray(bankFeedItems.id, feedItemIds)));
  for (const row of rows) assertSameCompany('bank feed item', row.own ?? row.connection, ctx);
}

async function accountInCompany(ctx: ToolContext, accountId: string): Promise<void> {
  const [row] = await db.select({ companyId: accounts.companyId }).from(accounts)
    .where(and(eq(accounts.tenantId, ctx.tenantId), eq(accounts.id, accountId))).limit(1);
  assertSameCompany('account', row?.companyId, ctx);
}

/** A reconciliation is its own company's, or else its account's. */
async function reconciliationInCompany(ctx: ToolContext, reconciliationId: string): Promise<void> {
  const [row] = await db.select({ own: reconciliations.companyId, account: accounts.companyId })
    .from(reconciliations)
    .leftJoin(accounts, eq(accounts.id, reconciliations.accountId))
    .where(and(eq(reconciliations.tenantId, ctx.tenantId), eq(reconciliations.id, reconciliationId))).limit(1);
  assertSameCompany('reconciliation', row?.own ?? row?.account, ctx);
}

/** The published shape of one field of a shared request schema (unwrapping a refined object). */
function fieldOf(schema: ZodTypeAny, key: string): ZodTypeAny {
  let s: ZodTypeAny = schema;
  while (s instanceof z.ZodEffects) s = s.innerType();
  if (!(s instanceof z.ZodObject)) throw new Error(`MCP: ${key} is not on an object schema`);
  const found = (s.shape as Record<string, ZodTypeAny>)[key];
  if (!found) throw new Error(`MCP: no field ${key}`);
  let field: ZodTypeAny = found;
  while (field instanceof z.ZodOptional || field instanceof z.ZodNullable) field = field.unwrap();
  return field;
}

const lines = (schema: ZodTypeAny, what: string, key = 'lines') => jsonArray(fieldOf(schema, key) as z.ZodArray<ZodTypeAny>, what);
const idList = (what: string, max: number) => jsonArray(z.array(z.string().uuid()).min(1).max(max), what);
const basis = z.preprocess((v) => (v === '' || v === null ? undefined : v), z.enum(['cash', 'accrual']).optional())
  .describe('Accounting basis; accrual when omitted');
const tagFilter = optId('Only count lines (or transactions) carrying this tag');

// ─── Clients (the connection's context) ─────────────────────────

sessionTool('list_companies', {
  title: 'List clients',
  description: 'The client companies you can work in, with your role in each and whether MCP is turned on for it. '
    + 'Firm staff see every client they have been given access to. Pass an id as company_id to any other tool. '
    + 'set_active_company can remember one for this connection; a tool that changes data may still ask for company_id.',
  input: {
    search: optText('Only clients whose name contains this text'),
  },
  readOnly: true,
  handler: async (p, { auth }) => {
    const all = await getUserCompanies(auth.userId);
    const needle = p.search?.trim().toLowerCase();
    return all
      .filter((c) => !needle || c.name.toLowerCase().includes(needle))
      .filter((c) => !auth.allowedCompanies || auth.allowedCompanies.includes(c.id))
      .map((c) => ({ id: c.id, name: c.name, tenantId: c.tenantId, role: c.role, mcpEnabled: c.mcpEnabled }));
  },
});

sessionTool('set_active_company', {
  title: 'Choose the client to work in',
  description: 'Sets the client company the following calls on this connection act on when they do not pass company_id. '
    + 'Returns its name; say it back to the user before making changes. '
    + 'If used_for_changes is false, every call that changes data must pass company_id itself.',
  input: { company_id: id('The client company (an id from list_companies)') },
  readOnly: false,
  handler: async (p, { auth, session }) => {
    let client;
    try {
      client = await resolveClient(auth, session, p.company_id);
    } catch (err) {
      // A switch that failed must not leave the earlier client in place:
      // the caller asked to stop working there.
      clearActiveCompany(session.key);
      throw err;
    }
    setActiveCompany(session.key, client.companyId);
    return {
      active_company_id: client.companyId, name: client.companyName, role: client.role,
      // Without a session of its own the choice is shared by every chat on
      // this key or sign-in, so it is not trusted for changes.
      used_for_changes: session.own,
    };
  },
});

sessionTool('get_active_company', {
  title: 'Show the active client',
  description: 'The client company this connection currently acts on, if one was set.',
  input: {},
  readOnly: true,
  handler: async (_p, { auth, session }) => {
    const active = getActiveCompany(session.key);
    const company = active ? (await getUserCompanies(auth.userId)).find((c) => c.id === active) : undefined;
    return { active_company_id: company?.id ?? null, name: company?.name ?? null };
  },
});

// ─── Chart of accounts ──────────────────────────────────────────

companyTool('list_accounts', {
  title: 'List chart of accounts',
  description: 'The chart of accounts: id, number, name, type and balance of each account.',
  input: {},
  scope: 'read', resource: 'accounts', mode: 'read',
  handler: async (_p, ctx) => {
    const { list } = await import('../services/accounts.service.js');
    return list(ctx.tenantId, { limit: 500, offset: 0 });
  },
});

companyTool('get_account_balance', {
  title: 'Get an account balance',
  description: 'The current balance of one account.',
  input: { account_id: id('The account') },
  scope: 'read', resource: 'accounts', mode: 'read',
  handler: async (p, ctx) => {
    await accountInCompany(ctx, p.account_id);
    const account = await db.query.accounts.findFirst({ where: and(eq(accounts.tenantId, ctx.tenantId), eq(accounts.id, p.account_id)) });
    if (!account) throw new McpToolError('NOT_FOUND', 'Account not found');
    return { id: account.id, name: account.name, balance: account.balance, accountType: account.accountType };
  },
});

// ─── Contacts ───────────────────────────────────────────────────

companyTool('list_contacts', {
  title: 'List contacts',
  description: 'Customers and vendors.',
  input: { type: z.preprocess((v) => (v === '' || v === null ? undefined : v), z.enum(['customer', 'vendor', 'both']).optional()).describe('Only this kind of contact') },
  scope: 'read', resource: 'contacts', mode: 'read',
  handler: async (p, ctx) => {
    const { list } = await import('../services/contacts.service.js');
    return list(ctx.tenantId, { limit: 200, offset: 0, contactType: p.type }, ctx.companyId);
  },
});

companyTool('get_contact', {
  title: 'Get a contact',
  description: 'One customer or vendor.',
  input: { contact_id: id('The contact') },
  scope: 'read', resource: 'contacts', mode: 'read',
  handler: async (p, ctx) => {
    const contact = await db.query.contacts.findFirst({ where: and(eq(contacts.tenantId, ctx.tenantId), eq(contacts.id, p.contact_id)) });
    if (!contact) throw new McpToolError('NOT_FOUND', 'Contact not found');
    return contact;
  },
});

companyTool('create_contact', {
  title: 'Create a contact',
  description: 'Adds a customer or vendor.',
  input: {
    display_name: text('Name as it appears on lists and documents').min(1).max(255),
    type: z.enum(['customer', 'vendor', 'both']).describe('Kind of contact'),
    email: optText('Email address'),
    phone: optText('Phone number'),
  },
  scope: 'write', resource: 'contacts', mode: 'write',
  handler: async (p, ctx) => {
    const { createContactSchema } = await import('@kis-books/shared');
    const { create } = await import('../services/contacts.service.js');
    const input = createContactSchema.parse({ displayName: p.display_name, contactType: p.type, email: p.email, phone: p.phone });
    return create(ctx.tenantId, input, ctx.userId, ctx.companyId);
  },
});

// ─── Transactions ───────────────────────────────────────────────

companyTool('list_transactions', {
  title: 'List transactions',
  description: 'Recent transactions, newest first.',
  input: {
    type: optText('Only this transaction type (invoice, bill, expense, deposit, transfer, journal_entry, cash_sale, ...)'),
    limit: optInt('How many to return (default 50)', 1000),
  },
  scope: 'read', resource: 'transactions', mode: 'read',
  handler: async (p, ctx) => {
    const conds = [eq(transactions.tenantId, ctx.tenantId), inCompany(transactions.companyId, ctx)];
    if (p.type) conds.push(sql`${transactions.txnType}::text = ${p.type}`);
    return db.select().from(transactions).where(and(...conds)).orderBy(desc(transactions.txnDate)).limit(p.limit ?? 50);
  },
});

companyTool('get_transaction', {
  title: 'Get a transaction',
  description: 'One transaction with its journal lines.',
  input: { transaction_id: id('The transaction') },
  scope: 'read', resource: 'transactions', mode: 'read',
  handler: async (p, ctx) => {
    const txn = await db.query.transactions.findFirst({ where: and(eq(transactions.tenantId, ctx.tenantId), eq(transactions.id, p.transaction_id)) });
    if (!txn) throw new McpToolError('NOT_FOUND', 'Transaction not found');
    assertSameCompany('transaction', txn.companyId, ctx);
    const txnLines = await db.select().from(journalLines).where(eq(journalLines.transactionId, txn.id));
    return { ...txn, lines: txnLines };
  },
});

companyTool('create_expense', {
  title: 'Record an expense',
  description: 'Records money spent from a bank or credit card account, split across one or more expense accounts.',
  input: {
    date: date('Expense date'),
    payee_id: optId('The vendor paid (a contact)'),
    bank_account_id: id('The bank or credit card account the money came from'),
    lines: lines(createExpenseSchema, 'Expense lines: {expenseAccountId, amount, description?, tagId?}'),
    memo: optText('Memo'),
  },
  scope: 'write', resource: 'transactions', mode: 'write',
  handler: async (p, ctx) => {
    const { createExpense } = await import('../services/expense.service.js');
    const input = createExpenseSchema.parse({
      txnDate: p.date, contactId: p.payee_id, payFromAccountId: p.bank_account_id, lines: p.lines, memo: p.memo ?? '',
    });
    return createExpense(ctx.tenantId, input, ctx.userId, ctx.companyId);
  },
});

companyTool('create_journal_entry', {
  title: 'Post a journal entry',
  description: 'Posts a general journal entry. Total debits must equal total credits.',
  input: {
    date: date('Entry date'),
    lines: lines(createJournalEntrySchema, 'Journal lines (at least 2): {accountId, debit, credit, description?, tagId?, contactId?}; amounts are decimal strings'),
    memo: optText('Memo'),
  },
  scope: 'write', resource: 'transactions', mode: 'write',
  handler: async (p, ctx) => {
    const { createJournalEntry } = await import('../services/journal-entry.service.js');
    const input = createJournalEntrySchema.parse({ txnDate: p.date, lines: p.lines, memo: p.memo ?? '' });
    return createJournalEntry(ctx.tenantId, input, ctx.userId, ctx.companyId);
  },
});

companyTool('void_transaction', {
  title: 'Void a transaction',
  description: 'Voids a posted transaction with a reversing entry. Nothing is deleted. Confirm with the user first.',
  input: {
    transaction_id: id('The transaction to void'),
    reason: optText('Why it is being voided (kept in the audit trail)'),
  },
  scope: 'write', resource: 'transactions', mode: 'write', destructive: true,
  handler: async (p, ctx) => {
    await transactionInCompany(ctx, p.transaction_id);
    const { voidTransaction } = await import('../services/ledger.service.js');
    await voidTransaction(ctx.tenantId, p.transaction_id, p.reason || 'Voided via MCP', ctx.userId, { companyId: ctx.companyId });
    return { voided: true };
  },
});

companyTool('create_transfer', {
  title: 'Transfer between accounts',
  description: 'Moves money from one bank or balance-sheet account to another.',
  input: {
    from_account_id: id('Account the money leaves'),
    to_account_id: id('Account the money arrives in'),
    amount: money('Amount'),
    date: date('Transfer date'),
    memo: optText('Memo'),
  },
  scope: 'write', resource: 'transactions', mode: 'write',
  handler: async (p, ctx) => {
    const { createTransfer } = await import('../services/transfer.service.js');
    const input = createTransferSchema.parse({
      txnDate: p.date, fromAccountId: p.from_account_id, toAccountId: p.to_account_id, amount: p.amount, memo: p.memo ?? '',
    });
    return createTransfer(ctx.tenantId, input, ctx.userId, ctx.companyId);
  },
});

companyTool('create_cash_sale', {
  title: 'Record a cash sale',
  description: 'Records a sale paid at once (a sales receipt).',
  input: {
    customer_id: optId('The customer (a contact)'),
    date: date('Sale date'),
    payment_account_id: id('Account the money was deposited to'),
    lines: lines(createCashSaleSchema, 'Sale lines: {accountId or itemId, description?, quantity?, unitPrice?, isTaxable?}'),
    memo: optText('Memo'),
  },
  scope: 'write', resource: 'transactions', mode: 'write',
  handler: async (p, ctx) => {
    const { createCashSale } = await import('../services/cash-sale.service.js');
    const input = createCashSaleSchema.parse({
      txnDate: p.date, contactId: p.customer_id, depositToAccountId: p.payment_account_id, lines: p.lines, memo: p.memo ?? '',
    });
    return createCashSale(ctx.tenantId, input, ctx.userId, ctx.companyId);
  },
});

companyTool('search', {
  title: 'Search transactions and contacts',
  description: 'Finds transactions by memo text and contacts by name.',
  input: { query: text('Text to look for').min(1).max(200) },
  scope: 'read', resource: ['transactions', 'contacts'], mode: 'read',
  handler: async (p, ctx) => {
    const q = `%${escapeLike(p.query)}%`;
    const txns = await db.select().from(transactions).where(and(eq(transactions.tenantId, ctx.tenantId), inCompany(transactions.companyId, ctx), ilike(transactions.memo, q))).limit(20);
    const ctcts = await db.select().from(contacts).where(and(eq(contacts.tenantId, ctx.tenantId), ilike(contacts.displayName, q))).limit(20);
    return { transactions: txns, contacts: ctcts };
  },
});

// ─── Tags ───────────────────────────────────────────────────────

companyTool('list_tags', {
  title: 'List tags',
  description: 'Tag groups and tags.',
  input: {},
  scope: 'read', resource: 'tags', mode: 'read',
  handler: async (_p, ctx) => {
    const { list } = await import('../services/tags.service.js');
    return list(ctx.tenantId);
  },
});

companyTool('tag_transaction', {
  title: 'Tag a transaction',
  description: 'Replaces a transaction\'s tags. One tag is stamped on every journal line; two or more are kept at the header for older multi-tag clients; an empty list clears them.',
  input: {
    transaction_id: id('The transaction'),
    tag_ids: jsonArray(z.array(z.string().uuid()).max(50), 'Tag ids to apply (empty to clear)'),
  },
  scope: 'write', resource: 'transactions', mode: 'write', idempotent: true,
  handler: async (p, ctx) => {
    await transactionInCompany(ctx, p.transaction_id);
    // ADR 0XX §4 — the split-level model is line-authoritative. replaceTags
    // routes 0 or 1 tag through setTransactionLineTag; 2 or more keep the
    // header-level junction so clients that batch-tagged do not regress.
    const { replaceTags } = await import('../services/tags.service.js');
    await replaceTags(ctx.tenantId, p.transaction_id, p.tag_ids);
    return { tagged: true, tagCount: p.tag_ids.length, lineLevel: p.tag_ids.length <= 1 };
  },
});

companyTool('set_transaction_tag', {
  title: 'Set a transaction\'s tag',
  description: 'Applies one tag to every journal line of a transaction, or clears the tag when tag_id is omitted.',
  input: {
    transaction_id: id('The transaction'),
    tag_id: optId('The tag; omit to clear'),
  },
  scope: 'write', resource: 'transactions', mode: 'write', idempotent: true,
  handler: async (p, ctx) => {
    await transactionInCompany(ctx, p.transaction_id);
    const { setTransactionLineTag } = await import('../services/tags.service.js');
    const tagId = p.tag_id ?? null;
    await setTransactionLineTag(ctx.tenantId, p.transaction_id, tagId);
    return { tagged: tagId !== null, tagId };
  },
});

// ─── Items ──────────────────────────────────────────────────────

companyTool('list_items', {
  title: 'List products and services',
  description: 'The items sold or bought.',
  input: {},
  scope: 'read', resource: 'items', mode: 'read',
  handler: async (_p, ctx) => {
    const { list } = await import('../services/items.service.js');
    return list(ctx.tenantId, { limit: 200, offset: 0 }, ctx.companyId);
  },
});

companyTool('create_item', {
  title: 'Create a product or service',
  description: 'Adds an item that can be put on invoices.',
  input: {
    name: text('Item name').min(1).max(255),
    unit_price: money('Default price'),
    income_account_id: id('Income account sales of the item post to'),
    description: optText('Description shown on documents'),
  },
  scope: 'write', resource: 'items', mode: 'write',
  handler: async (p, ctx) => {
    const { createItemSchema } = await import('@kis-books/shared');
    const { create } = await import('../services/items.service.js');
    const input = createItemSchema.parse({
      name: p.name, unitPrice: p.unit_price, incomeAccountId: p.income_account_id, description: p.description ?? '',
    });
    return create(ctx.tenantId, input, ctx.userId, ctx.companyId);
  },
});

// ─── Invoices and customer payments ─────────────────────────────

companyTool('list_invoices', {
  title: 'List invoices',
  description: 'Recent invoices, newest first.',
  input: { status: optText('Only this invoice status (draft, sent, partial, paid, void)') },
  scope: 'read', resource: 'invoices', mode: 'read',
  handler: async (p, ctx) => {
    const conds = [eq(transactions.tenantId, ctx.tenantId), inCompany(transactions.companyId, ctx), sql`${transactions.txnType}::text = 'invoice'`];
    if (p.status) conds.push(eq(transactions.invoiceStatus, p.status));
    return db.select().from(transactions).where(and(...conds)).orderBy(desc(transactions.txnDate)).limit(100);
  },
});

companyTool('create_invoice', {
  title: 'Create an invoice',
  description: 'Creates an invoice for a customer. Lines are taxable unless isTaxable is false.',
  input: {
    customer_id: id('The customer (a contact)'),
    date: date('Invoice date'),
    due_date: optDate('Due date'),
    lines: lines(createInvoiceSchema, 'Invoice lines: {accountId or itemId, description?, quantity?, unitPrice?, isTaxable?, tagId?}'),
    memo: optText('Memo'),
  },
  scope: 'invoicing', resource: 'invoices', mode: 'write',
  handler: async (p, ctx) => {
    const { createInvoice } = await import('../services/invoice.service.js');
    // A line without isTaxable stays taxable here, as before (U-122 made the
    // service default an omitted flag to the item's, else false).
    const withTax = (p.lines as Array<Record<string, unknown>>).map((l) => ({ ...l, isTaxable: l['isTaxable'] ?? true }));
    const input = createInvoiceSchema.parse({ txnDate: p.date, dueDate: p.due_date, contactId: p.customer_id, lines: withTax, memo: p.memo ?? '' });
    // The invoice belongs to the company (its sales tax rows and reports, U-147).
    return createInvoice(ctx.tenantId, input, ctx.userId, ctx.companyId);
  },
});

companyTool('send_invoice', {
  // The name is kept for clients that already call it. It has never sent
  // mail: the app emails an invoice with the PDF its own page renders,
  // which this server cannot produce. So it says what it does.
  title: 'Mark an invoice as sent',
  description: 'Marks an invoice as sent. It does NOT email the invoice: no message goes to the customer. '
    + 'To email it, the user opens the invoice in the app and uses Send there. Never tell the user an email was sent.',
  input: { invoice_id: id('The invoice') },
  scope: 'invoicing', resource: 'invoices', mode: 'write', idempotent: true,
  handler: async (p, ctx) => {
    const { sendInvoice } = await import('../services/invoice.service.js');
    await sendInvoice(ctx.tenantId, p.invoice_id, ctx.userId, ctx.companyId);
    return {
      invoice_id: p.invoice_id, marked_sent: true, emailed: false,
      note: 'The invoice is marked as sent. No email was sent; send it from the invoice in the app.',
    };
  },
});

companyTool('get_open_invoices', {
  title: 'List a customer\'s open invoices',
  description: 'Unpaid invoices of one customer, to apply a payment to.',
  input: { customer_id: id('The customer (a contact)') },
  scope: 'read', resource: 'receive_payment', mode: 'read',
  handler: async (p, ctx) => {
    const { getOpenInvoicesForCustomer } = await import('../services/payment.service.js');
    return getOpenInvoicesForCustomer(ctx.tenantId, p.customer_id, ctx.companyId);
  },
});

companyTool('record_payment', {
  title: 'Receive a customer payment',
  description: 'Records a payment from a customer and applies it to open invoices (see get_open_invoices).',
  input: {
    customer_id: id('The customer (a contact)'),
    amount: money('Amount received'),
    date: date('Payment date'),
    deposit_to: id('Account the payment goes to (a bank account or Payments Clearing)'),
    applications: lines(receivePaymentSchema, 'How the payment is applied: {invoiceId, amount}', 'applications'),
    payment_method: optText('How it was paid (check, cash, credit_card, ach, ...)'),
    memo: optText('Memo'),
  },
  scope: 'invoicing', resource: 'receive_payment', mode: 'write',
  handler: async (p, ctx) => {
    const { receivePayment } = await import('../services/payment.service.js');
    const input = receivePaymentSchema.parse({
      customerId: p.customer_id, date: p.date, amount: p.amount, depositTo: p.deposit_to,
      paymentMethod: p.payment_method, memo: p.memo, applications: p.applications,
    });
    // The company scopes the customer, the invoices and the deposit account (U-132).
    return receivePayment(ctx.tenantId, input, ctx.userId, ctx.companyId);
  },
});

companyTool('get_overdue_summary', {
  title: 'Summarize overdue invoices',
  description: 'Sent invoices past their due date, with the total outstanding.',
  input: {},
  scope: 'read', resource: 'invoices', mode: 'read',
  handler: async (_p, ctx) => {
    const overdue = await db.select().from(transactions).where(and(
      eq(transactions.tenantId, ctx.tenantId), inCompany(transactions.companyId, ctx), sql`${transactions.txnType}::text = 'invoice'`,
      eq(transactions.invoiceStatus, 'sent'), sql`due_date < CURRENT_DATE`,
    ));
    const totalOverdue = overdue.reduce((s, i) => s + parseFloat(i.balanceDue || '0'), 0);
    return {
      overdueCount: overdue.length, totalOverdue,
      invoices: overdue.map((i) => ({ id: i.id, txnNumber: i.txnNumber, total: i.total, balanceDue: i.balanceDue, dueDate: i.dueDate })),
    };
  },
});

// ─── Deposits ───────────────────────────────────────────────────

companyTool('create_deposit', {
  title: 'Record a bank deposit',
  description: 'Records a deposit into a bank account, from one or more source accounts (for example Payments Clearing).',
  input: {
    date: date('Deposit date'),
    account_id: id('The bank account deposited to'),
    lines: lines(createDepositSchema, 'Deposit lines: {accountId, amount, description?, contactId?}'),
    memo: optText('Memo'),
  },
  scope: 'write', resource: 'banking', mode: 'write',
  handler: async (p, ctx) => {
    const { createDeposit } = await import('../services/deposit.service.js');
    const input = createDepositSchema.parse({ txnDate: p.date, depositToAccountId: p.account_id, lines: p.lines, memo: p.memo ?? '' });
    return createDeposit(ctx.tenantId, input, ctx.userId, ctx.companyId);
  },
});

// ─── Bank connections ───────────────────────────────────────────

companyTool('get_bank_connections', {
  title: 'List bank connections',
  description: 'The client\'s Plaid bank connections that you can see.',
  input: {},
  scope: 'banking', resource: 'banking', mode: 'read',
  handler: async (_p, ctx) => {
    const { getItemsForUser } = await import('../services/plaid-connection.service.js');
    return getItemsForUser(ctx.userId, ctx.tenantId);
  },
});

companyTool('sync_bank_connection', {
  title: 'Sync a bank connection',
  description: 'Pulls new transactions from the bank for one of the client\'s connections.',
  input: { connection_id: id('The bank connection (an id from get_bank_connections)') },
  scope: 'banking', resource: 'banking', mode: 'write', openWorld: true,
  handler: async (p, ctx) => {
    // The connection must be one of THIS client's, and one the caller may
    // operate (the HTTP route's gate, /items/:id/sync): an arbitrary id
    // must not let a banking-scoped token sync another client's item.
    const { getItemsForUser, assertCanAccessItem } = await import('../services/plaid-connection.service.js');
    const mine = await getItemsForUser(ctx.userId, ctx.tenantId);
    if (!mine.some((item) => item.id === p.connection_id)) throw new McpToolError('NOT_FOUND', 'Connection not found');
    await assertCanAccessItem(ctx.userId, p.connection_id);
    const { syncItem } = await import('../services/plaid-sync.service.js');
    return syncItem(p.connection_id);
  },
});

// ─── Bank feed ──────────────────────────────────────────────────

companyTool('list_bank_feed_items', {
  title: 'List bank feed items',
  description: 'Downloaded bank transactions waiting to be categorized or matched (status pending unless another is given).',
  input: { status: optText('Feed status: pending (default), categorized, matched, excluded') },
  scope: 'banking', resource: 'banking', mode: 'read',
  handler: async (p, ctx) => db.select().from(bankFeedItems)
    .where(and(
      eq(bankFeedItems.tenantId, ctx.tenantId), eq(bankFeedItems.status, p.status || 'pending'),
      // This company's items: stamped with it, or unstamped on a connection that is not a sibling's.
      sql`(${bankFeedItems.companyId} = ${ctx.companyId} OR (${bankFeedItems.companyId} IS NULL AND NOT EXISTS (
        SELECT 1 FROM bank_connections bc WHERE bc.id = ${bankFeedItems.bankConnectionId}
          AND bc.company_id IS NOT NULL AND bc.company_id <> ${ctx.companyId})))`,
    ))
    .orderBy(desc(bankFeedItems.feedDate)).limit(100),
});

companyTool('find_feed_match_candidates', {
  title: 'Find matches for a feed item',
  description: 'Existing transactions that may be the same as a bank feed item.',
  input: { feed_item_id: id('The bank feed item') },
  scope: 'banking', resource: 'banking', mode: 'read',
  handler: async (p, ctx) => {
    await feedItemsInCompany(ctx, [p.feed_item_id]);
    const { findMatchCandidates } = await import('../services/bank-feed.service.js');
    return findMatchCandidates(ctx.tenantId, p.feed_item_id);
  },
});

companyTool('categorize_feed_item', {
  title: 'Categorize a feed item',
  description: 'Posts a bank feed item to an account. An optional tag is stamped on every resulting journal line.',
  input: {
    feed_item_id: id('The bank feed item'),
    account_id: id('The account to post it to'),
    contact_id: optId('The customer or vendor'),
    memo: optText('Memo'),
    tag_id: optId('Tag for the posted lines'),
  },
  scope: 'banking', resource: 'banking', mode: 'write',
  handler: async (p, ctx) => {
    await feedItemsInCompany(ctx, [p.feed_item_id]);
    const { categorize } = await import('../services/bank-feed.service.js');
    return categorize(
      ctx.tenantId,
      p.feed_item_id,
      { accountId: p.account_id, contactId: p.contact_id, memo: p.memo, ...(p.tag_id !== undefined ? { tagId: p.tag_id } : {}) },
      ctx.userId, ctx.companyId, { ownerChoice: true },
    );
  },
});

companyTool('match_feed_item', {
  title: 'Match a feed item',
  description: 'Links a bank feed item to a transaction already in the books instead of posting a new one.',
  input: {
    feed_item_id: id('The bank feed item'),
    transaction_id: id('The existing transaction'),
  },
  scope: 'banking', resource: 'banking', mode: 'write',
  handler: async (p, ctx) => {
    await Promise.all([feedItemsInCompany(ctx, [p.feed_item_id]), transactionInCompany(ctx, p.transaction_id)]);
    const { match } = await import('../services/bank-feed.service.js');
    await match(ctx.tenantId, p.feed_item_id, p.transaction_id);
    return { matched: true };
  },
});

companyTool('exclude_feed_item', {
  title: 'Exclude a feed item',
  description: 'Leaves a bank feed item out of the books (a duplicate or a personal charge).',
  input: { feed_item_id: id('The bank feed item') },
  scope: 'banking', resource: 'banking', mode: 'write',
  handler: async (p, ctx) => {
    await feedItemsInCompany(ctx, [p.feed_item_id]);
    const { exclude } = await import('../services/bank-feed.service.js');
    await exclude(ctx.tenantId, p.feed_item_id, ctx.userId);
    return { excluded: true };
  },
});

companyTool('bulk_approve_feed_items', {
  title: 'Approve feed items in bulk',
  description: 'Posts many bank feed items using their suggested categories.',
  input: { feed_item_ids: idList('Bank feed items to approve', 500) },
  scope: 'banking', resource: 'banking', mode: 'write',
  handler: async (p, ctx) => {
    await feedItemsInCompany(ctx, p.feed_item_ids);
    const { bulkApprove } = await import('../services/bank-feed.service.js');
    return bulkApprove(ctx.tenantId, p.feed_item_ids, ctx.userId, ctx.companyId);
  },
});

companyTool('bulk_set_bank_feed_tag', {
  title: 'Tag feed items in bulk',
  description: 'Sets one tag (or clears it when tag_id is omitted) on every matched journal line of many bank feed items.',
  input: {
    feed_item_ids: idList('Bank feed items', 500),
    tag_id: optId('The tag; omit to clear'),
  },
  scope: 'banking', resource: 'banking', mode: 'write', idempotent: true,
  handler: async (p, ctx) => {
    await feedItemsInCompany(ctx, p.feed_item_ids);
    const { bulkSetTag } = await import('../services/bank-feed.service.js');
    return bulkSetTag(ctx.tenantId, p.feed_item_ids, p.tag_id ?? null);
  },
});

// ─── Reconciliation ─────────────────────────────────────────────
//
// The whole worksheet: start, read its lines, tick them, finish. The same
// service calls as the banking router's /reconciliations routes.

const reconId = id('The reconciliation (the id start_reconciliation or get_reconciliation_status returned)');
const chargeSchema = (what: string) => (fieldOf(startReconciliationSchema, what) as ZodTypeAny).nullable().optional();

companyTool('get_reconciliation_status', {
  title: 'Get an account\'s reconciliation status',
  description: 'The latest reconciliation of a bank account (in progress or complete), or null if it was never reconciled.',
  input: { account_id: id('The bank or credit card account') },
  scope: 'read', resource: 'banking', mode: 'read',
  handler: async (p, ctx) => {
    await accountInCompany(ctx, p.account_id);
    const last = await db.select().from(reconciliations)
      .where(and(eq(reconciliations.tenantId, ctx.tenantId), eq(reconciliations.accountId, p.account_id)))
      .orderBy(desc(reconciliations.statementDate)).limit(1);
    return { lastReconciliation: last[0] || null };
  },
});

companyTool('get_reconciliation_history', {
  title: 'List an account\'s reconciliations',
  description: 'Every reconciliation of a bank account.',
  input: { account_id: id('The bank or credit card account') },
  scope: 'read', resource: 'banking', mode: 'read',
  handler: async (p, ctx) => {
    await accountInCompany(ctx, p.account_id);
    const { getHistory } = await import('../services/reconciliation.service.js');
    return getHistory(ctx.tenantId, p.account_id);
  },
});

companyTool('start_reconciliation', {
  title: 'Start a reconciliation',
  description: 'Opens a reconciliation worksheet for a bank account against a statement. The beginning balance is the last completed '
    + 'reconciliation\'s ending balance. Fails if the account already has one in progress (its id is in the error). '
    + 'Next: get_reconciliation to read the lines, update_reconciliation_lines to tick them, complete_reconciliation when the difference is 0.',
  input: {
    account_id: id('The bank or credit card account'),
    statement_date: date('Statement ending date'),
    statement_ending_balance: money('Ending balance printed on the statement'),
    service_charge: chargeSchema('serviceCharge').describe('A bank service charge on the statement to post: {amount, date, accountId}'),
    interest: chargeSchema('interest').describe('Interest earned on the statement to post: {amount, date, accountId}'),
  },
  scope: 'banking', resource: 'banking', mode: 'write',
  handler: async (p, ctx) => {
    await accountInCompany(ctx, p.account_id);
    const { start } = await import('../services/reconciliation.service.js');
    const input = startReconciliationSchema.parse({
      accountId: p.account_id, statementDate: p.statement_date, statementEndingBalance: p.statement_ending_balance,
      serviceCharge: p.service_charge, interest: p.interest,
    });
    return start(ctx.tenantId, input.accountId, input.statementDate, input.statementEndingBalance, {
      serviceCharge: input.serviceCharge, interest: input.interest, userId: ctx.userId,
    });
  },
});

companyTool('get_reconciliation', {
  title: 'Read a reconciliation worksheet',
  description: 'A reconciliation with its totals (beginning balance, cleared balance, difference) and, unless view is "summary", '
    + 'every worksheet line: journal_line_id, txn_date, debit, credit, check_number, contact_name, memo and is_cleared.',
  input: {
    reconciliation_id: reconId,
    view: z.enum(['full', 'summary']).optional().describe('"summary" leaves the lines out'),
  },
  scope: 'banking', resource: 'banking', mode: 'read',
  handler: async (p, ctx) => {
    await reconciliationInCompany(ctx, p.reconciliation_id);
    const { getReconciliationView } = await import('../services/reconciliation.service.js');
    return getReconciliationView(ctx.tenantId, p.reconciliation_id, p.view);
  },
});

// Worksheet lines read back with journal_line_id / is_cleared (see
// get_reconciliation), so that is the spelling taken here; the REST body's
// journalLineId / isCleared is accepted too.
const worksheetLine = z.preprocess((v) => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return v;
  const o = v as Record<string, unknown>;
  return { journal_line_id: o['journal_line_id'] ?? o['journalLineId'], is_cleared: o['is_cleared'] ?? o['isCleared'] };
}, z.object({
  journal_line_id: z.string().uuid().describe('The line (journal_line_id from get_reconciliation)'),
  is_cleared: z.boolean().describe('true: it is on the statement'),
}));

companyTool('update_reconciliation_lines', {
  title: 'Tick or untick worksheet lines',
  description: 'Marks worksheet lines cleared (they appear on the statement) or not. Returns the new totals; the reconciliation can be '
    + 'completed when difference is 0.',
  input: {
    reconciliation_id: reconId,
    lines: jsonArray(z.array(worksheetLine).min(1).max(10000), 'Lines to change: {journal_line_id, is_cleared}'),
  },
  scope: 'banking', resource: 'banking', mode: 'write', idempotent: true,
  handler: async (p, ctx) => {
    await reconciliationInCompany(ctx, p.reconciliation_id);
    const { applyLineUpdates, getReconciliationSummary } = await import('../services/reconciliation.service.js');
    const updates = (p.lines as Array<{ journal_line_id: string; is_cleared: boolean }>)
      .map((l) => ({ journalLineId: l.journal_line_id, isCleared: l.is_cleared }));
    await applyLineUpdates(ctx.tenantId, p.reconciliation_id, updates);
    return getReconciliationSummary(ctx.tenantId, p.reconciliation_id);
  },
});

companyTool('update_reconciliation', {
  title: 'Change a reconciliation\'s statement details',
  description: 'Corrects the statement date, ending balance, service charge or interest of a reconciliation in progress.',
  input: {
    reconciliation_id: reconId,
    statement_date: optDate('Statement ending date'),
    statement_ending_balance: money('Ending balance printed on the statement').optional(),
    service_charge: chargeSchema('serviceCharge').describe('Bank service charge {amount, date, accountId}; null removes it'),
    interest: chargeSchema('interest').describe('Interest earned {amount, date, accountId}; null removes it'),
  },
  scope: 'banking', resource: 'banking', mode: 'write', idempotent: true,
  handler: async (p, ctx) => {
    await reconciliationInCompany(ctx, p.reconciliation_id);
    const { applyHeaderUpdate, getReconciliationSummary } = await import('../services/reconciliation.service.js');
    const input = updateReconciliationSchema.parse({
      statementDate: p.statement_date, statementEndingBalance: p.statement_ending_balance,
      serviceCharge: p.service_charge, interest: p.interest,
    });
    await applyHeaderUpdate(ctx.tenantId, p.reconciliation_id, input, ctx.userId);
    return getReconciliationSummary(ctx.tenantId, p.reconciliation_id);
  },
});

companyTool('refresh_reconciliation', {
  title: 'Refresh a reconciliation worksheet',
  description: 'Adds transactions entered since the reconciliation was started and drops ones voided since.',
  input: { reconciliation_id: reconId },
  scope: 'banking', resource: 'banking', mode: 'write', idempotent: true,
  handler: async (p, ctx) => {
    await reconciliationInCompany(ctx, p.reconciliation_id);
    const { refreshLines } = await import('../services/reconciliation.service.js');
    return refreshLines(ctx.tenantId, p.reconciliation_id, {});
  },
});

companyTool('auto_clear_reconciliation', {
  title: 'Clear lines that match the statement',
  description: 'For a reconciliation linked to an imported bank statement: ticks every worksheet line the statement shows.',
  input: { reconciliation_id: reconId },
  scope: 'banking', resource: 'banking', mode: 'write', idempotent: true,
  handler: async (p, ctx) => {
    await reconciliationInCompany(ctx, p.reconciliation_id);
    const { autoClearStatement } = await import('../services/reconciliation.service.js');
    return autoClearStatement(ctx.tenantId, p.reconciliation_id, ctx.userId);
  },
});

companyTool('complete_reconciliation', {
  title: 'Finish a reconciliation',
  description: 'Completes a reconciliation. Only possible when the difference is exactly 0; otherwise the error gives the remaining '
    + 'difference. Confirm with the user first.',
  input: { reconciliation_id: reconId },
  scope: 'banking', resource: 'banking', mode: 'write',
  handler: async (p, ctx) => {
    await reconciliationInCompany(ctx, p.reconciliation_id);
    const { complete, getReconciliationSummary } = await import('../services/reconciliation.service.js');
    await complete(ctx.tenantId, p.reconciliation_id, ctx.userId);
    return { message: 'Reconciliation complete', reconciliation: await getReconciliationSummary(ctx.tenantId, p.reconciliation_id) };
  },
});

companyTool('cancel_reconciliation', {
  title: 'Discard a reconciliation in progress',
  description: 'Deletes an in-progress worksheet so the account can start again. Nothing posted is removed. Confirm with the user first.',
  input: { reconciliation_id: reconId },
  scope: 'banking', resource: 'banking', mode: 'write', destructive: true,
  handler: async (p, ctx) => {
    await reconciliationInCompany(ctx, p.reconciliation_id);
    const { cancel } = await import('../services/reconciliation.service.js');
    await cancel(ctx.tenantId, p.reconciliation_id, ctx.userId);
    return { message: 'Reconciliation canceled' };
  },
});

companyTool('undo_reconciliation', {
  title: 'Undo a completed reconciliation',
  description: 'Reopens the latest completed reconciliation of an account. Owners only. Confirm with the user first.',
  input: {
    reconciliation_id: reconId,
    mode: z.enum(['clear_checks', 'keep_checks', 'discard']).optional()
      .describe('clear_checks (default): reopen with every line unticked; keep_checks: reopen with ticks kept; discard: remove it'),
  },
  scope: 'banking', resource: 'banking', mode: 'write', destructive: true,
  handler: async (p, ctx) => {
    await reconciliationInCompany(ctx, p.reconciliation_id);
    // A company-admin act, as on the REST route (U-190).
    if (!ctx.isSuperAdmin && ctx.role !== 'owner') {
      throw new McpToolError('RECONCILE_ADMIN_REQUIRED', 'Only a company administrator can undo a reconciliation');
    }
    const { undo } = await import('../services/reconciliation.service.js');
    const result = await undo(ctx.tenantId, p.reconciliation_id, ctx.userId, { mode: p.mode });
    return { message: 'Reconciliation undone', mode: result.mode };
  },
});

// ─── Reports ────────────────────────────────────────────────────
//
// ADR 0XX §5 — reports that support the split-level tag filter take an
// optional tag_id. Semantics match the HTTP surface: line-level for P&L /
// GL / expense-by-*, transaction-level EXISTS for TB / BS / aging /
// customer and vendor balance.

companyTool('run_profit_loss', {
  title: 'Profit and loss',
  description: 'Profit and loss for a period. tag_id limits it to lines carrying that tag.',
  input: { start_date: date('First day'), end_date: date('Last day'), basis, tag_id: tagFilter },
  scope: 'reports', resource: FIN_REPORT, mode: 'read',
  handler: async (p, ctx) => {
    const { buildProfitAndLoss } = await import('../services/report.service.js');
    return buildProfitAndLoss(ctx.tenantId, p.start_date, p.end_date, p.basis ?? 'accrual', ctx.companyId, p.tag_id ?? null);
  },
});

companyTool('run_balance_sheet', {
  title: 'Balance sheet',
  description: 'Balance sheet as of a date (accrual). tag_id limits it to transactions touching that tag.',
  input: { as_of_date: date('As-of date'), tag_id: tagFilter },
  scope: 'reports', resource: FIN_REPORT, mode: 'read',
  handler: async (p, ctx) => {
    const { buildBalanceSheet } = await import('../services/report.service.js');
    return buildBalanceSheet(ctx.tenantId, p.as_of_date, 'accrual', ctx.companyId, p.tag_id ?? null);
  },
});

companyTool('run_balance_sheet_basis', {
  title: 'Balance sheet (cash or accrual)',
  description: 'Balance sheet as of a date on the chosen basis.',
  input: { as_of_date: date('As-of date'), basis },
  scope: 'reports', resource: FIN_REPORT, mode: 'read',
  handler: async (p, ctx) => {
    const { buildBalanceSheet } = await import('../services/report.service.js');
    return buildBalanceSheet(ctx.tenantId, p.as_of_date, p.basis ?? 'accrual', ctx.companyId);
  },
});

companyTool('run_trial_balance', {
  title: 'Trial balance',
  description: 'Trial balance for a period. tag_id keeps whole transactions that touch the tag, so debits still equal credits.',
  input: { start_date: date('First day'), end_date: date('Last day'), tag_id: tagFilter },
  scope: 'reports', resource: FIN_REPORT, mode: 'read',
  handler: async (p, ctx) => {
    const { buildTrialBalance } = await import('../services/report.service.js');
    return buildTrialBalance(ctx.tenantId, p.start_date, p.end_date, ctx.companyId, p.tag_id ?? null);
  },
});

companyTool('run_general_ledger', {
  title: 'General ledger',
  description: 'Every posting in a period, by account. tag_id limits it to lines carrying that tag.',
  input: { start_date: date('First day'), end_date: date('Last day'), tag_id: tagFilter },
  scope: 'reports', resource: FIN_REPORT, mode: 'read',
  handler: async (p, ctx) => {
    const { buildGeneralLedger } = await import('../services/report.service.js');
    return buildGeneralLedger(ctx.tenantId, p.start_date, p.end_date, ctx.companyId, p.tag_id ?? null);
  },
});

companyTool('run_cash_flow', {
  title: 'Cash flow statement',
  description: 'Statement of cash flows for a period.',
  input: { start_date: date('First day'), end_date: date('Last day'), tag_id: tagFilter },
  scope: 'reports', resource: FIN_REPORT, mode: 'read',
  handler: async (p, ctx) => {
    const { buildCashFlowStatement } = await import('../services/report.service.js');
    return buildCashFlowStatement(ctx.tenantId, p.start_date, p.end_date, ctx.companyId, p.tag_id ?? null);
  },
});

companyTool('run_expense_by_category', {
  title: 'Expenses by category',
  description: 'Expenses in a period, by account.',
  input: { start_date: date('First day'), end_date: date('Last day'), tag_id: tagFilter },
  scope: 'reports', resource: FIN_REPORT, mode: 'read',
  handler: async (p, ctx) => {
    const { buildExpenseByCategory } = await import('../services/report.service.js');
    return buildExpenseByCategory(ctx.tenantId, p.start_date, p.end_date, ctx.companyId, p.tag_id ?? null);
  },
});

companyTool('run_expense_by_vendor', {
  title: 'Expenses by vendor',
  description: 'Expenses in a period, by vendor.',
  input: { start_date: date('First day'), end_date: date('Last day'), tag_id: tagFilter },
  scope: 'reports', resource: AP_REPORT, mode: 'read',
  handler: async (p, ctx) => {
    const { buildExpenseByVendor } = await import('../services/report.service.js');
    return buildExpenseByVendor(ctx.tenantId, p.start_date, p.end_date, ctx.companyId, p.tag_id ?? null);
  },
});

companyTool('run_ar_aging', {
  title: 'A/R aging',
  description: 'What customers owe, by how long it has been due.',
  input: { as_of_date: date('As-of date'), tag_id: tagFilter },
  scope: 'reports', resource: AR_REPORT, mode: 'read',
  handler: async (p, ctx) => {
    const { buildARAgingSummary } = await import('../services/report.service.js');
    return buildARAgingSummary(ctx.tenantId, p.as_of_date, ctx.companyId, p.tag_id ?? null);
  },
});

companyTool('run_customer_balance', {
  title: 'Customer balances',
  description: 'Outstanding receivables by customer.',
  input: { tag_id: tagFilter },
  scope: 'reports', resource: AR_REPORT, mode: 'read',
  handler: async (p, ctx) => {
    const { buildCustomerBalanceSummary } = await import('../services/report.service.js');
    return buildCustomerBalanceSummary(ctx.tenantId, ctx.companyId, p.tag_id ?? null);
  },
});

companyTool('run_vendor_balance', {
  title: 'Vendor balances',
  description: 'Outstanding payables by vendor.',
  input: {},
  scope: 'reports', resource: AP_REPORT, mode: 'read',
  handler: async (_p, ctx) => {
    const { buildVendorBalanceSummary } = await import('../services/report.service.js');
    return buildVendorBalanceSummary(ctx.tenantId, ctx.companyId);
  },
});

companyTool('run_1099_vendor_summary', {
  title: '1099 vendor summary',
  description: 'Totals paid to 1099-reportable vendors in a year.',
  input: { year: z.preprocess((v) => (typeof v === 'number' ? String(v) : v), z.string().regex(/^\d{4}$/, 'Use a 4-digit year')).describe('Tax year, e.g. "2026"') },
  scope: 'reports', resource: AP_REPORT, mode: 'read',
  handler: async (p, ctx) => {
    const { build1099VendorSummary } = await import('../services/report.service.js');
    return build1099VendorSummary(ctx.tenantId, p.year, ctx.companyId);
  },
});

companyTool('run_sales_tax_liability', {
  title: 'Sales tax liability',
  description: 'Sales tax collected and owed for a period.',
  input: { start_date: date('First day'), end_date: date('Last day') },
  scope: 'reports', resource: ['reports', 'sales_tax'], mode: 'read',
  handler: async (p, ctx) => {
    const { buildSalesTaxLiability } = await import('../services/report.service.js');
    return buildSalesTaxLiability(ctx.tenantId, p.start_date, p.end_date, ctx.companyId);
  },
});

companyTool('run_check_register', {
  title: 'Check register',
  description: 'The register of a bank account, optionally for a date range.',
  input: {
    account_id: id('The bank account'),
    start_date: optDate('First day'), end_date: optDate('Last day'), tag_id: tagFilter,
  },
  scope: 'reports', resource: ['reports', 'banking'], mode: 'read',
  handler: async (p, ctx) => {
    await accountInCompany(ctx, p.account_id);
    const { buildCheckRegister } = await import('../services/report.service.js');
    return buildCheckRegister(
      ctx.tenantId,
      p.account_id,
      p.start_date && p.end_date ? { startDate: p.start_date, endDate: p.end_date } : undefined,
      ctx.companyId,
      p.tag_id ?? null,
    );
  },
});

// ─── Company ────────────────────────────────────────────────────

companyTool('get_company_info', {
  title: 'Get company details',
  description: 'The client company\'s profile: names, address, fiscal year, settings.',
  input: {},
  scope: 'read', resource: [], mode: 'read',
  handler: async (_p, ctx) => {
    const company = await db.query.companies.findFirst({ where: eq(companies.id, ctx.companyId) });
    if (!company) throw new McpToolError('NOT_FOUND', 'Company not found');
    // Any role can call this, so it returns the profile and nothing that
    // is a credential: no closing-date password hash (U-15), no payment
    // processor keys or webhook secrets, no tax id, and not the intake
    // folder paths (U-93), which are owner data from one computer.
    const SECRET = /secret|password|token|encrypted|hash|apikey|api_key|privatekey/i;
    const info: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(company)) {
      if (SECRET.test(key) || key === 'ein' || key === 'intakeSettings') continue;
      info[key] = value;
    }
    return info;
  },
});

// ─── Bills / accounts payable ───────────────────────────────────

companyTool('list_bills', {
  title: 'List bills',
  description: 'Vendor bills, with optional filters.',
  input: {
    status: optText('Bill status (unpaid, partial, paid, void)'),
    contact_id: optId('Only this vendor'),
    start_date: optDate('Billed on or after'),
    end_date: optDate('Billed on or before'),
    overdue_only: optBool('Only bills past due'),
    limit: optInt('How many to return (default 50)', 1000),
  },
  scope: 'read', resource: 'bills', mode: 'read',
  handler: async (p, ctx) => {
    const { billFiltersSchema } = await import('@kis-books/shared');
    const { listBills } = await import('../services/bill.service.js');
    const filters = billFiltersSchema.parse({
      billStatus: p.status, contactId: p.contact_id, startDate: p.start_date, endDate: p.end_date,
      overdueOnly: p.overdue_only, limit: p.limit ?? 50, offset: 0,
    });
    return listBills(ctx.tenantId, filters, ctx.companyId);
  },
});

companyTool('get_bill', {
  title: 'Get a bill',
  description: 'One bill with its journal lines.',
  input: { bill_id: id('The bill') },
  scope: 'read', resource: 'bills', mode: 'read',
  handler: async (p, ctx) => {
    const { getBill } = await import('../services/bill.service.js');
    return getBill(ctx.tenantId, p.bill_id, ctx.companyId);
  },
});

companyTool('create_bill', {
  title: 'Enter a bill',
  description: 'Records a bill received from a vendor.',
  input: {
    vendor_id: id('The vendor (a contact)'),
    date: date('Bill date'),
    due_date: optDate('Due date'),
    payment_terms: optText('Payment terms code (for example net_30)'),
    vendor_invoice_number: optText('The vendor\'s invoice number'),
    lines: lines(createBillSchema, 'Bill lines: {accountId, amount, description?, tagId?}'),
    memo: optText('Memo'),
  },
  scope: 'write', resource: 'bills', mode: 'write',
  handler: async (p, ctx) => {
    const { createBill } = await import('../services/bill.service.js');
    const input = createBillSchema.parse({
      contactId: p.vendor_id, txnDate: p.date, dueDate: p.due_date,
      paymentTerms: p.payment_terms, vendorInvoiceNumber: p.vendor_invoice_number,
      memo: p.memo, lines: p.lines,
    });
    return createBill(ctx.tenantId, input, ctx.userId, ctx.companyId);
  },
});

companyTool('void_bill', {
  title: 'Void a bill',
  description: 'Voids a bill with a reversing entry. Confirm with the user first.',
  input: { bill_id: id('The bill'), reason: text('Why it is being voided').min(1) },
  scope: 'write', resource: 'bills', mode: 'write', destructive: true,
  handler: async (p, ctx) => {
    const { voidBill } = await import('../services/bill.service.js');
    await voidBill(ctx.tenantId, p.bill_id, p.reason, ctx.userId, { companyId: ctx.companyId });
    return { voided: true };
  },
});

companyTool('get_payable_bills', {
  title: 'List bills to pay',
  description: 'Unpaid bills with a balance due.',
  input: {
    contact_id: optId('Only this vendor'),
    due_on_or_before: optDate('Only bills due by this date'),
  },
  scope: 'read', resource: 'bills', mode: 'read',
  handler: async (p, ctx) => {
    const { getPayableBills } = await import('../services/bill.service.js');
    return getPayableBills(ctx.tenantId, { contactId: p.contact_id, dueOnOrBefore: p.due_on_or_before, companyId: ctx.companyId, companyIncludesNull: true });
  },
});

companyTool('list_bill_payments', {
  title: 'List bill payments',
  description: 'Payments made on bills.',
  input: {
    contact_id: optId('Only this vendor'),
    start_date: optDate('Paid on or after'),
    end_date: optDate('Paid on or before'),
    limit: optInt('How many to return (default 50)', 1000),
  },
  scope: 'read', resource: 'pay_bills', mode: 'read',
  handler: async (p, ctx) => {
    const { listBillPayments } = await import('../services/bill-payment.service.js');
    return listBillPayments(ctx.tenantId, {
      contactId: p.contact_id, startDate: p.start_date, endDate: p.end_date, limit: p.limit ?? 50, offset: 0, companyId: ctx.companyId,
    });
  },
});

companyTool('pay_bills', {
  title: 'Pay bills',
  description: 'Pays one or more bills from a bank account (see get_payable_bills).',
  input: {
    bank_account_id: id('The bank account to pay from'),
    date: date('Payment date'),
    method: text('How it is paid: check, ach, credit_card, cash, other'),
    bills: lines(payBillsSchema, 'Bills to pay: {billId, amount}', 'bills'),
    credits: lines(payBillsSchema, 'Vendor credits to apply: {creditId, billId, amount}', 'credits').optional(),
    print_later: optBool('Queue a check for printing'),
    memo: optText('Memo'),
  },
  scope: 'write', resource: 'pay_bills', mode: 'write',
  handler: async (p, ctx) => {
    const { payBills } = await import('../services/bill-payment.service.js');
    const input = payBillsSchema.parse({
      bankAccountId: p.bank_account_id, txnDate: p.date, method: p.method,
      printLater: p.print_later, memo: p.memo, bills: p.bills, credits: p.credits,
    });
    return payBills(ctx.tenantId, input, ctx.userId, ctx.companyId);
  },
});

companyTool('void_bill_payment', {
  title: 'Void a bill payment',
  description: 'Voids a bill payment; the bills it paid become open again. Confirm with the user first.',
  input: { payment_id: id('The bill payment'), reason: text('Why it is being voided').min(1) },
  scope: 'write', resource: 'pay_bills', mode: 'write', destructive: true,
  handler: async (p, ctx) => {
    const { voidBillPayment } = await import('../services/bill-payment.service.js');
    await voidBillPayment(ctx.tenantId, p.payment_id, p.reason, ctx.userId, { companyId: ctx.companyId });
    return { voided: true };
  },
});

// ─── Vendor credits ─────────────────────────────────────────────

companyTool('list_vendor_credits', {
  title: 'List vendor credits',
  description: 'Credits received from vendors.',
  input: {
    contact_id: optId('Only this vendor'),
    start_date: optDate('Dated on or after'),
    end_date: optDate('Dated on or before'),
    search: optText('Text to look for'),
    limit: optInt('How many to return (default 50)', 1000),
  },
  scope: 'read', resource: 'vendor_credits', mode: 'read',
  handler: async (p, ctx) => {
    const { listVendorCredits } = await import('../services/vendor-credit.service.js');
    return listVendorCredits(ctx.tenantId, {
      contactId: p.contact_id, startDate: p.start_date, endDate: p.end_date, search: p.search,
      limit: p.limit ?? 50, offset: 0,
    }, ctx.companyId);
  },
});

companyTool('create_vendor_credit', {
  title: 'Enter a vendor credit',
  description: 'Records a credit received from a vendor.',
  input: {
    vendor_id: id('The vendor (a contact)'),
    date: date('Credit date'),
    vendor_invoice_number: optText('The vendor\'s credit memo number'),
    lines: lines(createVendorCreditSchema, 'Credit lines: {accountId, amount, description?}'),
    memo: optText('Memo'),
  },
  scope: 'write', resource: 'vendor_credits', mode: 'write',
  handler: async (p, ctx) => {
    const { createVendorCredit } = await import('../services/vendor-credit.service.js');
    const input = createVendorCreditSchema.parse({
      contactId: p.vendor_id, txnDate: p.date, vendorInvoiceNumber: p.vendor_invoice_number,
      memo: p.memo, lines: p.lines,
    });
    return createVendorCredit(ctx.tenantId, input, ctx.userId, ctx.companyId);
  },
});

companyTool('get_available_vendor_credits', {
  title: 'List a vendor\'s unused credits',
  description: 'Credits of one vendor that still have a balance to apply.',
  input: { vendor_id: id('The vendor (a contact)') },
  scope: 'read', resource: 'vendor_credits', mode: 'read',
  handler: async (p, ctx) => {
    const { getAvailableCredits } = await import('../services/vendor-credit.service.js');
    return getAvailableCredits(ctx.tenantId, p.vendor_id, ctx.companyId);
  },
});

// ─── Checks ─────────────────────────────────────────────────────

companyTool('list_checks', {
  title: 'List checks',
  description: 'Checks written.',
  input: {
    bank_account_id: optId('Only this bank account'),
    print_status: optText('Print status (queue, printed, hand_written)'),
    start_date: optDate('Dated on or after'),
    end_date: optDate('Dated on or before'),
    limit: optInt('How many to return (default 50)', 1000),
  },
  scope: 'read', resource: 'checks', mode: 'read',
  handler: async (p, ctx) => {
    const { listChecks } = await import('../services/check.service.js');
    return listChecks(ctx.tenantId, {
      bankAccountId: p.bank_account_id, printStatus: p.print_status,
      startDate: p.start_date, endDate: p.end_date, limit: p.limit ?? 50, offset: 0,
    }, ctx.companyId);
  },
});

companyTool('write_check', {
  title: 'Write a check',
  description: 'Records a check to a payee, split across one or more accounts.',
  input: {
    bank_account_id: id('The bank account the check is drawn on'),
    date: date('Check date'),
    payee_name: text('Payee name as printed on the check').min(1).max(255),
    amount: money('Check amount'),
    lines: lines(writeCheckSchema, 'Check lines: {accountId, amount, description?, tagId?}'),
    contact_id: optId('The vendor (a contact)'),
    payee_address: optText('Payee address'),
    memo: optText('Memo (internal)'),
    printed_memo: optText('Memo printed on the check'),
    print_later: optBool('Queue the check for printing'),
  },
  scope: 'write', resource: 'checks', mode: 'write',
  handler: async (p, ctx) => {
    const { createCheck } = await import('../services/check.service.js');
    const input = writeCheckSchema.parse({
      bankAccountId: p.bank_account_id, txnDate: p.date,
      payeeNameOnCheck: p.payee_name, amount: p.amount,
      contactId: p.contact_id, payeeAddress: p.payee_address,
      memo: p.memo, printedMemo: p.printed_memo,
      printLater: p.print_later ?? false, lines: p.lines,
    });
    return createCheck(ctx.tenantId, input, ctx.userId, ctx.companyId);
  },
});

companyTool('get_check_print_queue', {
  title: 'List checks waiting to print',
  description: 'Checks queued for printing.',
  input: { bank_account_id: optId('Only this bank account') },
  scope: 'read', resource: 'checks', mode: 'read',
  handler: async (p, ctx) => {
    const { getPrintQueue } = await import('../services/check.service.js');
    return getPrintQueue(ctx.tenantId, p.bank_account_id, ctx.companyId);
  },
});

// ─── Recurring transactions ─────────────────────────────────────

companyTool('list_recurring', {
  title: 'List recurring transactions',
  description: 'Recurring schedules.',
  input: {},
  scope: 'read', resource: 'recurring', mode: 'read',
  handler: async (_p, ctx) => {
    const { list } = await import('../services/recurring.service.js');
    return list(ctx.tenantId);
  },
});

companyTool('post_recurring_now', {
  title: 'Post a recurring transaction now',
  description: 'Posts the next occurrence of a recurring schedule at once.',
  input: { schedule_id: id('The recurring schedule') },
  scope: 'write', resource: 'recurring', mode: 'write',
  handler: async (p, ctx) => {
    const { postNext } = await import('../services/recurring.service.js');
    return postNext(ctx.tenantId, p.schedule_id);
  },
});

// ─── Budgets ────────────────────────────────────────────────────

companyTool('list_budgets', {
  title: 'List budgets',
  description: 'Budgets.',
  input: {},
  scope: 'read', resource: 'budgets', mode: 'read',
  handler: async (_p, ctx) => {
    const { list } = await import('../services/budget.service.js');
    return list(ctx.tenantId, { companyId: ctx.companyId });
  },
});

companyTool('get_budget', {
  title: 'Get a budget',
  description: 'One budget with its lines.',
  input: { budget_id: id('The budget') },
  scope: 'read', resource: 'budgets', mode: 'read',
  handler: async (p, ctx) => {
    const { getById, getLines } = await import('../services/budget.service.js');
    const budget = await getById(ctx.tenantId, p.budget_id, ctx.companyId);
    const budgetLines = await getLines(ctx.tenantId, p.budget_id, ctx.companyId);
    return { budget, lines: budgetLines };
  },
});

companyTool('run_budget_vs_actual', {
  title: 'Budget vs. actual',
  description: 'Budget against actuals for a period. For a tag-scoped budget (with TAG_BUDGETS_V1 on) returns the tag-scoped matrix: '
    + 'accounts by 12 months, actuals limited to the budget\'s tag. Otherwise the company-wide totals for the period.',
  input: { budget_id: id('The budget'), start_date: date('First day'), end_date: date('Last day') },
  scope: 'reports', resource: FIN_REPORT, mode: 'read',
  handler: async (p, ctx) => {
    const { buildBudgetVsActual, runTagScopedBudgetVsActuals, getById } = await import('../services/budget.service.js');
    const budget = await getById(ctx.tenantId, p.budget_id, ctx.companyId);
    const tagId = (budget as { tagId?: string | null }).tagId ?? null;
    // Tag-scoped path is the ADR 0XW semantic and only applies when the
    // budget itself is tag-scoped AND the feature flag is on. Otherwise the
    // period aggregate, so clients of tenants with TAG_BUDGETS_V1 off do
    // not regress.
    if (tagId && env.TAG_BUDGETS_V1) return runTagScopedBudgetVsActuals(ctx.tenantId, p.budget_id, ctx.companyId);
    return buildBudgetVsActual(ctx.tenantId, p.budget_id, p.start_date, p.end_date, ctx.companyId);
  },
});

// ─── Dashboard ──────────────────────────────────────────────────

companyTool('get_dashboard_snapshot', {
  title: 'Financial snapshot',
  description: 'Headline figures: income, expenses, cash, receivables, payables.',
  input: {},
  scope: 'read', resource: 'dashboard', mode: 'read',
  handler: async (_p, ctx) => {
    const { getFinancialSnapshot } = await import('../services/dashboard.service.js');
    return getFinancialSnapshot(ctx.tenantId);
  },
});

companyTool('get_cash_position', {
  title: 'Cash position',
  description: 'Balances of every bank account.',
  input: {},
  scope: 'read', resource: 'dashboard', mode: 'read',
  handler: async (_p, ctx) => {
    const { getCashPosition } = await import('../services/dashboard.service.js');
    return getCashPosition(ctx.tenantId);
  },
});

companyTool('get_receivables_summary', {
  title: 'Receivables summary',
  description: 'What customers owe, in aging buckets.',
  input: {},
  scope: 'read', resource: 'dashboard', mode: 'read',
  handler: async (_p, ctx) => {
    const { getReceivablesSummary } = await import('../services/dashboard.service.js');
    return getReceivablesSummary(ctx.tenantId);
  },
});

companyTool('get_payables_summary', {
  title: 'Payables summary',
  description: 'What is owed to vendors, in aging buckets.',
  input: {},
  scope: 'read', resource: 'dashboard', mode: 'read',
  handler: async (_p, ctx) => {
    const { getPayablesSummary } = await import('../services/dashboard.service.js');
    return getPayablesSummary(ctx.tenantId);
  },
});

companyTool('get_action_items', {
  title: 'Things needing attention',
  description: 'Overdue invoices, bills coming due and bank feed items waiting.',
  input: {},
  scope: 'read', resource: 'dashboard', mode: 'read',
  handler: async (_p, ctx) => {
    const { getActionItems } = await import('../services/dashboard.service.js');
    return getActionItems(ctx.tenantId);
  },
});

companyTool('get_revexp_trend', {
  title: 'Revenue and expense trend',
  description: 'Monthly revenue and expenses for the last months.',
  input: { months: optInt('How many months (default 6)', 60) },
  scope: 'read', resource: 'dashboard', mode: 'read',
  handler: async (p, ctx) => {
    const { getRevExpTrend } = await import('../services/dashboard.service.js');
    return getRevExpTrend(ctx.tenantId, p.months ?? 6);
  },
});

// ─── Attachments ────────────────────────────────────────────────

companyTool('list_attachments', {
  title: 'List attachments',
  description: 'File attachment details (no file contents), optionally for one record.',
  input: {
    attachable_type: optText('Kind of record the files are attached to (transaction, contact, ...)'),
    attachable_id: optId('The record'),
    limit: optInt('How many to return (default 50)', 1000),
  },
  scope: 'read', resource: 'attachments', mode: 'read',
  handler: async (p, ctx) => {
    const { list } = await import('../services/attachment.service.js');
    // U-90 review M1: only the files this company may see (companyScope).
    return list(ctx.tenantId, {
      attachableType: p.attachable_type, attachableId: p.attachable_id, limit: p.limit ?? 50, offset: 0,
      companyId: ctx.companyId,
    });
  },
});
