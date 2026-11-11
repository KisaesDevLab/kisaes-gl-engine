// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

// U-212 (ClientLedger P28, report-1099-paid-v1): 1099 Preparation and the
// 1099 Summary by box count the same payments, the cash paid in the
// calendar year. Guards:
//   - a vendor paid by check (Write Checks, and a 'check' transaction),
//     by expense, and by bill + bill payment: total_paid, reportable_total,
//     the Summary row and the 1099 Center's per-box totals agree;
//   - a bill counts when it is paid, not at its bill date: an unpaid bill
//     is not counted, a prior-year bill paid this year counts this year, a
//     bill paid across two years splits by the cash of each year;
//   - a vendor credit applied or an early-payment discount taken is not
//     cash and is not counted;
//   - a partial payment over two boxes is whole cents and adds up to its
//     cash; a bill paid in full gives each box back exactly;
//   - thresholds follow the cash: $300 + $300 over two years meets in
//     neither, an unpaid $600 bill does not meet;
//   - the threshold follows the year paid: $600 through 2025, $2,000 from
//     2026 (One Big Beautiful Bill Act), royalties $10.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import DecimalLib from 'decimal.js';
import { db } from '../db/index.js';
import {
  tenants, users, sessions, accounts, companies, auditLog, contacts, transactions, journalLines,
  billPaymentApplications, vendorCreditApplications, vendor1099AccountMappings,
} from '../db/schema/index.js';
import * as accountsService from './accounts.service.js';
import * as billService from './bill.service.js';
import * as vendorCreditService from './vendor-credit.service.js';
import * as billPaymentService from './bill-payment.service.js';
import * as checkService from './check.service.js';
import * as ledger from './ledger.service.js';
import { buildAp1099Prep } from './ap-report.service.js';
import { buildVendor1099SummaryByBox } from './vendor-1099-summary.service.js';
import { ytdTotalsByBox, ytdTotalsByBoxExact } from './portal-1099.service.js';
import { boxThreshold, general1099Threshold } from './portal-1099.boxes.js';
import { DESKTOP_CAPABILITIES } from '../desktop/capabilities.js';

const Decimal = DecimalLib.default || DecimalLib;
const D = (x: unknown) => new Decimal(String(x ?? 0));

let tenantId = '';
const ids: Record<string, string> = {};

async function cleanDb() {
  if (!tenantId) return;
  await db.delete(billPaymentApplications).where(eq(billPaymentApplications.tenantId, tenantId));
  await db.delete(vendorCreditApplications).where(eq(vendorCreditApplications.tenantId, tenantId));
  await db.delete(vendor1099AccountMappings).where(eq(vendor1099AccountMappings.tenantId, tenantId));
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

async function vendor(name: string) {
  const [v] = await db.insert(contacts).values({
    tenantId, contactType: 'vendor', displayName: name, is1099Eligible: true,
  } as typeof contacts.$inferInsert).returning();
  return v!.id;
}

const bill = (contactId: string, txnDate: string, lines: Array<{ accountId: string; amount: string }>) =>
  billService.createBill(tenantId, { contactId, txnDate, lines });

const pay = (txnDate: string, bills: Array<{ billId: string; amount: string; discountAmount?: string }>,
  extra: Record<string, unknown> = {}) =>
  billPaymentService.payBills(tenantId, {
    bankAccountId: ids['bank']!, txnDate, method: 'check', printLater: true, bills, ...extra,
  } as Parameters<typeof billPaymentService.payBills>[1]);

async function reports(year: number) {
  const prep = await buildAp1099Prep(tenantId, year, null, { exactAmounts: true });
  const summary = await buildVendor1099SummaryByBox(tenantId, year, null);
  const center = await ytdTotalsByBox(tenantId, year);
  return { prep, summary, center };
}

function prepRow(r: Awaited<ReturnType<typeof reports>>, contactId: string) {
  return r.prep.data.find((x) => x.contact_id === contactId)!;
}
function summaryRow(r: Awaited<ReturnType<typeof reports>>, contactId: string) {
  return r.summary.rows.find((x) => x.contactId === contactId);
}

beforeAll(async () => {
  await cleanDb();
  const [tenant] = await db.insert(tenants).values({ name: 'U-212 1099 paid', slug: 'u212-1099-' + Date.now() }).returning();
  tenantId = tenant!.id;
  const bank = await accountsService.create(tenantId, { name: 'Operating Cash', accountType: 'asset', accountNumber: '1000' });
  await db.insert(accounts).values({
    tenantId, name: 'Accounts Payable', accountType: 'liability', accountNumber: '2000', systemTag: 'accounts_payable', isSystem: true,
  });
  const labor = await accountsService.create(tenantId, { name: 'Contract Labor', accountType: 'expense', accountNumber: '6110' });
  const rent = await accountsService.create(tenantId, { name: 'Rent', accountType: 'expense', accountNumber: '6120' });
  const office = await accountsService.create(tenantId, { name: 'Office Supplies', accountType: 'expense', accountNumber: '6130' });
  const discounts = await accountsService.create(tenantId, { name: 'Purchase Discounts', accountType: 'revenue', accountNumber: '4900' });
  Object.assign(ids, { bank: bank.id, labor: labor.id, rent: rent.id, office: office.id, discounts: discounts.id });
  await db.insert(vendor1099AccountMappings).values([
    { tenantId, accountId: labor.id, formBox: 'NEC-1' },
    { tenantId, accountId: rent.id, formBox: 'MISC-1' },
  ]);

  // By check: Write Checks (an expense with is_check) and a 'check' transaction.
  ids['byCheck'] = await vendor('Ann Checks');
  await checkService.createCheck(tenantId, {
    bankAccountId: bank.id, contactId: ids['byCheck'], payeeNameOnCheck: 'Ann Checks', txnDate: '2026-03-01',
    amount: '700.00', printLater: true, lines: [{ accountId: labor.id, amount: '700.00' }],
  });
  await ledger.postTransaction(tenantId, {
    txnType: 'check', txnDate: '2026-03-02', contactId: ids['byCheck'], total: '50.00', memo: 'Check',
    lines: [
      { accountId: labor.id, debit: '50.00', credit: '0' },
      { accountId: bank.id, debit: '0', credit: '50.00' },
    ],
  } as unknown as Parameters<typeof ledger.postTransaction>[1]);

  // By expense: one mapped line and one unmapped line.
  ids['byExpense'] = await vendor('Ben Expense');
  await ledger.postTransaction(tenantId, {
    txnType: 'expense', txnDate: '2026-06-01', contactId: ids['byExpense'], total: '150.00', memo: 'Paid',
    lines: [
      { accountId: labor.id, debit: '100.00', credit: '0' },
      { accountId: office.id, debit: '50.00', credit: '0' },
      { accountId: bank.id, debit: '0', credit: '150.00' },
    ],
  });

  // By bill + bill payment.
  ids['byBill'] = await vendor('Cy Bills');
  const paidInYear = await bill(ids['byBill'], '2026-02-01', [{ accountId: labor.id, amount: '1000.00' }]);
  await pay('2026-02-15', [{ billId: paidInYear.id, amount: '1000.00' }]);
  const priorYear = await bill(ids['byBill'], '2025-12-10', [{ accountId: labor.id, amount: '400.00' }]);
  await pay('2026-01-05', [{ billId: priorYear.id, amount: '400.00' }]);
  await bill(ids['byBill'], '2026-11-01', [{ accountId: labor.id, amount: '500.00' }]); // unpaid
  const splitYears = await bill(ids['byBill'], '2026-12-01', [{ accountId: labor.id, amount: '300.00' }]);
  await pay('2026-12-20', [{ billId: splitYears.id, amount: '100.00' }]);
  await pay('2027-01-10', [{ billId: splitYears.id, amount: '200.00' }]);

  // Threshold: $600 paid $300 in 2025 and $300 in 2026.
  ids['split'] = await vendor('Di Split');
  const half = await bill(ids['split'], '2025-12-01', [{ accountId: labor.id, amount: '600.00' }]);
  await pay('2025-12-15', [{ billId: half.id, amount: '300.00' }]);
  await pay('2026-01-15', [{ billId: half.id, amount: '300.00' }]);

  // Threshold: an unpaid $600 bill.
  ids['unpaid'] = await vendor('Ed Unpaid');
  await bill(ids['unpaid'], '2026-04-01', [{ accountId: labor.id, amount: '600.00' }]);

  // A vendor credit and an early-payment discount: only the cash counts.
  ids['credit'] = await vendor('Flo Credit');
  const big = await bill(ids['credit'], '2026-05-01', [{ accountId: labor.id, amount: '1000.00' }]);
  const credit = await vendorCreditService.createVendorCredit(tenantId, {
    contactId: ids['credit'], txnDate: '2026-05-02', lines: [{ accountId: labor.id, amount: '100.00' }],
  });
  await pay('2026-05-20', [{ billId: big.id, amount: '980.00', discountAmount: '20.00' }], {
    credits: [{ creditId: credit.id, billId: big.id, amount: '100.00' }], discountAccountId: discounts.id,
  });

  // Year thresholds: $600.00 in 2025 meets; in 2026 $1,999.99 does not and
  // $2,000.00 does; royalties stay at $10.
  const exp = async (contactId: string, txnDate: string, accountId: string, amount: string) =>
    ledger.postTransaction(tenantId, {
      txnType: 'expense', txnDate, contactId, total: amount, memo: 'Paid',
      lines: [
        { accountId, debit: amount, credit: '0' },
        { accountId: bank.id, debit: '0', credit: amount },
      ],
    });
  const royalties = await accountsService.create(tenantId, { name: 'Royalties', accountType: 'expense', accountNumber: '6140' });
  await db.insert(vendor1099AccountMappings).values({ tenantId, accountId: royalties.id, formBox: 'MISC-2' });
  ids['near'] = await vendor('Hal Near');
  await exp(ids['near'], '2025-03-01', labor.id, '600.00');
  await exp(ids['near'], '2026-03-01', labor.id, '1999.99');
  ids['at'] = await vendor('Ivy At');
  await exp(ids['at'], '2026-03-01', labor.id, '2000.00');
  ids['royal'] = await vendor('Jo Royalty');
  await exp(ids['royal'], '2026-03-01', royalties.id, '10.00');

  // A voided bill payment is no payment; the bill's later payment still counts.
  ids['voided'] = await vendor('Kim Voided');
  const vb = await bill(ids['voided'], '2026-08-01', [{ accountId: labor.id, amount: '800.00' }]);
  const first = await pay('2026-08-10', [{ billId: vb.id, amount: '300.00' }]);
  await billPaymentService.voidBillPayment(tenantId, first.payments[0]!.id, 'test');
  await pay('2026-08-20', [{ billId: vb.id, amount: '500.00' }]);

  // Two boxes, a partial payment that does not divide evenly, rest next year.
  ids['cents'] = await vendor('Gus Cents');
  const odd = await bill(ids['cents'], '2026-07-01', [
    { accountId: labor.id, amount: '33.33' },
    { accountId: rent.id, amount: '66.67' },
  ]);
  await pay('2026-07-15', [{ billId: odd.id, amount: '50.00' }]);
  await pay('2027-02-01', [{ billId: odd.id, amount: '50.00' }]);
}, 60000);

afterAll(async () => {
  await cleanDb();
});

describe('1099 Preparation and Summary count the same payments (U-212)', () => {
  it('is advertised', () => {
    expect(DESKTOP_CAPABILITIES).toContain('report-1099-paid-v1');
  });

  it('a vendor paid by check: Write Checks and a check transaction count in both', async () => {
    const r = await reports(2026);
    const p = prepRow(r, ids['byCheck']!);
    expect(p.total_paidExact).toBe('750.0000');
    expect(p.reportable_totalExact).toBe('750.0000');
    expect(summaryRow(r, ids['byCheck']!)).toMatchObject({ boxes: { 'NEC-1': '750.0000' }, totalExact: '750.0000', meetsThreshold: false });
  });

  it('a vendor paid by expense: the mapped part is the 1099 amount', async () => {
    const r = await reports(2026);
    const p = prepRow(r, ids['byExpense']!);
    expect(p.total_paidExact).toBe('150.0000');
    expect(p.reportable_totalExact).toBe('100.0000');
    expect(summaryRow(r, ids['byExpense']!)!.totalExact).toBe('100.0000');
  });

  it('a vendor paid by bill and bill payment: counted when paid, never the bill itself', async () => {
    const r26 = await reports(2026);
    // 1000 paid in the year + 400 of a 2025 bill + 100 of a bill finished in
    // 2027; the unpaid 500 bill is not counted.
    const p = prepRow(r26, ids['byBill']!);
    expect(p.total_paidExact).toBe('1500.0000');
    expect(p.reportable_totalExact).toBe('1500.0000');
    expect(summaryRow(r26, ids['byBill']!)!.boxes).toEqual({ 'NEC-1': '1500.0000' });
    const r25 = await reports(2025);
    expect(summaryRow(r25, ids['byBill']!)).toBeUndefined();
    expect(D(prepRow(r25, ids['byBill']!).total_paidExact).isZero()).toBe(true);
    const r27 = await reports(2027);
    expect(summaryRow(r27, ids['byBill']!)!.totalExact).toBe('200.0000');
    expect(prepRow(r27, ids['byBill']!).total_paidExact).toBe('200.0000');
  });

  it('a vendor credit applied and a discount taken are not payments', async () => {
    const r = await reports(2026);
    const p = prepRow(r, ids['credit']!);
    expect(p.total_paidExact).toBe('880.0000');
    expect(p.reportable_totalExact).toBe('880.0000');
    expect(summaryRow(r, ids['credit']!)!.totalExact).toBe('880.0000');
  });

  it('a voided bill payment drops out of both reports', async () => {
    const r = await reports(2026);
    const p = prepRow(r, ids['voided']!);
    expect([p.total_paidExact, p.reportable_totalExact]).toEqual(['500.0000', '500.0000']);
    expect(summaryRow(r, ids['voided']!)!.totalExact).toBe('500.0000');
  });

  it('a partial payment over two boxes is whole cents and adds up to its cash; the bill comes back exactly', async () => {
    const r26 = await reports(2026);
    const s26 = summaryRow(r26, ids['cents']!)!;
    expect(s26.boxes).toEqual({ 'NEC-1': '16.6700', 'MISC-1': '33.3300' });
    expect(prepRow(r26, ids['cents']!).total_paidExact).toBe('50.0000');
    expect(prepRow(r26, ids['cents']!).reportable_totalExact).toBe('50.0000');
    const s27 = summaryRow(await reports(2027), ids['cents']!)!;
    expect(D(s26.boxes['NEC-1']).plus(D(s27.boxes['NEC-1'])).eq(D('33.33'))).toBe(true);
    expect(D(s26.boxes['MISC-1']).plus(D(s27.boxes['MISC-1'])).eq(D('66.67'))).toBe(true);
    expect(D(s27.totalExact).eq(D('50.00'))).toBe(true);
  });

  it('thresholds follow the cash paid in the year', async () => {
    for (const year of [2025, 2026]) {
      const r = await reports(year);
      const p = prepRow(r, ids['split']!);
      expect(p.total_paidExact, String(year)).toBe('300.0000');
      expect(p.reportable_totalExact, String(year)).toBe('300.0000');
      expect(p.reportable_meets_threshold, String(year)).toBe(false);
      expect(p.over_threshold, String(year)).toBe(false);
      expect(summaryRow(r, ids['split']!)!.meetsThreshold, String(year)).toBe(false);
    }
    const r = await reports(2026);
    const u = prepRow(r, ids['unpaid']!);
    expect(D(u.reportable_totalExact).isZero()).toBe(true);
    expect(u.reportable_meets_threshold).toBe(false);
    expect(summaryRow(r, ids['unpaid']!)).toBeUndefined();
  });

  it('the threshold depends on the year paid: $600 through 2025, $2,000 from 2026', async () => {
    const r25 = await reports(2025);
    const n25 = prepRow(r25, ids['near']!);
    expect([n25.reportable_totalExact, n25.reportable_meets_threshold, n25.over_threshold]).toEqual(['600.0000', true, true]);
    expect(summaryRow(r25, ids['near']!)!.meetsThreshold).toBe(true);
    expect(r25.summary.boxCatalog.find((b) => b.box === 'NEC-1')!.thresholdExact).toBe('600.0000');

    const r26 = await reports(2026);
    const n26 = prepRow(r26, ids['near']!);
    expect([n26.reportable_totalExact, n26.reportable_meets_threshold, n26.over_threshold]).toEqual(['1999.9900', false, false]);
    expect(summaryRow(r26, ids['near']!)!.meetsThreshold).toBe(false);
    const at = prepRow(r26, ids['at']!);
    expect([at.reportable_meets_threshold, at.over_threshold]).toEqual([true, true]);
    expect(summaryRow(r26, ids['at']!)!.meetsThreshold).toBe(true);
    expect(summaryRow(r26, ids['royal']!)!.meetsThreshold).toBe(true);
    expect(prepRow(r26, ids['royal']!).reportable_meets_threshold).toBe(true);
    const cat = Object.fromEntries(r26.summary.boxCatalog.map((b) => [b.box, b.thresholdExact]));
    expect(cat).toMatchObject({ 'NEC-1': '2000.0000', 'MISC-1': '2000.0000', 'MISC-2': '10.0000', 'MISC-10': '600.0000' });
  });

  it('threshold table: one row per indexed year', () => {
    expect(general1099Threshold(2024)).toBe('600.00');
    expect(general1099Threshold(2025)).toBe('600.00');
    expect(general1099Threshold(2026)).toBe('2000.00');
    expect(boxThreshold('NEC-1', 2025)).toBe('600.00');
    expect(boxThreshold('NEC-1', 2026)).toBe('2000.00');
    expect(boxThreshold('MISC-2', 2026)).toBe('10.00');
  });

  it('every vendor: Summary, Preparation and the 1099 Center agree per vendor and per box', async () => {
    for (const year of [2025, 2026, 2027]) {
      const r = await reports(year);
      for (const row of r.summary.rows) {
        const p = prepRow(r, row.contactId);
        expect(D(p.reportable_totalExact).eq(D(row.totalExact)), row.name).toBe(true);
        expect(p.reportable_meets_threshold, row.name).toBe(row.meetsThreshold);
      }
      expect(D(r.prep.totalReportableExact).eq(D(r.summary.totalsExact.total))).toBe(true);
      const exact = await ytdTotalsByBoxExact(tenantId, year);
      for (const b of exact.filter((x) => D(x.total).gt(0))) {
        expect(summaryRow(r, b.contactId)!.boxes[b.formBox], `${year} ${b.formBox}`).toBe(D(b.total).toFixed(4));
      }
      expect(r.center.length).toBe(r.summary.rows.reduce((n, x) => n + Object.keys(x.boxes).length, 0));
      // Vendors paid only from mapped accounts: every payment is a 1099 amount.
      for (const v of ['byCheck', 'byBill', 'split', 'credit', 'cents', 'voided', 'near', 'at', 'royal']) {
        const p = prepRow(r, ids[v]!);
        expect(D(p.total_paidExact).eq(D(p.reportable_totalExact)), `${year} ${v}`).toBe(true);
      }
    }
  });
});
