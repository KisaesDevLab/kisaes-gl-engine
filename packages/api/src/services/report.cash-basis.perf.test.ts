// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// Cash-basis report performance (U-155). A company with a few hundred
// transactions of every kind the virtual ledger rewrites (invoices with
// sales tax, partial and full payments with discounts and write-offs,
// credit memos applied and refunded, credits applied later, customer
// deposits, bounced payments, bills paid with an early-payment discount,
// sales tax payments, cash sales) must run the cash Balance Sheet and P&L
// in well under the bound below. Before the fix these took tens of seconds.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  tenants, users, sessions, accounts, companies, auditLog, contacts,
  transactions, journalLines, paymentApplications, billPaymentApplications,
} from '../db/schema/index.js';
import * as ledger from './ledger.service.js';
import * as reportService from './report.service.js';

let tenantId = '';
const CYCLES = 40;
// Generous: the fixed queries take well under 1 s on a laptop at this size.
const BOUND_MS = 5000;

async function cleanDb() {
  if (!tenantId) return;
  await db.delete(paymentApplications).where(eq(paymentApplications.tenantId, tenantId));
  await db.delete(billPaymentApplications).where(eq(billPaymentApplications.tenantId, tenantId));
  await db.delete(journalLines).where(eq(journalLines.tenantId, tenantId));
  await db.delete(transactions).where(eq(transactions.tenantId, tenantId));
  await db.delete(auditLog).where(eq(auditLog.tenantId, tenantId));
  await db.delete(contacts).where(eq(contacts.tenantId, tenantId));
  await db.delete(accounts).where(eq(accounts.tenantId, tenantId));
  await db.delete(companies).where(eq(companies.tenantId, tenantId));
  await db.delete(sessions).where(
    inArray(sessions.userId, db.select({ id: users.id }).from(users).where(eq(users.tenantId, tenantId))),
  );
  await db.delete(users).where(eq(users.tenantId, tenantId));
  await db.delete(tenants).where(eq(tenants.id, tenantId));
  tenantId = '';
}

async function mk(name: string, accountType: string, accountNumber: string, detailType: string | null, systemTag: string | null = null) {
  const [a] = await db.insert(accounts).values({
    tenantId, name, accountNumber, accountType, detailType,
    isSystem: !!systemTag, systemTag,
  }).returning();
  return a!;
}

type Line = { accountId: string; debit: string; credit: string };
async function post(txnType: string, date: string, lines: Line[], extra: Record<string, unknown> = {}) {
  return ledger.postTransaction(tenantId, {
    txnType: txnType as any, txnDate: date, memo: txnType, lines, ...extra,
  } as any);
}

function day(i: number, offset: number): string {
  // Spread over Jan..Oct 2026.
  const d = new Date(Date.UTC(2026, 0, 1 + ((i * 7 + offset) % 290)));
  return d.toISOString().slice(0, 10);
}

let txnCount = 0;

beforeAll(async () => {
  const [t] = await db.insert(tenants).values({ name: 'CB perf', slug: `cb-perf-${Date.now()}` }).returning();
  tenantId = t!.id;
  const cash = await mk('Checking', 'asset', '1000', 'checking');
  const ar = await mk('Accounts Receivable', 'asset', '10200', 'accounts_receivable', 'accounts_receivable');
  const ap = await mk('Accounts Payable', 'liability', '20100', 'accounts_payable', 'accounts_payable');
  const rev = await mk('Sales', 'revenue', '4000', 'service');
  const tax = await mk('Sales Tax Payable', 'liability', '20900', 'other_current_liability', 'sales_tax_payable');
  const dep = await mk('Customer Deposits', 'liability', '20950', 'other_current_liability', 'customer_deposits');
  const exp = await mk('Supplies', 'expense', '6000', 'office_expenses');
  const disc = await mk('Discounts Given', 'revenue', '4900', 'discounts_refunds_given');
  const discTaken = await mk('Discounts Taken', 'revenue', '4950', 'other_miscellaneous_income');
  const bad = await mk('Bad Debt', 'expense', '6900', 'bad_debts');
  await mk('Unapplied receipts', 'revenue', '49900', 'service', 'unapplied_receipts');

  const n = async (p: Promise<any>) => { txnCount++; return p; };

  for (let i = 0; i < CYCLES; i++) {
    // Invoice with sales tax: 1,080 = 1,000 + 80.
    const inv = await n(post('invoice', day(i, 0), [
      { accountId: ar.id, debit: '1080', credit: '0' },
      { accountId: rev.id, debit: '0', credit: '1000' },
      { accountId: tax.id, debit: '0', credit: '80' },
    ], { total: '1080' }));
    // Partial payment.
    const p1 = await n(post('customer_payment', day(i, 10), [
      { accountId: cash.id, debit: '500', credit: '0' },
      { accountId: ar.id, debit: '0', credit: '500' },
    ], { total: '500' }));
    await db.insert(paymentApplications).values({ tenantId, paymentId: p1.id, invoiceId: inv.id, amount: '500' });
    // Final payment with an early-payment discount and a write-off.
    const p2 = await n(post('customer_payment', day(i, 20), [
      { accountId: cash.id, debit: '560', credit: '0' },
      { accountId: disc.id, debit: '10', credit: '0' },
      { accountId: bad.id, debit: '10', credit: '0' },
      { accountId: ar.id, debit: '0', credit: '580' },
    ], { total: '560' }));
    await db.insert(paymentApplications).values({
      tenantId, paymentId: p2.id, invoiceId: inv.id, amount: '560',
      discountAmount: '10', discountAccountId: disc.id, writeOffAmount: '10', writeOffAccountId: bad.id,
    });

    // Second invoice, a credit memo applied to it, an overpayment whose
    // credit is applied later.
    const inv2 = await n(post('invoice', day(i, 3), [
      { accountId: ar.id, debit: '540', credit: '0' },
      { accountId: rev.id, debit: '0', credit: '500' },
      { accountId: tax.id, debit: '0', credit: '40' },
    ], { total: '540' }));
    const cm = await n(post('credit_memo', day(i, 5), [
      { accountId: rev.id, debit: '100', credit: '0' },
      { accountId: tax.id, debit: '8', credit: '0' },
      { accountId: ar.id, debit: '0', credit: '108' },
    ], { total: '108' }));
    await db.insert(paymentApplications).values({ tenantId, paymentId: cm.id, invoiceId: inv2.id, amount: '108' });
    const p3 = await n(post('customer_payment', day(i, 15), [
      { accountId: cash.id, debit: '500', credit: '0' },
      { accountId: ar.id, debit: '0', credit: '500' },
    ], { total: '500' }));
    await db.insert(paymentApplications).values({ tenantId, paymentId: p3.id, invoiceId: inv2.id, amount: '400' });
    await db.insert(paymentApplications).values({
      tenantId, paymentId: p3.id, invoiceId: inv2.id, amount: '32', appliedDate: day(i, 25),
    });

    // Customer deposit held, then a cash sale.
    await n(post('customer_payment', day(i, 2), [
      { accountId: cash.id, debit: '200', credit: '0' },
      { accountId: dep.id, debit: '0', credit: '200' },
    ], { total: '200', holdsDeposit: true }));
    await n(post('cash_sale', day(i, 4), [
      { accountId: cash.id, debit: '108', credit: '0' },
      { accountId: rev.id, debit: '0', credit: '100' },
      { accountId: tax.id, debit: '0', credit: '8' },
    ], { total: '108' }));

    // Bill paid with an early-payment discount.
    const bill = await n(post('bill', day(i, 1), [
      { accountId: exp.id, debit: '500', credit: '0' },
      { accountId: ap.id, debit: '0', credit: '500' },
    ], { total: '500' }));
    const bp = await n(post('bill_payment', day(i, 9), [
      { accountId: ap.id, debit: '500', credit: '0' },
      { accountId: cash.id, debit: '0', credit: '490' },
      { accountId: discTaken.id, debit: '0', credit: '10' },
    ], { total: '490' }));
    await db.insert(billPaymentApplications).values({ tenantId, paymentId: bp.id, billId: bill.id, amount: '490', discountAmount: '10' });

    // Sales tax payment.
    await n(post('sales_tax_payment', day(i, 30), [
      { accountId: tax.id, debit: '50', credit: '0' },
      { accountId: cash.id, debit: '0', credit: '50' },
    ], { total: '50' }));

    // Every 5th cycle: refund part of the credit memo; every 8th: bounce p1.
    if (i % 5 === 0) {
      await n(post('customer_refund', day(i, 12), [
        { accountId: ar.id, debit: '54', credit: '0' },
        { accountId: cash.id, debit: '0', credit: '54' },
      ], { total: '54', sourcePaymentId: cm.id }));
    }
    if (i % 8 === 0) {
      const rp = await n(post('returned_payment', day(i, 14), [
        { accountId: ar.id, debit: '500', credit: '0' },
        { accountId: cash.id, debit: '0', credit: '500' },
      ], { total: '500', sourceTxnId: p1.id }));
      await db.update(paymentApplications).set({ reversedByTxnId: rp.id })
        .where(eq(paymentApplications.paymentId, p1.id));
    }
  }
  if (process.env.PERF_ANALYZE) await db.execute(sql`ANALYZE transactions, journal_lines, accounts, payment_applications, bill_payment_applications, transaction_tax_lines`);
}, 600_000);

afterAll(async () => {
  await cleanDb();
});

async function timed<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const t0 = performance.now();
  const r = await fn();
  return [r, performance.now() - t0];
}

describe('cash-basis report performance (U-155)', () => {
  it('seeds a few hundred transactions', () => {
    expect(txnCount).toBeGreaterThanOrEqual(400);
  });

  // P&L first: the Balance Sheet also builds a P&L, and a long first query
  // lets autoanalyze run and hide the cold cost of the second one.
  it('cash Profit and Loss runs within the bound', async () => {
    const [pl, ms] = await timed(() => reportService.buildProfitAndLoss(tenantId, '2026-01-01', '2026-10-31', 'cash'));
    // eslint-disable-next-line no-console
    console.log(`[perf] cash profit and loss: ${ms.toFixed(0)} ms (${txnCount} txns)`);
    expect(ms).toBeLessThan(BOUND_MS);
    expect(pl.totalRevenue).toBeGreaterThan(0);
  }, 300_000);

  it('cash Balance Sheet runs within the bound and balances', async () => {
    const [bs, ms] = await timed(() => reportService.buildBalanceSheet(tenantId, '2026-10-31', 'cash'));
    // eslint-disable-next-line no-console
    console.log(`[perf] cash balance sheet: ${ms.toFixed(0)} ms (${txnCount} txns)`);
    expect(ms).toBeLessThan(BOUND_MS);
    expect(Math.abs(bs.totalAssets - bs.totalLiabilitiesAndEquity)).toBeLessThan(0.01);
  }, 300_000);
});
