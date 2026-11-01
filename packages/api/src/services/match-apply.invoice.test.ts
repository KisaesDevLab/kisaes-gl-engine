// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// Bank-feed match to an open invoice (U-132, exact amounts): the invoice
// takes min(feed amount, its cent balance), compared with Decimal; anything
// above stays an A/R credit on the client. The feed line never fails.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import type { MatchCandidate } from '@kis-books/shared';
import { db } from '../db/index.js';
import {
  tenants, companies, accounts, auditLog, contacts, transactions, journalLines, paymentApplications,
  bankConnections, bankFeedItems, transactionClassificationState,
} from '../db/schema/index.js';
import * as accountsService from './accounts.service.js';
import * as invoiceService from './invoice.service.js';
import { applyMatch } from './match-apply.service.js';

let tenantId = '';
let bankAccountId: string;
let revenueId: string;
let customerId: string;
let connectionId: string;
const USER_ID = '00000000-0000-4000-8000-0000000000ab';

async function cleanDb() {
  if (!tenantId) return;
  await db.delete(transactionClassificationState).where(eq(transactionClassificationState.tenantId, tenantId));
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
  const [tenant] = await db.insert(tenants).values({ name: 'Match Invoice Test', slug: `match-inv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` }).returning();
  tenantId = tenant!.id;
  await db.insert(companies).values({ tenantId, businessName: 'Match Co', invoicePrefix: 'INV-', invoiceNextNumber: 1, defaultSalesTaxRate: '0' });
  bankAccountId = (await accountsService.create(tenantId, { name: 'Checking', accountType: 'asset', detailType: 'bank', accountNumber: '1000' })).id;
  await db.insert(accounts).values({ tenantId, name: 'Accounts Receivable', accountType: 'asset', accountNumber: '1100', systemTag: 'accounts_receivable', isSystem: true });
  revenueId = (await accountsService.create(tenantId, { name: 'Sales', accountType: 'revenue', accountNumber: '4000' })).id;
  const [customer] = await db.insert(contacts).values({ tenantId, contactType: 'customer', displayName: 'Carthage Clinic' }).returning();
  customerId = customer!.id;
  const [conn] = await db.insert(bankConnections).values({ tenantId, accountId: bankAccountId }).returning();
  connectionId = conn!.id;
}

async function stage(feedAmount: string) {
  const inv = await invoiceService.createInvoice(tenantId, {
    contactId: customerId, txnDate: '2026-09-10',
    lines: [{ accountId: revenueId, description: 'Visit', quantity: '1', unitPrice: '100.00', isTaxable: false }],
  } as never);
  const [item] = await db.insert(bankFeedItems).values({
    tenantId, bankConnectionId: connectionId, feedDate: '2026-09-28', description: 'DEPOSIT CARTHAGE CLINIC',
    amount: feedAmount, status: 'pending',
  }).returning();
  const candidate: MatchCandidate = {
    kind: 'invoice', targetId: inv.id, amount: '100.00', date: '2026-09-10', contactName: 'Carthage Clinic',
    score: 0.95, amountScore: 1, dateScore: 0.9, nameScore: 0.9, reason: 'amount + customer',
  };
  const [state] = await db.insert(transactionClassificationState).values({
    tenantId, bankFeedItemId: item!.id, bucket: 'potential_match', matchCandidates: [candidate],
  }).returning();
  return { inv, stateId: state!.id };
}

describe('applyMatch — open invoice (U-132)', () => {
  beforeEach(async () => { await cleanDb(); await setup(); });
  afterEach(async () => { await cleanDb(); });

  it('a feed amount above the balance applies the cent balance; the rest stays a credit', async () => {
    const { inv, stateId } = await stage('100.05');
    const result = await applyMatch(tenantId, stateId, 0, USER_ID);
    expect(result).toMatchObject({ kind: 'invoice', appliedAmount: '100.00', partial: false });
    const [paid] = await db.select().from(transactions).where(eq(transactions.id, inv.id));
    expect([paid!.balanceDue, paid!.invoiceStatus]).toEqual(['0.0000', 'paid']);
    const [payment] = await db.select().from(transactions).where(eq(transactions.id, result.appliedTransactionId));
    expect(payment!.total).toBe('100.0500');
    const apps = await db.select().from(paymentApplications).where(eq(paymentApplications.paymentId, payment!.id));
    expect(apps.map((a) => a.amount)).toEqual(['100.0000']);
  });

  it('a feed amount short of the balance is a partial payment, exact to the cent', async () => {
    const { inv, stateId } = await stage('99.99');
    const result = await applyMatch(tenantId, stateId, 0, USER_ID);
    expect(result).toMatchObject({ appliedAmount: '99.99', partial: true });
    const [partial] = await db.select().from(transactions).where(eq(transactions.id, inv.id));
    expect([partial!.balanceDue, partial!.invoiceStatus]).toEqual(['0.0100', 'partial']);
  });
});
