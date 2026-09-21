// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import type { MatchCandidate } from '@kis-books/shared';
import { db } from '../db/index.js';
import {
  tenants, accounts, auditLog, contacts, transactions, journalLines, billPaymentApplications,
  bankConnections, bankFeedItems, transactionClassificationState,
} from '../db/schema/index.js';
import * as accountsService from './accounts.service.js';
import * as billService from './bill.service.js';
import { applyMatch } from './match-apply.service.js';

let tenantId = '';
let bankAccountId: string;
let expenseId: string;
let vendorId: string;
let connectionId: string;
const USER_ID = '00000000-0000-4000-8000-0000000000aa';

// Tenant-SCOPED cleanup — never touch another suite's rows.
async function cleanDb() {
  if (!tenantId) return;
  await db.delete(transactionClassificationState).where(eq(transactionClassificationState.tenantId, tenantId));
  await db.delete(bankFeedItems).where(eq(bankFeedItems.tenantId, tenantId));
  await db.delete(bankConnections).where(eq(bankConnections.tenantId, tenantId));
  await db.delete(billPaymentApplications).where(eq(billPaymentApplications.tenantId, tenantId));
  await db.delete(journalLines).where(eq(journalLines.tenantId, tenantId));
  await db.delete(transactions).where(eq(transactions.tenantId, tenantId));
  await db.delete(auditLog).where(eq(auditLog.tenantId, tenantId));
  await db.delete(contacts).where(eq(contacts.tenantId, tenantId));
  await db.delete(accounts).where(eq(accounts.tenantId, tenantId));
  await db.delete(tenants).where(eq(tenants.id, tenantId));
  tenantId = '';
}

async function setup() {
  const [tenant] = await db.insert(tenants).values({ name: 'Match Apply Test', slug: `match-apply-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` }).returning();
  tenantId = tenant!.id;
  bankAccountId = (await accountsService.create(tenantId, { name: 'Checking', accountType: 'asset', detailType: 'bank', accountNumber: '1000' })).id;
  await db.insert(accounts).values({ tenantId, name: 'Accounts Payable', accountType: 'liability', accountNumber: '2000', systemTag: 'accounts_payable', isSystem: true });
  expenseId = (await accountsService.create(tenantId, { name: 'Utilities', accountType: 'expense', accountNumber: '6100' })).id;
  const [vendor] = await db.insert(contacts).values({ tenantId, contactType: 'vendor', displayName: 'Spire' }).returning();
  vendorId = vendor!.id;
  const [conn] = await db.insert(bankConnections).values({ tenantId, accountId: bankAccountId }).returning();
  connectionId = conn!.id;
}

// A pending bank-feed debit with one open-bill match candidate staged on it.
async function stageBillMatch(feed: { amount: string; checkNumber?: number }) {
  const bill = await billService.createBill(tenantId, {
    contactId: vendorId, txnDate: '2026-09-10', vendorInvoiceNumber: '4394722222',
    lines: [{ accountId: expenseId, amount: '68.95' }],
  });
  const [item] = await db.insert(bankFeedItems).values({
    tenantId, bankConnectionId: connectionId, feedDate: '2026-09-28', description: 'SPIRE ENERGY AUTOPAY',
    amount: feed.amount, status: 'pending', checkNumber: feed.checkNumber ?? null,
  }).returning();
  const candidate: MatchCandidate = {
    kind: 'bill', targetId: bill.id, amount: '68.95', date: '2026-09-10', contactName: 'Spire',
    score: 0.95, amountScore: 1, dateScore: 0.9, nameScore: 0.9, reason: 'amount + vendor',
  };
  const [state] = await db.insert(transactionClassificationState).values({
    tenantId, bankFeedItemId: item!.id, bucket: 'potential_match', matchCandidates: [candidate],
  }).returning();
  return { bill, item: item!, stateId: state!.id };
}

describe('applyMatch — open bill', () => {
  beforeEach(async () => { await cleanDb(); await setup(); });
  afterEach(async () => { await cleanDb(); });

  // Regression: this path read result shapes payBills has never returned, so
  // it threw AFTER the payment posted — bill paid, feed line still pending,
  // and a retry paid the bill a second time.
  it('pays the bill, links the feed line to the payment, and records no check', async () => {
    const { bill, item, stateId } = await stageBillMatch({ amount: '-68.95' });

    const result = await applyMatch(tenantId, stateId, 0, USER_ID);
    expect(result).toMatchObject({ kind: 'bill', partial: false });
    expect(Number(result.appliedAmount)).toBe(68.95);

    const [payment] = await db.select().from(transactions).where(eq(transactions.id, result.appliedTransactionId));
    expect(payment).toMatchObject({ txnType: 'bill_payment', source: 'bank_feed', sourceId: item.id });
    // The money already left the bank: nothing to print, no number to hand
    // out, and the feed doesn't say how it was paid.
    expect(payment!.printStatus).toBeNull();
    expect(payment!.checkNumber).toBeNull();
    expect(payment!.printedMemo).toBeNull();
    expect(payment!.paymentMethod).toBeNull();

    const [linked] = await db.select().from(bankFeedItems).where(eq(bankFeedItems.id, item.id));
    expect(linked).toMatchObject({ status: 'matched', matchedTransactionId: payment!.id });
    const [state] = await db.select().from(transactionClassificationState).where(eq(transactionClassificationState.id, stateId));
    expect(state!.transactionId).toBe(payment!.id);

    const [paidBill] = await db.select().from(transactions).where(eq(transactions.id, bill.id));
    expect(paidBill!.billStatus).toBe('paid');

    // The retry that used to double-pay is now refused outright.
    await expect(applyMatch(tenantId, stateId, 0, USER_ID)).rejects.toThrow(/not pending/i);
    const payments = await db.select().from(billPaymentApplications).where(eq(billPaymentApplications.billId, bill.id));
    expect(payments).toHaveLength(1);
  });

  it("keeps the bank's check number when the cleared item was a check", async () => {
    const { stateId } = await stageBillMatch({ amount: '-68.95', checkNumber: 1042 });
    const result = await applyMatch(tenantId, stateId, 0, USER_ID);
    const [payment] = await db.select().from(transactions).where(eq(transactions.id, result.appliedTransactionId));
    expect(payment).toMatchObject({ paymentMethod: 'check', checkNumber: 1042, printStatus: 'hand_written' });
  });

  it('applies a smaller cleared amount as a partial payment', async () => {
    const { bill, stateId } = await stageBillMatch({ amount: '-40.00' });
    const result = await applyMatch(tenantId, stateId, 0, USER_ID);
    expect(result.partial).toBe(true);
    const [partialBill] = await db.select().from(transactions).where(eq(transactions.id, bill.id));
    expect(partialBill!.billStatus).toBe('partial');
    expect(Number(partialBill!.balanceDue)).toBeCloseTo(28.95);
  });
});
