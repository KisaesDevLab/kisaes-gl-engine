// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// The cash-basis engine (virtual ledger with payment allocation).
// Pins the QUESTIONS.md #10 redesign:
//   - invoice revenue is recognized at PAYMENT date, prorated across
//     the invoice's distribution lines (incl. sales tax)
//   - bill expenses recognized at bill-payment date
//   - both application link forms work (payment_applications and the
//     legacy transactions.applied_to_invoice_id)
//   - the cash BS balances by construction, AR/AP show only unapplied
//     payment remainders
//   - direct cash/card activity is identical on both bases

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { db } from '../db/index.js';
import {
  tenants, users, sessions, accounts, companies, auditLog, contacts,
  transactions, journalLines, tags, transactionTags,
  paymentApplications, billPaymentApplications,
} from '../db/schema/index.js';
import * as ledger from './ledger.service.js';
import * as reportService from './report.service.js';

let tenantId: string;
let cash: any, ar: any, ap: any, rev: any, tax: any, exp: any, cc: any;

async function cleanDb() {
  await db.delete(paymentApplications);
  await db.delete(billPaymentApplications);
  await db.delete(transactionTags);
  await db.delete(tags);
  await db.delete(journalLines);
  await db.delete(transactions);
  await db.delete(auditLog);
  await db.delete(contacts);
  await db.delete(accounts);
  await db.delete(companies);
  await db.delete(sessions);
  await db.delete(users);
  await db.delete(tenants);
}

async function mk(name: string, accountType: string, accountNumber: string, detailType: string | null, systemTag: string | null = null) {
  const [a] = await db.insert(accounts).values({
    tenantId, name, accountNumber, accountType, detailType,
    isSystem: !!systemTag, systemTag,
  }).returning();
  return a!;
}

async function post(txnType: string, date: string, lines: Array<{ accountId: string; debit: string; credit: string }>, extra: Record<string, unknown> = {}) {
  return ledger.postTransaction(tenantId, {
    txnType: txnType as any, txnDate: date, memo: txnType, lines, ...extra,
  } as any);
}

beforeEach(async () => {
  await cleanDb();
  const [t] = await db.insert(tenants).values({ name: 'CB', slug: `cb-${Date.now()}` }).returning();
  tenantId = t!.id;
  cash = await mk('Checking', 'asset', '1000', 'checking');
  ar = await mk('Accounts Receivable', 'asset', '10200', 'accounts_receivable', 'accounts_receivable');
  ap = await mk('Accounts Payable', 'liability', '20100', 'accounts_payable', 'accounts_payable');
  rev = await mk('Sales', 'revenue', '4000', 'service');
  tax = await mk('Sales Tax Payable', 'liability', '20900', 'other_current_liability', 'sales_tax_payable');
  exp = await mk('Supplies', 'expense', '6000', 'office_expenses');
  cc = await mk('Visa', 'liability', '20200', 'credit_card');
});

afterEach(async () => {
  await cleanDb();
});

describe('cash-basis P&L — AR recognition at payment date', () => {
  it('unpaid invoice shows no cash revenue; payment month recognizes it (prorated with tax)', async () => {
    // Nov invoice: $1,000 = revenue 900 + sales tax 100
    const invoice = await post('invoice', '2026-11-05', [
      { accountId: ar.id, debit: '1000', credit: '0' },
      { accountId: rev.id, debit: '0', credit: '900' },
      { accountId: tax.id, debit: '0', credit: '100' },
    ], { total: '1000' });
    // Dec payment of $500 via payment_applications
    const payment = await post('customer_payment', '2026-12-10', [
      { accountId: cash.id, debit: '500', credit: '0' },
      { accountId: ar.id, debit: '0', credit: '500' },
    ], { total: '500' });
    await db.insert(paymentApplications).values({ tenantId, paymentId: payment.id, invoiceId: invoice.id, amount: '500' });

    // Accrual November: full 900 revenue.
    const accNov = await reportService.buildProfitAndLoss(tenantId, '2026-11-01', '2026-11-30', 'accrual');
    expect(accNov.totalRevenue).toBeCloseTo(900, 2);
    // Cash November: nothing collected.
    const cashNov = await reportService.buildProfitAndLoss(tenantId, '2026-11-01', '2026-11-30', 'cash');
    expect(cashNov.totalRevenue).toBeCloseTo(0, 2);
    // Cash December: 500/1000 of the revenue line = 450.
    const cashDec = await reportService.buildProfitAndLoss(tenantId, '2026-12-01', '2026-12-31', 'cash');
    expect(cashDec.totalRevenue).toBeCloseTo(450, 2);
  });

  it('legacy applied_to_invoice_id payments recognize too', async () => {
    const invoice = await post('invoice', '2026-03-01', [
      { accountId: ar.id, debit: '1000', credit: '0' },
      { accountId: rev.id, debit: '0', credit: '1000' },
    ], { total: '1000' });
    await post('customer_payment', '2026-04-15', [
      { accountId: cash.id, debit: '1000', credit: '0' },
      { accountId: ar.id, debit: '0', credit: '1000' },
    ], { total: '1000', appliedToInvoiceId: invoice.id });

    const apr = await reportService.buildProfitAndLoss(tenantId, '2026-04-01', '2026-04-30', 'cash');
    expect(apr.totalRevenue).toBeCloseTo(1000, 2);
  });
});

describe('cash-basis P&L — AP recognition at bill-payment date', () => {
  it('unpaid bill shows no cash expense; payment month recognizes it', async () => {
    const bill = await post('bill', '2026-11-08', [
      { accountId: exp.id, debit: '500', credit: '0' },
      { accountId: ap.id, debit: '0', credit: '500' },
    ], { total: '500' });
    const payment = await post('bill_payment', '2026-12-20', [
      { accountId: ap.id, debit: '500', credit: '0' },
      { accountId: cash.id, debit: '0', credit: '500' },
    ], { total: '500' });
    await db.insert(billPaymentApplications).values({ tenantId, paymentId: payment.id, billId: bill.id, amount: '500' });

    const cashNov = await reportService.buildProfitAndLoss(tenantId, '2026-11-01', '2026-11-30', 'cash');
    expect(cashNov.totalExpenses).toBeCloseTo(0, 2);
    const cashDec = await reportService.buildProfitAndLoss(tenantId, '2026-12-01', '2026-12-31', 'cash');
    expect(cashDec.totalExpenses).toBeCloseTo(500, 2);
  });
});

describe('cash-basis Balance Sheet', () => {
  it('balances with AR eliminated; partial payments leave partial tax liability', async () => {
    const invoice = await post('invoice', '2026-11-05', [
      { accountId: ar.id, debit: '1000', credit: '0' },
      { accountId: rev.id, debit: '0', credit: '900' },
      { accountId: tax.id, debit: '0', credit: '100' },
    ], { total: '1000' });
    const payment = await post('customer_payment', '2026-12-10', [
      { accountId: cash.id, debit: '500', credit: '0' },
      { accountId: ar.id, debit: '0', credit: '500' },
    ], { total: '500' });
    await db.insert(paymentApplications).values({ tenantId, paymentId: payment.id, invoiceId: invoice.id, amount: '500' });

    const bs = await reportService.buildBalanceSheet(tenantId, '2026-12-31', 'cash');
    // Cash 500; AR fully eliminated (applied portion replaced, invoice excluded).
    expect(bs.totalAssets).toBeCloseTo(500, 2);
    const arRow = bs.assets.find((a: any) => a.accountId === ar.id);
    expect(arRow).toBeUndefined();
    // Liabilities: 50 sales tax (500/1000 of the 100 tax line).
    expect(bs.totalLiabilities).toBeCloseTo(50, 2);
    // Equity: 450 net income. Identity holds.
    expect(bs.totalEquity).toBeCloseTo(450, 2);
    expect(bs.totalAssets).toBeCloseTo(bs.totalLiabilities + bs.totalEquity, 2);
  });

  it('unapplied customer payment stays balanced (remainder on AR)', async () => {
    await post('customer_payment', '2026-12-10', [
      { accountId: cash.id, debit: '200', credit: '0' },
      { accountId: ar.id, debit: '0', credit: '200' },
    ], { total: '200' });
    const bs = await reportService.buildBalanceSheet(tenantId, '2026-12-31', 'cash');
    // Cash +200, AR −200 (customer pre-payment) → net assets 0 = L + E.
    expect(bs.totalAssets).toBeCloseTo(0, 2);
    expect(bs.totalAssets).toBeCloseTo(bs.totalLiabilities + bs.totalEquity, 2);
  });
});

describe('cash-basis pass-through', () => {
  it('direct expenses and card charges are identical on both bases', async () => {
    await post('expense', '2026-05-01', [
      { accountId: exp.id, debit: '120', credit: '0' },
      { accountId: cash.id, debit: '0', credit: '120' },
    ]);
    // Card-charged expense (liability credit card leg).
    await post('expense', '2026-05-02', [
      { accountId: exp.id, debit: '80', credit: '0' },
      { accountId: cc.id, debit: '0', credit: '80' },
    ]);
    const cashPl = await reportService.buildProfitAndLoss(tenantId, '2026-05-01', '2026-05-31', 'cash');
    const accPl = await reportService.buildProfitAndLoss(tenantId, '2026-05-01', '2026-05-31', 'accrual');
    expect(cashPl.totalExpenses).toBeCloseTo(200, 2);
    expect(accPl.totalExpenses).toBeCloseTo(200, 2);
  });
});

describe('per-transaction basis flag', () => {
  it('routes journal entries to the right basis; default both appears on both', async () => {
    // Accrual-only adjusting entry (e.g. depreciation) — must NOT hit cash.
    await post('journal_entry', '2026-07-10', [
      { accountId: exp.id, debit: '300', credit: '0' },
      { accountId: cash.id, debit: '0', credit: '300' },
    ], { basis: 'accrual' });
    // Cash-only entry — must NOT hit accrual.
    await post('journal_entry', '2026-07-11', [
      { accountId: exp.id, debit: '50', credit: '0' },
      { accountId: cash.id, debit: '0', credit: '50' },
    ], { basis: 'cash' });
    // Default (both) — appears on both bases.
    await post('journal_entry', '2026-07-12', [
      { accountId: exp.id, debit: '20', credit: '0' },
      { accountId: cash.id, debit: '0', credit: '20' },
    ]);

    const accrual = await reportService.buildProfitAndLoss(tenantId, '2026-07-01', '2026-07-31', 'accrual');
    // 300 (accrual-only) + 20 (both); the 50 cash-only entry is excluded.
    expect(accrual.totalExpenses).toBeCloseTo(320, 2);

    const cash_ = await reportService.buildProfitAndLoss(tenantId, '2026-07-01', '2026-07-31', 'cash');
    // 50 (cash-only) + 20 (both); the 300 accrual-only entry is excluded.
    expect(cash_.totalExpenses).toBeCloseTo(70, 2);
  });
});

describe('cash-basis — the newly-converted reports recognize at payment and tie', () => {
  it('Expenses by Category / Sales by Customer / Trial Balance / Transaction List follow cash recognition', async () => {
    // Bill in Nov ($400), paid Dec.
    const bill = await post('bill', '2026-11-08', [
      { accountId: exp.id, debit: '400', credit: '0' },
      { accountId: ap.id, debit: '0', credit: '400' },
    ], { total: '400' });
    const billPay = await post('bill_payment', '2026-12-20', [
      { accountId: ap.id, debit: '400', credit: '0' },
      { accountId: cash.id, debit: '0', credit: '400' },
    ]);
    await db.insert(billPaymentApplications).values({ tenantId, paymentId: billPay.id, billId: bill.id, amount: '400' });

    // Invoice in Nov ($1,000 revenue), paid Dec.
    const inv = await post('invoice', '2026-11-05', [
      { accountId: ar.id, debit: '1000', credit: '0' },
      { accountId: rev.id, debit: '0', credit: '1000' },
    ], { total: '1000' });
    const pay = await post('customer_payment', '2026-12-10', [
      { accountId: cash.id, debit: '1000', credit: '0' },
      { accountId: ar.id, debit: '0', credit: '1000' },
    ], { total: '1000' });
    await db.insert(paymentApplications).values({ tenantId, paymentId: pay.id, invoiceId: inv.id, amount: '1000' });

    // Expenses by Category — cash: nothing in Nov, $400 recognized in Dec.
    const ecNov = await reportService.buildExpenseByCategory(tenantId, '2026-11-01', '2026-11-30', null, null, null, false, 'cash') as unknown as { data: unknown[] };
    expect(ecNov.data.length).toBe(0);
    const ecDec = await reportService.buildExpenseByCategory(tenantId, '2026-12-01', '2026-12-31', null, null, null, false, 'cash') as unknown as { data: Array<{ total: string }> };
    expect(Number(ecDec.data[0]!.total)).toBeCloseTo(400, 2);

    // Sales by Customer — cash: $1,000 revenue recognized in Dec.
    const scDec = await reportService.buildSalesByCustomer(tenantId, '2026-12-01', '2026-12-31', null, null, 'cash') as unknown as { data: Array<{ total: string }> };
    expect(scDec.data.reduce((s, r) => s + Number(r.total), 0)).toBeCloseTo(1000, 2);

    // Trial Balance — cash: debits must equal credits (a balanced book).
    const tb = await reportService.buildTrialBalance(tenantId, '2026-01-01', '2026-12-31', null, null, 'cash');
    expect(tb.totalDebits).toBeCloseTo(tb.totalCredits, 2);

    // Transaction List — cash: the recognized lines land in Dec.
    const tl = await reportService.buildTransactionList(tenantId, { startDate: '2026-12-01', endDate: '2026-12-31', basis: 'cash' });
    expect(tl.data.length).toBeGreaterThan(0);
  });
});
