// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.
//
// U-209 (ClientLedger P28 QA-6): the cash virtual ledger pro-rates a partly
// settled document to the cent. Every scaled line has at most 2 decimals,
// the lines of one settlement foot to what it settled, every transaction of
// the virtual ledger balances, a fully settled document gives every line
// back exactly, and Sales Tax Payable moves as the cash sales tax report
// rounds it (round(tax x running paid / total) differences).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import { ReportDecimal as Decimal } from './report-exact.js';
import { db } from '../db/index.js';
import {
  tenants, users, sessions, accounts, companies, auditLog, contacts,
  transactions, journalLines, paymentApplications, billPaymentApplications,
} from '../db/schema/index.js';
import * as ledger from './ledger.service.js';
import * as reportService from './report.service.js';

let tenantId: string;
let cash: any, ar: any, ap: any, rev: any, rev2: any, tax: any, plants: any, repairs: any, disc: any;

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
    tenantId, name, accountNumber, accountType, detailType, isSystem: !!systemTag, systemTag,
  }).returning();
  return a!;
}

async function post(txnType: string, date: string, lines: Array<{ accountId: string; debit: string; credit: string }>, extra: Record<string, unknown> = {}) {
  return ledger.postTransaction(tenantId, { txnType: txnType as any, txnDate: date, memo: txnType, lines, ...extra } as any);
}

type VLine = { account_id: string; transaction_id: string; txn_date: string; debit: string; credit: string };

async function virtualLedger(start: string | null, end: string): Promise<VLine[]> {
  const r = await reportService.executeCashBasis(sql`
    WITH ${reportService.cashBasisLinesWith(tenantId, start, end, null)}
    SELECT account_id, transaction_id, txn_date::text AS txn_date, debit::text AS debit, credit::text AS credit FROM cb_lines`);
  return r.rows as unknown as VLine[];
}

const net = (l: VLine) => new Decimal(l.debit).minus(l.credit);
const sumFor = (lines: VLine[], pred: (l: VLine) => boolean) =>
  lines.filter(pred).reduce((s, l) => s.plus(net(l)), new Decimal(0));

function expectCentsAndBalanced(lines: VLine[]) {
  for (const l of lines) {
    expect(new Decimal(l.debit).decimalPlaces(), `debit ${l.debit}`).toBeLessThanOrEqual(2);
    expect(new Decimal(l.credit).decimalPlaces(), `credit ${l.credit}`).toBeLessThanOrEqual(2);
  }
  const byTxn = new Map<string, InstanceType<typeof Decimal>>();
  for (const l of lines) byTxn.set(l.transaction_id, (byTxn.get(l.transaction_id) ?? new Decimal(0)).plus(net(l)));
  for (const [id, n] of byTxn) expect(n.toFixed(4), `transaction ${id} balances`).toBe('0.0000');
}

beforeEach(async () => {
  await cleanDb();
  const [t] = await db.insert(tenants).values({ name: 'CBC', slug: `cbc-${Date.now()}` }).returning();
  tenantId = t!.id;
  cash = await mk('Checking', 'asset', '1000', 'checking');
  ar = await mk('Accounts Receivable', 'asset', '1200', 'accounts_receivable', 'accounts_receivable');
  ap = await mk('Accounts Payable', 'liability', '2000', 'accounts_payable', 'accounts_payable');
  tax = await mk('Sales Tax Payable', 'liability', '2200', 'other_current_liability', 'sales_tax_payable');
  rev = await mk('Plant sales', 'revenue', '4000', 'service');
  rev2 = await mk('Design fees', 'revenue', '4100', 'service');
  plants = await mk('Plants', 'cogs', '5100', 'supplies_materials');
  repairs = await mk('Repairs and Maintenance', 'expense', '6350', 'repairs_maintenance');
  disc = await mk('Purchase discounts', 'other_revenue', '7000', 'other_miscellaneous_income');
});

afterEach(async () => {
  await cleanDb();
});

describe('cash basis pro-rates to the cent (U-209)', () => {
  it('a partly paid bill: lines in cents that foot to the payment; fully paid gives each line back', async () => {
    // The P28 story's B2: 2,300.60 = Plants 2,215.60 + Repairs 85.00, paid 1,000.00 in December.
    const bill = await post('bill', '2026-11-20', [
      { accountId: plants.id, debit: '2215.60', credit: '0' },
      { accountId: repairs.id, debit: '85.00', credit: '0' },
      { accountId: ap.id, debit: '0', credit: '2300.60' },
    ], { total: '2300.60' });
    const p1 = await post('bill_payment', '2026-12-02', [
      { accountId: ap.id, debit: '1000.00', credit: '0' },
      { accountId: cash.id, debit: '0', credit: '1000.00' },
    ], { total: '1000.00' });
    await db.insert(billPaymentApplications).values({ tenantId, paymentId: p1.id, billId: bill.id, amount: '1000.00' });

    const dec = await virtualLedger('2026-12-01', '2026-12-31');
    expectCentsAndBalanced(dec);
    const decPlants = sumFor(dec, (l) => l.account_id === plants.id);
    const decRepairs = sumFor(dec, (l) => l.account_id === repairs.id);
    expect(decPlants.toFixed(4)).toBe('963.0500');
    expect(decRepairs.toFixed(4)).toBe('36.9500');

    // The P&L cell and its exact value carry the same cents.
    const pl = await reportService.buildProfitAndLoss(tenantId, '2026-12-01', '2026-12-31', 'cash', null, null, null, { exactAmounts: true });
    const plantsRow = pl.cogs.find((r) => r.accountId === plants.id)!;
    expect(new Decimal(plantsRow.amountExact!).toFixed(4)).toBe('963.0500');
    expect(plantsRow.amount).toBe(963.05);
    const repairsRow = pl.expenses.find((r) => r.accountId === repairs.id)!;
    expect(new Decimal(repairsRow.amountExact!).toFixed(4)).toBe('36.9500');

    // The rest paid in January (2,300.60 - 1,000.00 less a 0.60 discount).
    const p2 = await post('bill_payment', '2027-01-10', [
      { accountId: ap.id, debit: '1300.60', credit: '0' },
      { accountId: cash.id, debit: '0', credit: '1300.00' },
      { accountId: disc.id, debit: '0', credit: '0.60' },
    ], { total: '1300.00' });
    await db.insert(billPaymentApplications).values({ tenantId, paymentId: p2.id, billId: bill.id, amount: '1300.00', discountAmount: '0.60' });

    const all = await virtualLedger(null, '2027-12-31');
    expectCentsAndBalanced(all);
    expect(sumFor(all, (l) => l.account_id === plants.id).toFixed(4)).toBe('2215.6000');
    expect(sumFor(all, (l) => l.account_id === repairs.id).toFixed(4)).toBe('85.0000');
    // The December period reads the same cents as the whole history up to it.
    const toDec = await virtualLedger(null, '2026-12-31');
    expect(sumFor(toDec, (l) => l.account_id === plants.id).toFixed(4)).toBe('963.0500');
  });

  it('an invoice with tax paid in three parts: cents, footing, and tax as the sales tax report rounds it', async () => {
    // 107.00 = Plant sales 61.00 + Design fees 39.00 + tax 7.00
    const inv = await post('invoice', '2026-10-01', [
      { accountId: ar.id, debit: '107.00', credit: '0' },
      { accountId: rev.id, debit: '0', credit: '61.00' },
      { accountId: rev2.id, debit: '0', credit: '39.00' },
      { accountId: tax.id, debit: '0', credit: '7.00' },
    ], { total: '107.00' });
    const parts: Array<[string, string]> = [['2026-10-10', '33.33'], ['2026-11-10', '33.33'], ['2026-12-10', '40.34']];
    const payIds: string[] = [];
    for (const [d, amt] of parts) {
      const p = await post('customer_payment', d, [
        { accountId: cash.id, debit: amt, credit: '0' },
        { accountId: ar.id, debit: '0', credit: amt },
      ], { total: amt });
      await db.insert(paymentApplications).values({ tenantId, paymentId: p.id, invoiceId: inv.id, amount: amt });
      payIds.push(p.id);
    }
    const all = await virtualLedger(null, '2026-12-31');
    expectCentsAndBalanced(all);

    // Tax per payment: round(7 x paid-to-date / 107) differences.
    let prev = new Decimal(0);
    let paid = new Decimal(0);
    for (const [i, [, amt]] of parts.entries()) {
      paid = paid.plus(amt);
      const cum = new Decimal(7).times(paid).div(107).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
      const want = cum.minus(prev);
      prev = cum;
      const got = sumFor(all, (l) => l.transaction_id === payIds[i] && l.account_id === tax.id).negated();
      expect(got.toFixed(4), `tax on payment ${i + 1}`).toBe(want.toFixed(4));
      // Income + tax of this payment = the payment.
      const income = sumFor(all, (l) => l.transaction_id === payIds[i] && [rev.id, rev2.id, tax.id].includes(l.account_id)).negated();
      expect(income.toFixed(4)).toBe(new Decimal(amt).toFixed(4));
    }
    // Fully paid: every line back exactly.
    expect(sumFor(all, (l) => l.account_id === rev.id).negated().toFixed(4)).toBe('61.0000');
    expect(sumFor(all, (l) => l.account_id === rev2.id).negated().toFixed(4)).toBe('39.0000');
    expect(sumFor(all, (l) => l.account_id === tax.id).negated().toFixed(4)).toBe('7.0000');
  });
});
