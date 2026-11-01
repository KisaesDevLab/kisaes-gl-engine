// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// Bank feed and customer payments (U-136, feed-customer-payments-v1):
// candidates include customer payments deposited straight to the bank and
// bounced-payment entries, compared exactly; POST /payments/receive with
// bankFeedItemId matches the line in the payment's transaction.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  tenants, companies, accounts, auditLog, contacts, transactions, journalLines, paymentApplications,
  bankConnections, bankFeedItems,
} from '../db/schema/index.js';
import * as accountsService from './accounts.service.js';
import * as invoiceService from './invoice.service.js';
import * as paymentService from './payment.service.js';
import { findMatchCandidates } from './bank-feed.service.js';

let tenantId = '';
let companyId = '';
let bankId: string;
let revenueId: string;
let customerId: string;
let connectionId: string;

async function cleanDb() {
  if (!tenantId) return;
  await db.delete(bankFeedItems).where(eq(bankFeedItems.tenantId, tenantId));
  await db.delete(bankConnections).where(eq(bankConnections.tenantId, tenantId));
  await db.delete(paymentApplications).where(eq(paymentApplications.tenantId, tenantId));
  await db.delete(journalLines).where(eq(journalLines.tenantId, tenantId));
  await db.delete(transactions).where(eq(transactions.tenantId, tenantId));
  await db.delete(auditLog).where(eq(auditLog.tenantId, tenantId));
  await db.delete(contacts).where(eq(contacts.tenantId, tenantId));
  await db.delete(accounts).where(eq(accounts.tenantId, tenantId));
  await db.delete(companies).where(eq(companies.tenantId, tenantId));
  await db.delete(tenants).where(eq(tenants.id, tenantId));
  tenantId = '';
}

async function setup() {
  const [tenant] = await db.insert(tenants).values({ name: 'Feed Payments', slug: `feed-pay-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` }).returning();
  tenantId = tenant!.id;
  const [co] = await db.insert(companies).values({ tenantId, businessName: 'Feed Co', invoicePrefix: 'INV-', invoiceNextNumber: 1, defaultSalesTaxRate: '0' }).returning();
  companyId = co!.id;
  bankId = (await accountsService.create(tenantId, { name: 'Checking', accountType: 'asset', detailType: 'bank', accountNumber: '1000' })).id;
  await db.insert(accounts).values({ tenantId, name: 'Accounts Receivable', accountType: 'asset', accountNumber: '1100', systemTag: 'accounts_receivable', isSystem: true });
  revenueId = (await accountsService.create(tenantId, { name: 'Sales', accountType: 'revenue', accountNumber: '4000' })).id;
  const [customer] = await db.insert(contacts).values({ tenantId, contactType: 'customer', displayName: 'Webb City Dental' }).returning();
  customerId = customer!.id;
  const [conn] = await db.insert(bankConnections).values({ tenantId, accountId: bankId }).returning();
  connectionId = conn!.id;
}

async function invoice(total: string) {
  return (await invoiceService.createInvoice(tenantId, {
    contactId: customerId, txnDate: '2026-11-01',
    lines: [{ accountId: revenueId, description: 'Cleaning', quantity: '1', unitPrice: total, isTaxable: false }],
  } as never, undefined, companyId)).id;
}

async function feed(amount: string, date = '2026-11-05') {
  const [item] = await db.insert(bankFeedItems).values({
    tenantId, bankConnectionId: connectionId, feedDate: date, description: 'DEPOSIT', amount, status: 'pending',
  }).returning();
  return item!.id;
}

const receive = (inv: string, extra: Record<string, unknown> = {}) => paymentService.receivePayment(tenantId, {
  customerId, date: '2026-11-04', amount: '100.00', depositTo: bankId,
  applications: [{ invoiceId: inv, amount: '100.00' }], ...extra,
} as never, undefined, companyId);

describe('feed-customer-payments-v1 (U-136)', () => {
  beforeEach(async () => { await cleanDb(); await setup(); });
  afterEach(async () => { await cleanDb(); });

  it('candidates include the payment deposited straight to the bank (money in) and its bounce (money out), exactly', async () => {
    const inv = await invoice('100.00');
    const payment = await receive(inv);
    const moneyIn = await feed('100.0000');
    let c = await findMatchCandidates(tenantId, moneyIn);
    expect(c.map((x) => [x.id, x.txnType])).toEqual([[payment.id, 'customer_payment']]);
    // Less than a cent apart is not the same amount any more.
    const near = await feed('99.9950');
    expect(await findMatchCandidates(tenantId, near)).toEqual([]);
    // A payment never matches money going out.
    expect(await findMatchCandidates(tenantId, await feed('-100.0000'))).toEqual([]);

    const b = await paymentService.bouncePayment(tenantId, payment.id, { date: '2026-11-10' }, undefined, companyId);
    const moneyOut = await feed('-100.0000', '2026-11-11');
    c = await findMatchCandidates(tenantId, moneyOut);
    expect(c.map((x) => [x.id, x.txnType])).toEqual([[b.returnId, 'returned_payment']]);
    // The bounced payment is no longer a money-in candidate.
    expect(await findMatchCandidates(tenantId, moneyIn)).toEqual([]);
  });

  it('receive with bankFeedItemId matches the line in the same transaction; a mismatch or a second use posts nothing', async () => {
    const inv = await invoice('100.00');
    const item = await feed('100.0000');
    await expect(receive(inv, { bankFeedItemId: item, amount: '99.99', applications: [{ invoiceId: inv, amount: '99.99' }] }))
      .rejects.toMatchObject({ code: 'FEED_ITEM_MISMATCH' });
    const other = (await accountsService.create(tenantId, { name: 'Savings', accountType: 'asset', detailType: 'bank', accountNumber: '1010' })).id;
    await expect(receive(inv, { bankFeedItemId: item, depositTo: other })).rejects.toMatchObject({ code: 'FEED_ITEM_MISMATCH' });
    const payment = await receive(inv, { bankFeedItemId: item });
    const [row] = await db.select().from(bankFeedItems).where(eq(bankFeedItems.id, item));
    expect([row!.status, row!.matchedTransactionId]).toEqual(['matched', payment.id]);
    const inv2 = await invoice('100.00');
    await expect(receive(inv2, { bankFeedItemId: item, applications: [{ invoiceId: inv2, amount: '100.00' }] }))
      .rejects.toMatchObject({ code: 'FEED_ITEM_NOT_PENDING' });
    const pays = await db.select().from(transactions).where(and(eq(transactions.tenantId, tenantId), eq(transactions.txnType, 'customer_payment')));
    expect(pays).toHaveLength(1);
    expect((await db.select().from(transactions).where(eq(transactions.id, inv2)))[0]!.balanceDue).toBe('100.0000');
  });
});
