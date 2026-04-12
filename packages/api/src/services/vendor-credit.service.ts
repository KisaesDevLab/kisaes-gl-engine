import { eq, and, sql, count } from 'drizzle-orm';
import type { CreateVendorCreditInput } from '@kis-books/shared';
import { db } from '../db/index.js';
import { transactions, accounts, contacts, vendorCreditApplications } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import * as ledger from './ledger.service.js';

async function getApAccountId(tenantId: string): Promise<string> {
  const account = await db.query.accounts.findFirst({
    where: and(eq(accounts.tenantId, tenantId), eq(accounts.systemTag, 'accounts_payable')),
  });
  if (!account) throw AppError.internal("System account 'accounts_payable' not found. Seed COA first.");
  return account.id;
}

async function getNextVendorCreditNumber(tenantId: string): Promise<string> {
  const [row] = await db.select({ c: count() }).from(transactions)
    .where(and(eq(transactions.tenantId, tenantId), eq(transactions.txnType, 'vendor_credit')));
  const next = (row?.c ?? 0) + 1;
  return `VC-${String(next).padStart(5, '0')}`;
}

export async function createVendorCredit(tenantId: string, input: CreateVendorCreditInput, userId?: string, companyId?: string) {
  if (input.lines.length === 0) throw AppError.badRequest('Vendor credit must have at least one line');

  const apAccountId = await getApAccountId(tenantId);
  const total = input.lines.reduce((s, l) => s + parseFloat(l.amount || '0'), 0);
  if (total <= 0) throw AppError.badRequest('Vendor credit total must be positive');

  // Mirror image of a bill: DR AP, CR Expense (reverses the original expense)
  const journalLines = [
    { accountId: apAccountId, debit: total.toFixed(4), credit: '0' },
    ...input.lines.map((l) => ({
      accountId: l.accountId,
      debit: '0',
      credit: parseFloat(l.amount).toFixed(4),
      description: l.description || input.memo,
    })),
  ];

  const txnNumber = await getNextVendorCreditNumber(tenantId);

  return ledger.postTransaction(tenantId, {
    txnType: 'vendor_credit',
    txnNumber,
    txnDate: input.txnDate,
    contactId: input.contactId,
    memo: input.memo,
    vendorInvoiceNumber: input.vendorInvoiceNumber,
    total: total.toFixed(4),
    balanceDue: total.toFixed(4),
    amountPaid: '0',
    creditsApplied: '0',
    billStatus: 'unpaid',
    lines: journalLines,
  }, userId, companyId);
}

export async function getVendorCredit(tenantId: string, creditId: string) {
  const credit = await ledger.getTransaction(tenantId, creditId);
  if (credit.txnType !== 'vendor_credit') throw AppError.badRequest('Not a vendor credit');
  return credit;
}

export async function voidVendorCredit(tenantId: string, creditId: string, reason: string, userId?: string) {
  const credit = await ledger.getTransaction(tenantId, creditId);
  if (credit.txnType !== 'vendor_credit') throw AppError.badRequest('Not a vendor credit');

  // Block void if any applications exist for this credit
  const [row] = await db.select({ c: count() }).from(vendorCreditApplications)
    .where(and(eq(vendorCreditApplications.tenantId, tenantId), eq(vendorCreditApplications.creditId, creditId)));
  if ((row?.c ?? 0) > 0) {
    throw AppError.badRequest('Cannot void a credit that has been applied to bills. Void the bill payments first.');
  }

  return ledger.voidTransaction(tenantId, creditId, reason, userId);
}

export async function listVendorCredits(tenantId: string, filters: {
  contactId?: string;
  startDate?: string;
  endDate?: string;
  search?: string;
  limit?: number;
  offset?: number;
}, companyId?: string) {
  const conditions = [
    eq(transactions.tenantId, tenantId),
    eq(transactions.txnType, 'vendor_credit'),
  ];
  if (companyId) conditions.push(eq(transactions.companyId, companyId));
  if (filters.contactId) conditions.push(eq(transactions.contactId, filters.contactId));
  if (filters.startDate) conditions.push(sql`${transactions.txnDate} >= ${filters.startDate}`);
  if (filters.endDate) conditions.push(sql`${transactions.txnDate} <= ${filters.endDate}`);
  if (filters.search) {
    const term = `%${filters.search}%`;
    conditions.push(sql`(${transactions.memo} ILIKE ${term} OR ${transactions.txnNumber} ILIKE ${term} OR ${contacts.displayName} ILIKE ${term})`);
  }

  const where = and(...conditions);
  const [data, totalRow] = await Promise.all([
    db.select({
      id: transactions.id,
      txnNumber: transactions.txnNumber,
      txnDate: transactions.txnDate,
      contactId: transactions.contactId,
      contactName: contacts.displayName,
      total: transactions.total,
      balanceDue: transactions.balanceDue,
      memo: transactions.memo,
      status: transactions.status,
      createdAt: transactions.createdAt,
    }).from(transactions)
      .leftJoin(contacts, eq(transactions.contactId, contacts.id))
      .where(where)
      .orderBy(sql`${transactions.txnDate} DESC`)
      .limit(filters.limit ?? 50)
      .offset(filters.offset ?? 0),
    db.select({ c: count() }).from(transactions)
      .leftJoin(contacts, eq(transactions.contactId, contacts.id))
      .where(where),
  ]);

  return { data, total: totalRow[0]?.c ?? 0 };
}

export async function getAvailableCredits(tenantId: string, vendorId: string) {
  return db.select({
    id: transactions.id,
    txnNumber: transactions.txnNumber,
    txnDate: transactions.txnDate,
    total: transactions.total,
    balanceDue: transactions.balanceDue,
    memo: transactions.memo,
  }).from(transactions)
    .where(and(
      eq(transactions.tenantId, tenantId),
      eq(transactions.txnType, 'vendor_credit'),
      eq(transactions.status, 'posted'),
      eq(transactions.contactId, vendorId),
      sql`COALESCE(${transactions.balanceDue}, 0) > 0`,
    ))
    .orderBy(sql`${transactions.txnDate} ASC`);
}
