import { eq, and, sql, count, inArray } from 'drizzle-orm';
import type { CreateBillInput, BillFilters } from '@kis-books/shared';
import { db, type DbOrTx } from '../db/index.js';
import { transactions, accounts, contacts } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import * as ledger from './ledger.service.js';

const TERM_DAYS: Record<string, number> = {
  due_on_receipt: 0,
  net_10: 10,
  net_15: 15,
  net_30: 30,
  net_45: 45,
  net_60: 60,
  net_90: 90,
};

/**
 * Compute due date from a bill date + payment terms.
 * Custom terms use input.termsDays directly.
 */
export function computeBillDueDate(txnDate: string, terms: string | undefined, customDays: number | undefined): string | undefined {
  if (!terms) return undefined;
  let days: number | undefined;
  if (terms === 'custom') {
    days = customDays;
  } else if (terms in TERM_DAYS) {
    days = TERM_DAYS[terms];
  }
  if (days === undefined) return undefined;
  const date = new Date(txnDate);
  date.setDate(date.getDate() + days);
  return date.toISOString().split('T')[0];
}

async function getApAccountId(tenantId: string): Promise<string> {
  const account = await db.query.accounts.findFirst({
    where: and(eq(accounts.tenantId, tenantId), eq(accounts.systemTag, 'accounts_payable')),
  });
  if (!account) throw AppError.internal("System account 'accounts_payable' not found. Seed COA first.");
  return account.id;
}

async function getNextBillNumber(tenantId: string): Promise<string> {
  // Atomically pick the next bill number based on the current count of bills.
  // We don't have a dedicated counter on companies, so use a count-based
  // sequence prefixed BILL-. Concurrent inserts may briefly collide on the
  // numeric portion, but txnNumber is purely informational (not unique), so
  // this is acceptable for an MVP.
  const [row] = await db.select({ c: count() }).from(transactions)
    .where(and(eq(transactions.tenantId, tenantId), eq(transactions.txnType, 'bill')));
  const next = (row?.c ?? 0) + 1;
  return `BILL-${String(next).padStart(5, '0')}`;
}

async function loadVendorDefaults(tenantId: string, contactId: string) {
  const vendor = await db.query.contacts.findFirst({
    where: and(eq(contacts.tenantId, tenantId), eq(contacts.id, contactId)),
  });
  if (!vendor) throw AppError.badRequest('Vendor not found');
  return vendor;
}

export async function createBill(tenantId: string, input: CreateBillInput, userId?: string) {
  if (input.lines.length === 0) throw AppError.badRequest('Bill must have at least one line');

  const apAccountId = await getApAccountId(tenantId);
  const vendor = await loadVendorDefaults(tenantId, input.contactId);

  // Resolve terms: explicit > vendor default
  const paymentTerms = input.paymentTerms || vendor.defaultPaymentTerms || undefined;
  const termsDays = input.termsDays ?? vendor.defaultTermsDays ?? undefined;
  const dueDate = input.dueDate || computeBillDueDate(input.txnDate, paymentTerms, termsDays);

  const total = input.lines.reduce((sum, l) => sum + parseFloat(l.amount || '0'), 0);
  if (total <= 0) throw AppError.badRequest('Bill total must be positive');

  const journalLines = [
    ...input.lines.map((l) => ({
      accountId: l.accountId,
      debit: parseFloat(l.amount).toFixed(4),
      credit: '0',
      description: l.description || input.memo,
    })),
    { accountId: apAccountId, debit: '0', credit: total.toFixed(4) },
  ];

  const txnNumber = await getNextBillNumber(tenantId);

  return ledger.postTransaction(tenantId, {
    txnType: 'bill',
    txnNumber,
    txnDate: input.txnDate,
    dueDate,
    contactId: input.contactId,
    memo: input.memo,
    internalNotes: input.internalNotes,
    paymentTerms,
    termsDays,
    vendorInvoiceNumber: input.vendorInvoiceNumber,
    total: total.toFixed(4),
    balanceDue: total.toFixed(4),
    amountPaid: '0',
    creditsApplied: '0',
    billStatus: 'unpaid',
    lines: journalLines,
  }, userId);
}

export async function getBill(tenantId: string, billId: string) {
  const bill = await ledger.getTransaction(tenantId, billId);
  if (bill.txnType !== 'bill') throw AppError.badRequest('Not a bill');
  return bill;
}

export async function updateBill(tenantId: string, billId: string, input: CreateBillInput, userId?: string) {
  const existing = await ledger.getTransaction(tenantId, billId);
  if (existing.txnType !== 'bill') throw AppError.badRequest('Not a bill');
  if (existing.status === 'void') throw AppError.badRequest('Cannot edit a void bill');
  if (existing.billStatus && existing.billStatus !== 'unpaid') {
    throw AppError.badRequest('Cannot edit a bill that has payments or credits applied. Void payments first.');
  }

  const apAccountId = await getApAccountId(tenantId);
  const vendor = await loadVendorDefaults(tenantId, input.contactId);

  const paymentTerms = input.paymentTerms || vendor.defaultPaymentTerms || undefined;
  const termsDays = input.termsDays ?? vendor.defaultTermsDays ?? undefined;
  const dueDate = input.dueDate || computeBillDueDate(input.txnDate, paymentTerms, termsDays);

  const total = input.lines.reduce((sum, l) => sum + parseFloat(l.amount || '0'), 0);
  if (total <= 0) throw AppError.badRequest('Bill total must be positive');

  const journalLines = [
    ...input.lines.map((l) => ({
      accountId: l.accountId,
      debit: parseFloat(l.amount).toFixed(4),
      credit: '0',
      description: l.description || input.memo,
    })),
    { accountId: apAccountId, debit: '0', credit: total.toFixed(4) },
  ];

  // We need to also update the bill-specific columns that ledger.updateTransaction
  // doesn't currently set. ledger.updateTransaction overwrites total/balanceDue/etc.
  // After the ledger update, set bill-specific fields explicitly.
  const updated = await ledger.updateTransaction(tenantId, billId, {
    txnType: 'bill',
    txnDate: input.txnDate,
    dueDate,
    contactId: input.contactId,
    memo: input.memo,
    internalNotes: input.internalNotes,
    paymentTerms,
    termsDays,
    vendorInvoiceNumber: input.vendorInvoiceNumber,
    total: total.toFixed(4),
    balanceDue: total.toFixed(4),
    lines: journalLines,
  }, userId);

  // ledger.updateTransaction does not currently propagate vendor_invoice_number,
  // payment_terms, terms_days, or bill_status. Set them explicitly here.
  await db.update(transactions).set({
    paymentTerms: paymentTerms || null,
    termsDays: termsDays ?? null,
    vendorInvoiceNumber: input.vendorInvoiceNumber || null,
    billStatus: 'unpaid',
    creditsApplied: '0',
    amountPaid: '0',
    updatedAt: new Date(),
  }).where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, billId)));

  return updated;
}

export async function voidBill(tenantId: string, billId: string, reason: string, userId?: string) {
  const existing = await ledger.getTransaction(tenantId, billId);
  if (existing.txnType !== 'bill') throw AppError.badRequest('Not a bill');
  if (existing.billStatus && existing.billStatus !== 'unpaid') {
    throw AppError.badRequest('Cannot void a bill that has payments applied. Void the payments first.');
  }
  return ledger.voidTransaction(tenantId, billId, reason, userId);
}

export async function listBills(tenantId: string, filters: BillFilters) {
  const conditions = [
    eq(transactions.tenantId, tenantId),
    eq(transactions.txnType, 'bill'),
  ];

  if (filters.contactId) conditions.push(eq(transactions.contactId, filters.contactId));
  if (filters.billStatus) conditions.push(eq(transactions.billStatus, filters.billStatus));
  if (filters.startDate) conditions.push(sql`${transactions.txnDate} >= ${filters.startDate}`);
  if (filters.endDate) conditions.push(sql`${transactions.txnDate} <= ${filters.endDate}`);
  if (filters.dueOnOrBefore) conditions.push(sql`${transactions.dueDate} <= ${filters.dueOnOrBefore}`);
  if (filters.overdueOnly) {
    conditions.push(sql`${transactions.dueDate} < CURRENT_DATE`);
    conditions.push(sql`${transactions.billStatus} IN ('unpaid', 'partial', 'overdue')`);
  }
  if (filters.search) {
    const term = `%${filters.search}%`;
    conditions.push(sql`(${transactions.memo} ILIKE ${term} OR ${transactions.txnNumber} ILIKE ${term} OR ${transactions.vendorInvoiceNumber} ILIKE ${term} OR ${contacts.displayName} ILIKE ${term})`);
  }

  const where = and(...conditions);

  const [data, totalRow] = await Promise.all([
    db.select({
      id: transactions.id,
      txnNumber: transactions.txnNumber,
      txnDate: transactions.txnDate,
      dueDate: transactions.dueDate,
      contactId: transactions.contactId,
      contactName: contacts.displayName,
      vendorInvoiceNumber: transactions.vendorInvoiceNumber,
      paymentTerms: transactions.paymentTerms,
      total: transactions.total,
      amountPaid: transactions.amountPaid,
      creditsApplied: transactions.creditsApplied,
      balanceDue: transactions.balanceDue,
      billStatus: transactions.billStatus,
      memo: transactions.memo,
      status: transactions.status,
      createdAt: transactions.createdAt,
    }).from(transactions)
      .leftJoin(contacts, eq(transactions.contactId, contacts.id))
      .where(where)
      .orderBy(sql`${transactions.dueDate} ASC NULLS LAST`, sql`${transactions.txnDate} DESC`)
      .limit(filters.limit ?? 50)
      .offset(filters.offset ?? 0),
    db.select({ c: count() }).from(transactions)
      .leftJoin(contacts, eq(transactions.contactId, contacts.id))
      .where(where),
  ]);

  // Augment with daysOverdue (derived field, not stored)
  const today = new Date().toISOString().split('T')[0]!;
  const augmented = data.map((row) => ({
    ...row,
    daysOverdue: row.dueDate && row.dueDate < today && row.billStatus !== 'paid'
      ? Math.floor((Date.parse(today) - Date.parse(row.dueDate)) / 86400000)
      : 0,
  }));

  return { data: augmented, total: totalRow[0]?.c ?? 0 };
}

/**
 * Returns all unpaid/partial bills for the tenant (optionally filtered to one
 * vendor), plus the available vendor credits whose vendors appear in the
 * payable bill list. Used by the Pay Bills page.
 */
export async function getPayableBills(tenantId: string, opts: { contactId?: string; dueOnOrBefore?: string }) {
  const billConds = [
    eq(transactions.tenantId, tenantId),
    eq(transactions.txnType, 'bill'),
    eq(transactions.status, 'posted'),
    sql`${transactions.billStatus} IN ('unpaid', 'partial', 'overdue')`,
    sql`COALESCE(${transactions.balanceDue}, 0) > 0`,
  ];
  if (opts.contactId) billConds.push(eq(transactions.contactId, opts.contactId));
  if (opts.dueOnOrBefore) billConds.push(sql`${transactions.dueDate} <= ${opts.dueOnOrBefore}`);

  const bills = await db.select({
    id: transactions.id,
    txnNumber: transactions.txnNumber,
    contactId: transactions.contactId,
    contactName: contacts.displayName,
    txnDate: transactions.txnDate,
    dueDate: transactions.dueDate,
    vendorInvoiceNumber: transactions.vendorInvoiceNumber,
    total: transactions.total,
    amountPaid: transactions.amountPaid,
    creditsApplied: transactions.creditsApplied,
    balanceDue: transactions.balanceDue,
    billStatus: transactions.billStatus,
    paymentTerms: transactions.paymentTerms,
    memo: transactions.memo,
  }).from(transactions)
    .leftJoin(contacts, eq(transactions.contactId, contacts.id))
    .where(and(...billConds))
    .orderBy(sql`${transactions.dueDate} ASC NULLS LAST`);

  const today = new Date().toISOString().split('T')[0]!;
  const billsWithAge = bills.map((b) => ({
    ...b,
    daysOverdue: b.dueDate && b.dueDate < today
      ? Math.floor((Date.parse(today) - Date.parse(b.dueDate)) / 86400000)
      : 0,
  }));

  // Pull vendor credits with available balance for the same vendors
  const vendorIds = [...new Set(bills.map((b) => b.contactId).filter((v): v is string => !!v))];
  let credits: Array<{
    id: string;
    txnNumber: string | null;
    contactId: string | null;
    contactName: string | null;
    txnDate: string;
    total: string | null;
    balanceDue: string | null;
    memo: string | null;
  }> = [];
  if (vendorIds.length > 0) {
    credits = await db.select({
      id: transactions.id,
      txnNumber: transactions.txnNumber,
      contactId: transactions.contactId,
      contactName: contacts.displayName,
      txnDate: transactions.txnDate,
      total: transactions.total,
      balanceDue: transactions.balanceDue,
      memo: transactions.memo,
    }).from(transactions)
      .leftJoin(contacts, eq(transactions.contactId, contacts.id))
      .where(and(
        eq(transactions.tenantId, tenantId),
        eq(transactions.txnType, 'vendor_credit'),
        eq(transactions.status, 'posted'),
        sql`COALESCE(${transactions.balanceDue}, 0) > 0`,
        inArray(transactions.contactId, vendorIds),
      ))
      .orderBy(sql`${transactions.txnDate} ASC`);
  }

  return { bills: billsWithAge, credits };
}

/**
 * Recalculate amount_paid, credits_applied, balance_due, and bill_status from
 * the underlying application tables. Called by the bill payment service when
 * payments or voids change a bill's state.
 */
export async function recomputeBillStatus(executor: DbOrTx, tenantId: string, billId: string) {
  const result = await executor.execute(sql`
    SELECT
      t.total,
      COALESCE((SELECT SUM(amount) FROM bill_payment_applications WHERE bill_id = ${billId} AND tenant_id = ${tenantId}), 0) AS paid,
      COALESCE((SELECT SUM(amount) FROM vendor_credit_applications WHERE bill_id = ${billId} AND tenant_id = ${tenantId}), 0) AS credits
    FROM transactions t
    WHERE t.id = ${billId} AND t.tenant_id = ${tenantId}
  `);
  const row = (result.rows as Array<{ total: string | null; paid: string | number; credits: string | number }>)[0];
  if (!row) return;

  const total = parseFloat(row.total || '0');
  const paid = parseFloat(String(row.paid));
  const credits = parseFloat(String(row.credits));
  const balanceDue = Math.max(0, total - paid - credits);

  let status: 'unpaid' | 'partial' | 'paid' = 'unpaid';
  if (balanceDue <= 0.0001) status = 'paid';
  else if (paid > 0 || credits > 0) status = 'partial';

  await executor.update(transactions).set({
    amountPaid: paid.toFixed(4),
    creditsApplied: credits.toFixed(4),
    balanceDue: balanceDue.toFixed(4),
    billStatus: status,
    paidAt: status === 'paid' ? new Date() : null,
    updatedAt: new Date(),
  }).where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, billId)));
}

/**
 * Recalculate a vendor credit's remaining balance from the application table.
 */
export async function recomputeVendorCreditBalance(executor: DbOrTx, tenantId: string, creditId: string) {
  const result = await executor.execute(sql`
    SELECT
      t.total,
      COALESCE((SELECT SUM(amount) FROM vendor_credit_applications WHERE credit_id = ${creditId} AND tenant_id = ${tenantId}), 0) AS applied
    FROM transactions t
    WHERE t.id = ${creditId} AND t.tenant_id = ${tenantId}
  `);
  const row = (result.rows as Array<{ total: string | null; applied: string | number }>)[0];
  if (!row) return;

  const total = parseFloat(row.total || '0');
  const applied = parseFloat(String(row.applied));
  const balanceDue = Math.max(0, total - applied);

  await executor.update(transactions).set({
    creditsApplied: applied.toFixed(4),
    balanceDue: balanceDue.toFixed(4),
    billStatus: balanceDue <= 0.0001 ? 'paid' : 'unpaid',
    updatedAt: new Date(),
  }).where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, creditId)));
}
