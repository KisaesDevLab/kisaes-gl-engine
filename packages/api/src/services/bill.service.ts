// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { eq, and, sql, count, inArray } from 'drizzle-orm';
import DecimalLib from 'decimal.js';
const Decimal = DecimalLib.default || DecimalLib;
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

/**
 * Verify that every accountId referenced by a bill's lines belongs
 * to the caller's tenant. Without this check, a crafted payload
 * could reference an account id from another tenant — the ledger
 * service would happily post a journal line against it. Rejecting
 * at the bill layer keeps the error message specific to what the
 * user actually submitted.
 */
async function assertAccountsInTenant(tenantId: string, accountIds: string[]): Promise<void> {
  if (accountIds.length === 0) return;
  const unique = [...new Set(accountIds)];
  const rows = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.tenantId, tenantId), inArray(accounts.id, unique)));
  if (rows.length !== unique.length) {
    throw AppError.badRequest('One or more bill line accounts do not belong to this tenant');
  }
}

export async function createBill(tenantId: string, input: CreateBillInput, userId?: string, companyId?: string) {
  if (input.lines.length === 0) throw AppError.badRequest('Bill must have at least one line');

  await assertAccountsInTenant(tenantId, input.lines.map((l) => l.accountId));
  const apAccountId = await getApAccountId(tenantId);
  const vendor = await loadVendorDefaults(tenantId, input.contactId);

  // Resolve terms: explicit > vendor default
  const paymentTerms = input.paymentTerms || vendor.defaultPaymentTerms || undefined;
  const termsDays = input.termsDays ?? vendor.defaultTermsDays ?? undefined;
  const dueDate = input.dueDate || computeBillDueDate(input.txnDate, paymentTerms, termsDays);

  // Sum line amounts through Decimal — float arithmetic drifts on
  // multi-line bills and makes the AP credit ≠ sum of expense debits
  // by a sub-cent, which ledger.postTransaction then rejects as an
  // unbalanced transaction.
  const total = input.lines.reduce((sum, l) => sum.plus(l.amount || '0'), new Decimal('0'));
  if (total.lessThanOrEqualTo(0)) throw AppError.badRequest('Bill total must be positive');

  const journalLines = [
    ...input.lines.map((l) => ({
      accountId: l.accountId,
      debit: new Decimal(l.amount).toFixed(4),
      credit: '0',
      description: l.description || input.memo,
      tagId: l.tagId,
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
  }, userId, companyId);
}

export async function getBill(tenantId: string, billId: string) {
  const bill = await ledger.getTransaction(tenantId, billId);
  if (bill.txnType !== 'bill') throw AppError.badRequest('Not a bill');
  return bill;
}

export async function updateBill(tenantId: string, billId: string, input: CreateBillInput, userId?: string, companyId?: string) {
  const existing = await ledger.getTransaction(tenantId, billId);
  if (existing.txnType !== 'bill') throw AppError.badRequest('Not a bill');
  if (existing.status === 'void') throw AppError.badRequest('Cannot edit a void bill');

  await assertAccountsInTenant(tenantId, input.lines.map((l) => l.accountId));

  // A bill is considered "locked" for total/vendor/date edits as soon
  // as any payment or vendor credit has been applied to it. The user
  // can still reallocate the expense lines (move money between
  // accounts, split a line, add or remove lines, edit descriptions)
  // but the AMOUNT TOTAL must stay the same so existing payment /
  // credit applications remain consistent, the VENDOR must stay the
  // same so payments don't end up pointing at a different contact,
  // and the BILL DATE must stay the same so the payment can't end up
  // dated before the bill.
  const isLocked = !!existing.billStatus && existing.billStatus !== 'unpaid';

  const apAccountId = await getApAccountId(tenantId);

  // Vendor resolution depends on whether we're locked to the existing
  // vendor. If locked, we re-use the existing contactId verbatim and
  // ignore whatever the client sent, so a tampered payload can't sneak
  // through a vendor swap. If unlocked, we accept the new vendor.
  let resolvedContactId: string;
  if (isLocked) {
    if (!existing.contactId) throw AppError.internal('Paid bill missing contactId');
    if (input.contactId && input.contactId !== existing.contactId) {
      throw AppError.badRequest(
        'Cannot change the vendor on a bill that has payments or credits applied. ' +
        'Void the payments first, or create a new bill with the correct vendor.',
      );
    }
    resolvedContactId = existing.contactId;
  } else {
    resolvedContactId = input.contactId;
  }
  const vendor = await loadVendorDefaults(tenantId, resolvedContactId);

  // Date resolution: locked bills keep the original txnDate. Payment
  // transactions already reference this date; letting it move forward
  // would create a paid-before-billed state, and moving it backward
  // could push it behind the lock date.
  const resolvedTxnDate = isLocked ? existing.txnDate : input.txnDate;
  if (isLocked && input.txnDate && input.txnDate !== existing.txnDate) {
    throw AppError.badRequest(
      'Cannot change the bill date on a bill that has payments or credits applied.',
    );
  }

  const paymentTerms = isLocked
    ? (existing.paymentTerms || undefined)
    : (input.paymentTerms || vendor.defaultPaymentTerms || undefined);
  const termsDays = isLocked
    ? (existing.termsDays ?? undefined)
    : (input.termsDays ?? vendor.defaultTermsDays ?? undefined);
  const dueDate = isLocked
    ? (existing.dueDate || undefined)
    : (input.dueDate || computeBillDueDate(resolvedTxnDate, paymentTerms, termsDays));

  const total = input.lines.reduce((sum, l) => sum.plus(l.amount || '0'), new Decimal('0'));
  if (total.lessThanOrEqualTo(0)) throw AppError.badRequest('Bill total must be positive');

  // Total-lock enforcement. The same 0.01 tolerance used elsewhere
  // absorbs tax and per-line rounding drift without letting meaningful
  // changes slip through.
  const existingTotal = new Decimal(existing.total || '0');
  const tolerance = new Decimal('0.01');
  if (isLocked && total.minus(existingTotal).abs().greaterThan(tolerance)) {
    throw AppError.badRequest(
      `Cannot change the total on a paid bill. Expected $${existingTotal.toFixed(2)}, ` +
      `got $${total.toFixed(2)}. Reallocate between expense accounts instead — ` +
      `the sum of all lines must equal the original total.`,
    );
  }

  const journalLines = [
    ...input.lines.map((l) => ({
      accountId: l.accountId,
      debit: new Decimal(l.amount).toFixed(4),
      credit: '0',
      description: l.description || input.memo,
      tagId: l.tagId,
    })),
    { accountId: apAccountId, debit: '0', credit: total.toFixed(4) },
  ];

  // Post the expense/AP journal change via the ledger. For a locked
  // bill total is unchanged, so the AP credit nets out to zero net
  // movement; only the expense-account allocation shifts. For an
  // unlocked bill the AP balance moves with the new total.
  const updated = await ledger.updateTransaction(tenantId, billId, {
    txnType: 'bill',
    txnDate: resolvedTxnDate,
    dueDate,
    contactId: resolvedContactId,
    memo: input.memo,
    internalNotes: input.internalNotes,
    paymentTerms,
    termsDays,
    vendorInvoiceNumber: input.vendorInvoiceNumber,
    total: total.toFixed(4),
    // For locked bills, preserve the existing balance_due (which
    // reflects payments / credits already applied). For unlocked
    // bills, balance_due equals the full total.
    balanceDue: isLocked ? (existing.balanceDue || '0') : total.toFixed(4),
    lines: journalLines,
  }, userId, companyId);

  if (isLocked) {
    // Preserve payment-derived state, but update the bill-specific
    // columns that ledger.updateTransaction doesn't touch
    // (vendorInvoiceNumber, paymentTerms, termsDays). Do NOT reset
    // amountPaid/creditsApplied/billStatus — recompute them from the
    // application tables so any drift between ledger.updateTransaction's
    // total write and the sum of applications gets corrected.
    await db.update(transactions).set({
      paymentTerms: paymentTerms || null,
      termsDays: termsDays ?? null,
      vendorInvoiceNumber: input.vendorInvoiceNumber || null,
      updatedAt: new Date(),
    }).where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, billId)));

    await recomputeBillStatus(db, tenantId, billId);
  } else {
    // Unpaid edit path: safe to hard-reset the payment fields since
    // nothing has been applied yet.
    await db.update(transactions).set({
      paymentTerms: paymentTerms || null,
      termsDays: termsDays ?? null,
      vendorInvoiceNumber: input.vendorInvoiceNumber || null,
      billStatus: 'unpaid',
      creditsApplied: '0',
      amountPaid: '0',
      updatedAt: new Date(),
    }).where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, billId)));
  }

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

export async function listBills(tenantId: string, filters: BillFilters, companyId?: string) {
  const conditions = [
    eq(transactions.tenantId, tenantId),
    eq(transactions.txnType, 'bill'),
  ];
  if (companyId) conditions.push(eq(transactions.companyId, companyId));

  if (filters.contactId) conditions.push(eq(transactions.contactId, filters.contactId));
  if (filters.billStatus) conditions.push(eq(transactions.billStatus, filters.billStatus));
  if (filters.startDate) conditions.push(sql`${transactions.txnDate} >= ${filters.startDate}`);
  if (filters.endDate) conditions.push(sql`${transactions.txnDate} <= ${filters.endDate}`);
  // ADR 0XX §5.2 — header-level tag filter via EXISTS on the line set.
  if ((filters as BillFilters & { tagId?: string }).tagId) {
    const tagId = (filters as BillFilters & { tagId?: string }).tagId!;
    conditions.push(sql`EXISTS (SELECT 1 FROM journal_lines jl WHERE jl.transaction_id = ${transactions.id} AND jl.tenant_id = ${tenantId} AND jl.tag_id = ${tagId})`);
  }
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

  const total = new Decimal(row.total || '0');
  const paid = new Decimal(String(row.paid));
  const credits = new Decimal(String(row.credits));
  let balanceDue = total.minus(paid).minus(credits);
  if (balanceDue.isNegative()) balanceDue = new Decimal('0');

  const tolerance = new Decimal('0.01');
  let status: 'unpaid' | 'partial' | 'paid' = 'unpaid';
  if (balanceDue.lessThanOrEqualTo(tolerance)) status = 'paid';
  else if (paid.greaterThan(0) || credits.greaterThan(0)) status = 'partial';

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

  const total = new Decimal(row.total || '0');
  const applied = new Decimal(String(row.applied));
  let balanceDue = total.minus(applied);
  if (balanceDue.isNegative()) balanceDue = new Decimal('0');
  const tolerance = new Decimal('0.01');

  await executor.update(transactions).set({
    creditsApplied: applied.toFixed(4),
    balanceDue: balanceDue.toFixed(4),
    billStatus: balanceDue.lessThanOrEqualTo(tolerance) ? 'paid' : 'unpaid',
    updatedAt: new Date(),
  }).where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, creditId)));
}
