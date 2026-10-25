// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { eq, and, sql, count } from 'drizzle-orm';
import type { CreateVendorCreditInput } from '@kis-books/shared';
import { db, type DbOrTx, type Tx } from '../db/index.js';
import { transactions, accounts, contacts } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import * as ledger from './ledger.service.js';
import { escapeLike } from '../utils/sql-like.js';
import { buildApLines, assertApLineRefs, recomputeVendorCreditBalance } from './bill.service.js';
import { relinkDraftAttachments } from './attachment.service.js';

async function getApAccountId(executor: DbOrTx, tenantId: string): Promise<string> {
  const [account] = await executor.select({ id: accounts.id }).from(accounts)
    .where(and(eq(accounts.tenantId, tenantId), eq(accounts.systemTag, 'accounts_payable')))
    .limit(1);
  if (!account) throw AppError.internal("System account 'accounts_payable' not found. Seed COA first.");
  return account.id;
}

async function getNextVendorCreditNumber(tenantId: string): Promise<string> {
  const [row] = await db.select({ c: count() }).from(transactions)
    .where(and(eq(transactions.tenantId, tenantId), eq(transactions.txnType, 'vendor_credit')));
  const next = (row?.c ?? 0) + 1;
  return `VC-${String(next).padStart(5, '0')}`;
}

async function assertVendorInScope(executor: DbOrTx, tenantId: string, contactId: string, companyId?: string) {
  const [vendor] = await executor.select({ id: contacts.id, companyId: contacts.companyId }).from(contacts)
    .where(and(eq(contacts.tenantId, tenantId), eq(contacts.id, contactId)))
    .limit(1);
  if (!vendor || (companyId && vendor.companyId && vendor.companyId !== companyId)) {
    throw AppError.badRequest('Vendor not found');
  }
}

/**
 * The journal of a vendor credit — the mirror image of a bill: DR A/P for
 * the exact sum, CR each line's account. Lines carry item, quantity, cost,
 * customer and tag (bill-lines-v1); never billable.
 */
function creditJournal(apAccountId: string, input: CreateVendorCreditInput, built: ReturnType<typeof buildApLines>) {
  return [
    { accountId: apAccountId, debit: built.total.toFixed(4), credit: '0' },
    ...built.lines.map((l) => ({
      accountId: l.accountId,
      debit: '0',
      credit: l.amount.toFixed(4),
      description: l.description || input.memo,
      tagId: l.tagId,
      itemId: l.itemId ?? undefined,
      quantity: l.quantity ?? undefined,
      unitPrice: l.unitPrice ?? undefined,
      contactId: l.contactId,
    })),
  ];
}

export async function createVendorCredit(tenantId: string, input: CreateVendorCreditInput, userId?: string, companyId?: string, outerTx?: Tx) {
  if (input.lines.length === 0) throw AppError.badRequest('Vendor credit must have at least one line');
  // Exact decimal: each line an exact 4-place amount, the A/P debit their
  // sum (U-65).
  const built = buildApLines(input.lines, { allowBillable: false });
  if (!built.total.greaterThan(0)) throw AppError.badRequest('Vendor credit total must be positive');

  const run = async (tx: Tx) => {
    await assertApLineRefs(tx, tenantId, companyId, built.lines);
    await assertVendorInScope(tx, tenantId, input.contactId, companyId);
    const apAccountId = await getApAccountId(tx, tenantId);
    const txnNumber = await getNextVendorCreditNumber(tenantId);

    const credit = await ledger.postTransaction(tenantId, {
      txnType: 'vendor_credit',
      txnNumber,
      txnDate: input.txnDate,
      contactId: input.contactId,
      memo: input.memo,
      vendorInvoiceNumber: input.vendorInvoiceNumber,
      total: built.total.toFixed(4),
      balanceDue: built.total.toFixed(4),
      amountPaid: '0',
      creditsApplied: '0',
      billStatus: 'unpaid',
      lines: creditJournal(apAccountId, input, built),
    }, userId, companyId, tx);

    if (input.draftAttachmentId) {
      await relinkDraftAttachments(tx, tenantId, input.draftAttachmentId, 'vendor_credit', credit.id, userId);
    }
    return credit;
  };
  return outerTx ? run(outerTx) : db.transaction(run);
}

export async function getVendorCredit(tenantId: string, creditId: string) {
  const credit = await ledger.getTransaction(tenantId, creditId);
  if (credit.txnType !== 'vendor_credit') throw AppError.badRequest('Not a vendor credit');
  return credit;
}

/**
 * PUT /vendor-credits/:id (U-84, ap-edit-v1): the create body. One database
 * transaction: the row locked FOR UPDATE, `expectedUpdatedAt` checked (409
 * STALE), refused with 409 CREDIT_APPLIED while any bill payment applies it
 * or a deposit refunds it. The open balance is recomputed from the
 * application rows (review S7). Reply: the credit as committed.
 */
export async function updateVendorCredit(tenantId: string, creditId: string, input: CreateVendorCreditInput, userId?: string, companyId?: string) {
  if (input.lines.length === 0) throw AppError.badRequest('Vendor credit must have at least one line');
  const built = buildApLines(input.lines, { allowBillable: false });
  if (!built.total.greaterThan(0)) throw AppError.badRequest('Vendor credit total must be positive');

  await db.transaction(async (tx) => {
    const [existing] = await tx.select().from(transactions)
      .where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, creditId)))
      .for('update')
      .limit(1);
    if (!existing || existing.status === 'deleted'
      || (companyId && existing.companyId && existing.companyId !== companyId)) {
      throw AppError.notFound('Transaction not found');
    }
    if (existing.txnType !== 'vendor_credit') throw AppError.badRequest('Not a vendor credit');
    if (existing.status === 'void') throw AppError.badRequest('Cannot edit a void vendor credit');
    ledger.assertNotStale(existing, input.expectedUpdatedAt, 'This vendor credit');
    await ledger.assertApDocumentUnapplied(tx, tenantId, existing, { includeRefunds: true });

    await assertApLineRefs(tx, tenantId, companyId, built.lines);
    await assertVendorInScope(tx, tenantId, input.contactId, companyId);
    const apAccountId = await getApAccountId(tx, tenantId);

    await ledger.updateTransaction(tenantId, creditId, {
      txnType: 'vendor_credit',
      txnDate: input.txnDate,
      contactId: input.contactId,
      memo: input.memo,
      vendorInvoiceNumber: input.vendorInvoiceNumber,
      total: built.total.toFixed(4),
      balanceDue: built.total.toFixed(4),
      lines: creditJournal(apAccountId, input, built),
    }, userId, companyId, tx, { apDocumentEdit: true });

    await tx.update(transactions).set({
      vendorInvoiceNumber: input.vendorInvoiceNumber || null,
      updatedAt: new Date(),
    }).where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, creditId)));
    await recomputeVendorCreditBalance(tx, tenantId, creditId);
  });

  return getVendorCredit(tenantId, creditId);
}

/**
 * Voids a vendor credit. Refused while applied to a bill (409
 * CREDIT_APPLIED, read under the row lock), refunded by a deposit (409
 * TXN_DEPOSITED) or on an expectedUpdatedAt mismatch (409 STALE).
 */
export async function voidVendorCredit(tenantId: string, creditId: string, reason: string, userId?: string, opts: { expectedUpdatedAt?: string } = {}) {
  return ledger.voidTransaction(tenantId, creditId, reason, userId, { ...opts, expectType: 'vendor_credit' });
}

export const VENDOR_CREDIT_SORT_KEYS = ['txnNumber', 'contactName', 'txnDate', 'total', 'balanceDue', 'memo'] as const;
export type VendorCreditSortKey = (typeof VENDOR_CREDIT_SORT_KEYS)[number];

function vendorCreditOrderExpr(key: VendorCreditSortKey) {
  switch (key) {
    case 'txnNumber': return sql`${transactions.txnNumber}`;
    case 'contactName': return sql`LOWER(${contacts.displayName})`;
    case 'total': return sql`CAST(${transactions.total} AS DECIMAL)`;
    case 'balanceDue': return sql`CAST(${transactions.balanceDue} AS DECIMAL)`;
    case 'memo': return sql`LOWER(${transactions.memo})`;
    case 'txnDate':
    default: return sql`${transactions.txnDate}`;
  }
}

export async function listVendorCredits(tenantId: string, filters: {
  contactId?: string;
  startDate?: string;
  endDate?: string;
  search?: string;
  // Server-side column sort (the list paginates). Default: date desc.
  sortBy?: VendorCreditSortKey;
  sortDir?: 'asc' | 'desc';
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
    // The vendor's credit-memo number is searched too (review S6).
    const term = `%${escapeLike(filters.search)}%`;
    conditions.push(sql`(${transactions.memo} ILIKE ${term} OR ${transactions.txnNumber} ILIKE ${term} OR ${transactions.vendorInvoiceNumber} ILIKE ${term} OR ${contacts.displayName} ILIKE ${term})`);
  }

  const where = and(...conditions);
  const [data, totalRow] = await Promise.all([
    db.select({
      id: transactions.id,
      txnNumber: transactions.txnNumber,
      txnDate: transactions.txnDate,
      contactId: transactions.contactId,
      contactName: contacts.displayName,
      vendorInvoiceNumber: transactions.vendorInvoiceNumber,
      total: transactions.total,
      balanceDue: transactions.balanceDue,
      memo: transactions.memo,
      status: transactions.status,
      createdAt: transactions.createdAt,
      updatedAt: transactions.updatedAt,
    }).from(transactions)
      .leftJoin(contacts, eq(transactions.contactId, contacts.id))
      .where(where)
      .orderBy(
        sql`${vendorCreditOrderExpr(filters.sortBy ?? 'txnDate')} ${(filters.sortDir ?? 'desc') === 'asc' ? sql`ASC` : sql`DESC`} NULLS LAST`,
        sql`${transactions.txnDate} DESC`,
        sql`${transactions.createdAt} DESC`,
        sql`${transactions.id} DESC`,
      )
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
    vendorInvoiceNumber: transactions.vendorInvoiceNumber,
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
