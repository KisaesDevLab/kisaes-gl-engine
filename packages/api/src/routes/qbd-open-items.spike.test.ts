// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.
//
// SPIKE (ClientLedger P31, not merged): QBD open items through "before
// conversion" history accounts (design a). Existing services only, no
// migration. History and opening-TB lines that QBD posted to A/R and A/P go
// to plain other-current accounts "Receivables before conversion" and
// "Payables before conversion"; each open item becomes a real document whose
// one line offsets to that account, so at the conversion date A/R and A/P
// hold exactly the open items and the history accounts are 0.00.
//
// Every imported document's only line is a balance-sheet account, so it
// must add 0.00 to the P&L on both bases at every step (receive, void,
// edit, apply, refund); the balance sheet must balance on both bases at
// every date checked.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'express-async-errors';
import { and, eq } from 'drizzle-orm';
import DecimalLib from 'decimal.js';
import { db } from '../db/index.js';
import {
  accounts, contacts, billPaymentApplications, vendorCreditApplications, inventoryMovements,
} from '../db/schema/index.js';
import { invoicesRouter } from './invoices.routes.js';
import { paymentsRouter } from './payments.routes.js';
import { creditMemosRouter } from './credit-memos.routes.js';
import { customerRefundsRouter } from './customer-refunds.routes.js';
import { transactionsRouter } from './transactions.routes.js';
import { billsRouter } from './bills.routes.js';
import { billPaymentsRouter } from './bill-payments.routes.js';
import { vendorCreditsRouter } from './vendor-credits.routes.js';
import { reportsRouter } from './reports.routes.js';
import { companyRouter } from './company.routes.js';
import { itemsRouter } from './items.routes.js';
import { inventoryRouter } from './inventory.routes.js';
import * as ledger from '../services/ledger.service.js';
import { arOpenItemsAsOf, ageOpenItems } from '../services/ar-open-items.js';
import { apOpenItemsAsOf } from '../services/ap-open-items.js';
import { getBalances } from '../services/contacts.service.js';
import { buildCustomerStatement } from '../services/customer-statement.service.js';
import * as apReport from '../services/ap-report.service.js';
import { Harness, type Co, key, accountBalance, contactAR, m2, txn } from './receivables.test-support.js';

const Decimal = DecimalLib.default || DecimalLib;
type Body = Record<string, any>;

const CONV = '2026-10-31';
const h = new Harness();
let c: Co;

interface World {
  recvHist: string; payHist: string; invHist: string; equity: string; revenue: string; expense: string; bank: string;
  ar: string; ap: string; custA: string; custB: string; vendor: string;
  inv1001: string; inv1002: string; cm7: string; pmtB: string; bill55: string; vc3: string;
}

beforeEach(async () => {
  h.extraCleanup = [async (tid) => {
    await db.delete(inventoryMovements).where(eq(inventoryMovements.tenantId, tid));
    await db.delete(billPaymentApplications).where(eq(billPaymentApplications.tenantId, tid));
    await db.delete(vendorCreditApplications).where(eq(vendorCreditApplications.tenantId, tid));
  }];
  await h.start([
    ['/api/v1/invoices', invoicesRouter], ['/api/v1/payments', paymentsRouter], ['/api/v1/credit-memos', creditMemosRouter],
    ['/api/v1/customer-refunds', customerRefundsRouter], ['/api/v1/transactions', transactionsRouter],
    ['/api/v1/bills', billsRouter], ['/api/v1/bill-payments', billPaymentsRouter], ['/api/v1/vendor-credits', vendorCreditsRouter],
    ['/api/v1/reports', reportsRouter], ['/api/v1/company', companyRouter], ['/api/v1/items', itemsRouter],
    ['/api/v1/inventory', inventoryRouter],
  ]);
  c = await h.company();
});
afterEach(async () => { await h.stop(); });

const req = async (method: string, p: string, body?: unknown) => {
  const r = await h.request(method, `/api/v1${p}`, c.token, body, method === 'GET' ? {} : { 'Idempotency-Key': key() });
  return r;
};
const ok = async (method: string, p: string, body?: unknown, status = [200, 201]) => {
  const r = await req(method, p, body);
  expect(status, `${method} ${p}: ${r.status} ${JSON.stringify(r.json)}`).toContain(r.status);
  return r.json;
};

async function account(name: string, accountType: string, detailType: string, accountNumber: string) {
  const [a] = await db.insert(accounts).values({ tenantId: c.tenantId, companyId: c.companyId, name, accountType, detailType, accountNumber }).returning();
  return a!.id;
}

async function je(date: string, lines: Array<[string, string, string]>) {
  return ledger.postTransaction(c.tenantId, {
    txnType: 'journal_entry', txnDate: date, memo: 'QBD history', source: 'quickbooks_desktop_import',
    lines: lines.map(([accountId, debit, credit]) => ({ accountId, debit, credit })),
  } as never, c.userId, c.companyId);
}

/**
 * The converted company. QBD history: opening TB 2025-12-31 A/R 300.00 (to
 * Receivables before conversion); 2026-06-15 sales 1,200.00; 2026-07-01
 * collected 200.00; 2026-06-20 purchases 800.00 on A/P (to Payables before
 * conversion). QBD A/R at the conversion date 1,300.00 = Open Invoices:
 * INV 1001 A 1,000.00, INV 1002 B 500.00, CM-7 A -100.00, unapplied payment
 * B -100.00. A/P 800.00 = Unpaid Bills: B-55 900.00, VC-3 -100.00.
 */
async function world(unapplied: 'credit_memo' | 'payment' = 'credit_memo'): Promise<World> {
  const w = {} as World;
  w.recvHist = await account('Receivables before conversion', 'asset', 'other_current_asset', '1290');
  w.payHist = await account('Payables before conversion', 'liability', 'other_current_liability', '2090');
  w.invHist = await account('Inventory before conversion', 'asset', 'other_current_asset', '1390');
  w.equity = await account('Opening balance (spike)', 'equity', 'opening_balance_equity', '3990');
  w.revenue = c.roles['income']!; w.expense = c.roles['expense']!; w.bank = c.roles['checking']!;
  w.ar = c.roles['accounts_receivable']!;
  w.ap = (await db.query.accounts.findFirst({ where: and(eq(accounts.tenantId, c.tenantId), eq(accounts.systemTag, 'accounts_payable')) }))!.id;
  w.custA = c.customer; w.custB = c.other;
  const [v] = await db.insert(contacts).values({ tenantId: c.tenantId, companyId: c.companyId, contactType: 'vendor', displayName: 'Cedar Supply' }).returning();
  w.vendor = v!.id;

  // History (journal entries, as the QBD adapter posts them, A/R and A/P lines re-pointed).
  await je('2025-12-31', [[w.recvHist, '300', '0'], [w.equity, '0', '300']]);
  await je('2026-06-15', [[w.recvHist, '1200', '0'], [w.revenue, '0', '1200']]);
  await je('2026-07-01', [[w.bank, '200', '0'], [w.recvHist, '0', '200']]);
  await je('2026-06-20', [[w.expense, '800', '0'], [w.payHist, '0', '800']]);

  // Open items as real documents, each with one line to the history account.
  const inv = async (contactId: string, number: string, date: string, due: string, amount: string) => String((await ok('POST', '/invoices', {
    contactId, txnDate: date, dueDate: due, txnNumber: number,
    lines: [{ accountId: w.recvHist, description: 'Open balance from QuickBooks', quantity: '1', unitPrice: amount, isTaxable: false }],
  })).invoice.id);
  w.inv1001 = await inv(w.custA, '1001', '2026-06-15', '2026-07-15', '1000.00');
  w.inv1002 = await inv(w.custB, '1002', '2026-09-20', '2026-10-20', '500.00');
  w.cm7 = String((await ok('POST', '/credit-memos', {
    contactId: w.custA, txnDate: '2026-08-01', txnNumber: 'CM-7',
    lines: [{ accountId: w.recvHist, description: 'Open credit from QuickBooks', quantity: '1', unitPrice: '100.00', isTaxable: false }],
  })).creditMemo.id);
  // QBD 'Payment' row with an open balance: as a credit memo (the plan's mapping of a negative open item) or as a customer payment.
  w.pmtB = unapplied === 'payment'
    ? String((await ok('POST', '/payments/receive', {
      customerId: w.custB, date: '2026-10-05', amount: '100.00', depositTo: w.recvHist, refNo: 'QBD-PMT-9', applications: [],
    })).payment?.id ?? '')
    : String((await ok('POST', '/credit-memos', {
      contactId: w.custB, txnDate: '2026-10-05', txnNumber: 'QBD-PMT-9',
      lines: [{ accountId: w.recvHist, description: 'Unapplied payment from QuickBooks', quantity: '1', unitPrice: '100.00', isTaxable: false }],
    })).creditMemo.id);
  w.bill55 = String((await ok('POST', '/bills', {
    contactId: w.vendor, txnDate: '2026-06-20', dueDate: '2026-07-20', vendorInvoiceNumber: 'B-55',
    lines: [{ accountId: w.payHist, amount: '900.00', description: 'Open balance from QuickBooks' }],
  })).bill.id);
  w.vc3 = String((await ok('POST', '/vendor-credits', {
    contactId: w.vendor, txnDate: '2026-09-01', vendorInvoiceNumber: 'VC-3',
    lines: [{ accountId: w.payHist, amount: '100.00', description: 'Open credit from QuickBooks' }],
  })).credit.id);
  return w;
}

const dec = (x: unknown) => new Decimal(String(x ?? '0'));

/** Exact balance sheet on a basis: totals, and that assets = liabilities + equity exactly. */
async function bs(asOf: string, basis: 'accrual' | 'cash') {
  const j = await ok('GET', `/reports/balance-sheet?exact=1&basis=${basis}&as_of_date=${asOf}`);
  const assets = dec(j.totalAssetsExact), liab = dec(j.totalLiabilitiesExact), eq_ = dec(j.totalEquityExact);
  const row = (id: string) => [...(j.assets ?? []), ...(j.liabilities ?? []), ...(j.equity ?? [])].find((r: Body) => r.accountId === id);
  return { assets, liab, equity: eq_, diff: assets.minus(liab).minus(eq_), row: (id: string) => (row(id) ? dec(row(id).balanceExact).toFixed(2) : '0.00') };
}

async function net(from: string, to: string, basis: 'accrual' | 'cash') {
  const j = await ok('GET', `/reports/profit-loss?exact=1&basis=${basis}&start_date=${from}&end_date=${to}`);
  return dec(j.netIncomeExact).toFixed(2);
}

/** Both bases balance on each date. */
async function expectBalanced(dates: string[]) {
  for (const d of dates) for (const b of ['accrual', 'cash'] as const) {
    const s = await bs(d, b);
    expect(s.diff.toFixed(4), `${b} balance sheet ${d}: A ${s.assets} L ${s.liab} E ${s.equity}`).toBe('0.0000');
  }
}

/** A/R invariants: ledger A/R = aging total exact = sum of statements' amountDue = sum of contact balances. */
async function arInvariants(w: World, asOf: string, expected: string) {
  expect(await accountBalance(c, w.ar, asOf), 'A/R ledger').toBe(expected);
  const items = await arOpenItemsAsOf(db, { tenantId: c.tenantId, companyId: c.companyId, asOf });
  const aging = ageOpenItems(items, asOf);
  expect(m2(aging.totalExact), 'A/R aging').toBe(expected);
  expect(aging.difference).toBe('0.00');
  let stmt = new Decimal(0);
  for (const cid of [w.custA, w.custB]) stmt = stmt.plus((await buildCustomerStatement(db, c.tenantId, c.companyId, { contactId: cid, asOf })).amountDue);
  expect(stmt.toFixed(2), 'statements').toBe(expected);
  const bal = await getBalances(c.tenantId, [w.custA, w.custB], c.companyId);
  const sumBal = [...bal.values()].reduce((s, b) => s.plus(b.openBalance), new Decimal(0));
  expect(sumBal.toFixed(2), 'contact balances').toBe(expected);
  return { items, perContact: { A: await contactAR(c, w.custA, asOf), B: await contactAR(c, w.custB, asOf) } };
}

async function apInvariants(w: World, asOf: string, expected: string) {
  expect(dec(await accountBalance(c, w.ap, asOf)).negated().toFixed(2), 'A/P ledger').toBe(expected);
  const items = await apOpenItemsAsOf(db, { tenantId: c.tenantId, companyId: c.companyId, asOf });
  expect(items.reduce((s, i) => s.plus(i.openExact), new Decimal(0)).toFixed(2), 'A/P open items').toBe(expected);
  const bal = await getBalances(c.tenantId, [w.vendor], c.companyId);
  expect(dec(bal.get(w.vendor)?.payableBalance).toFixed(2), 'vendor balance').toBe(expected);
  return items;
}

describe('SPIKE P31: QBD open items via before-conversion accounts', () => {
  it('C1 baseline at conversion: A/R and A/P equal the open items, history accounts 0.00, both bases balance, P&L = history', async () => {
    const w = await world();
    const r = await arInvariants(w, CONV, '1300.00');
    expect(r.perContact).toEqual({ A: '900.00', B: '400.00' });
    const apItems = await apInvariants(w, CONV, '800.00');
    expect(apItems.map((i) => `${i.txnType}:${m2(i.openExact)}`).sort()).toEqual(['bill:900.00', 'vendor_credit:-100.00']);
    // A/P aging summary (bills only by design of that report) and its vendor credit:
    const apAging = await apReport.buildApAgingSummary(c.tenantId, CONV, c.companyId, null, { exactAmounts: true }) as Body;
    // The legacy summary lists bills only (900.00); the exact as-of aging (?exact=1) includes the open vendor credit.
    expect(m2(apAging.totals?.total ?? apAging.totalsExact?.total)).toBe('900.00');
    const { buildApAgingAsOf } = await import('../services/open-balances.service.js');
    const exactAp = await buildApAgingAsOf(c.tenantId, CONV, c.companyId, null) as Body;
    expect(m2(exactAp.totalsExact.total), 'exact A/P aging').toBe('800.00');
    const exactAr = await ok('GET', `/reports/ar-aging-summary?exact=1&as_of_date=${CONV}`);
    console.log('[spike] C1 exact AR aging keys', Object.keys(exactAr).join(','), JSON.stringify(exactAr.totalsExact ?? exactAr.totalExact ?? exactAr.total));
    expect(await accountBalance(c, w.recvHist, CONV)).toBe('0.00');
    expect(await accountBalance(c, w.payHist, CONV)).toBe('0.00');
    await expectBalanced(['2025-12-31', '2026-06-30', '2026-09-30', CONV]);
    // P&L 2026 = history only (sales 1,200 - purchases 800), both bases.
    expect(await net('2026-01-01', CONV, 'accrual')).toBe('400.00');
    const cashNet = await net('2026-01-01', CONV, 'cash');
    const cashBs = await bs(CONV, 'cash');
    console.log('[spike] C1 cash net 2026', cashNet, 'cash recvHist', cashBs.row(w.recvHist), 'cash payHist', cashBs.row(w.payHist),
      'cash A/R', cashBs.row(w.ar), 'cash A/P', cashBs.row(w.ap));
    expect(cashNet).toBe('400.00');
  });

  it('C2 receive payment on an imported invoice (partial, then rest) and edit it: balanced, P&L unchanged', async () => {
    const w = await world();
    // Edit before payment: memo/description only, same amount; the line stays on the history account.
    const before = (await ok('GET', `/invoices/${w.inv1001}`)).invoice;
    await ok('PUT', `/invoices/${w.inv1001}`, {
      contactId: w.custA, txnDate: '2026-06-15', dueDate: '2026-07-15', txnNumber: '1001', memo: 'edited',
      lines: [{ accountId: w.recvHist, description: 'Open balance from QuickBooks (edited)', quantity: '1', unitPrice: '1000.00', isTaxable: false }],
      expectedUpdatedAt: before.updatedAt,
    });
    expect(await accountBalance(c, w.recvHist, CONV)).toBe('0.00');
    await ok('POST', '/payments/receive', { customerId: w.custA, date: '2026-11-10', amount: '400.00', depositTo: w.bank,
      applications: [{ invoiceId: w.inv1001, amount: '400.00' }] });
    await arInvariants(w, '2026-11-10', '900.00');
    // Edit after a partial payment: amount 1,000 -> 1,050 (QBD number corrected).
    const mid = (await ok('GET', `/invoices/${w.inv1001}`)).invoice;
    const edit = await req('PUT', `/invoices/${w.inv1001}`, {
      contactId: w.custA, txnDate: '2026-06-15', dueDate: '2026-07-15', txnNumber: '1001',
      lines: [{ accountId: w.recvHist, description: 'Open balance from QuickBooks', quantity: '1', unitPrice: '1050.00', isTaxable: false }],
      expectedUpdatedAt: mid.updatedAt,
    });
    console.log('[spike] C2 edit after partial payment', edit.status, edit.json?.error?.code ?? '');
    const editedAmount = edit.status === 200 ? '50.00' : '0.00';
    expect(m2(dec(await accountBalance(c, w.recvHist, CONV)).negated()), 'history account shows the edit').toBe(editedAmount);
    await ok('POST', '/payments/receive', { customerId: w.custA, date: '2026-11-20', amount: edit.status === 200 ? '650.00' : '600.00', depositTo: w.bank,
      applications: [{ invoiceId: w.inv1001, amount: edit.status === 200 ? '650.00' : '600.00' }] });
    expect(m2((await txn(w.inv1001)).balanceDue)).toBe('0.00');
    await arInvariants(w, '2026-11-30', '300.00');
    await expectBalanced([CONV, '2026-11-10', '2026-11-15', '2026-11-30']);
    expect(await net('2026-11-01', '2026-11-30', 'accrual')).toBe('0.00');
    expect(await net('2026-11-01', '2026-11-30', 'cash')).toBe('0.00');
    const cashBs = await bs('2026-11-30', 'cash');
    console.log('[spike] C2 cash recvHist 11-30', cashBs.row(w.recvHist), 'accrual recvHist', (await bs('2026-11-30', 'accrual')).row(w.recvHist));
  });

  it('C3 void an imported invoice: balanced, P&L unchanged, A/R = aging, history account nonzero (designed)', async () => {
    const w = await world();
    const inv = (await ok('GET', `/invoices/${w.inv1002}`)).invoice;
    await ok('POST', `/invoices/${w.inv1002}/void`, { reason: 'spike', expectedUpdatedAt: inv.updatedAt });
    await arInvariants(w, '2026-11-30', '800.00');
    expect(await accountBalance(c, w.recvHist, '2026-11-30')).toBe('500.00');
    await expectBalanced([CONV, '2026-11-30']);
    expect(await net('2026-01-01', '2026-11-30', 'accrual')).toBe('400.00');
    expect(await net('2026-01-01', '2026-11-30', 'cash')).toBe('400.00');
  });

  it('C4 apply an imported credit memo and an imported unapplied payment: balanced, P&L unchanged', async () => {
    const w = await world();
    await ok('POST', `/credit-memos/${w.cm7}/apply`, { date: '2026-11-05', applications: [{ invoiceId: w.inv1001, amount: '100.00' }] });
    await ok('POST', `/credit-memos/${w.pmtB}/apply`, { date: '2026-11-06', applications: [{ invoiceId: w.inv1002, amount: '100.00' }] });
    expect(m2((await txn(w.inv1001)).balanceDue)).toBe('900.00');
    expect(m2((await txn(w.inv1002)).balanceDue)).toBe('400.00');
    const r = await arInvariants(w, '2026-11-30', '1300.00');
    expect(r.items.map((i) => `${i.txnType}:${i.open}`).sort()).toEqual(['invoice:400.00', 'invoice:900.00']);
    await expectBalanced([CONV, '2026-11-05', '2026-11-30']);
    expect(await net('2026-11-01', '2026-11-30', 'accrual')).toBe('0.00');
    expect(await net('2026-11-01', '2026-11-30', 'cash')).toBe('0.00');
    expect(await net('2026-01-01', '2026-11-30', 'cash')).toBe('400.00');
  });

  it('C5 refund an imported credit memo and an imported unapplied payment: balanced, P&L unchanged', async () => {
    const w = await world();
    const r1 = await ok('POST', '/customer-refunds', { sourceId: w.cm7, txnDate: '2026-11-05', contactId: w.custA, amount: '100.00',
      paymentMethod: 'check', refundFromAccountId: w.bank });
    expect(r1.transaction.id).toBeTruthy();
    const r2 = await req('POST', '/customer-refunds', { sourceId: w.pmtB, txnDate: '2026-11-06', contactId: w.custB, amount: '100.00',
      paymentMethod: 'check', refundFromAccountId: w.bank });
    console.log('[spike] C5 refund of unapplied payment', r2.status, r2.json?.error?.code ?? '');
    const expected = r2.status === 201 ? '1500.00' : '1400.00';
    await arInvariants(w, '2026-11-30', expected);
    await expectBalanced([CONV, '2026-11-05', '2026-11-30']);
    expect(await net('2026-11-01', '2026-11-30', 'accrual')).toBe('0.00');
    expect(await net('2026-11-01', '2026-11-30', 'cash')).toBe('0.00');
  });

  it('C6 pay an imported bill with an imported vendor credit and cash, void the payment, void the bill: balanced, P&L unchanged', async () => {
    const w = await world();
    const p = await ok('POST', '/bill-payments', { bankAccountId: w.bank, txnDate: '2026-11-04', method: 'check', printLater: true,
      bills: [{ billId: w.bill55, amount: '600.00' }], credits: [{ creditId: w.vc3, billId: w.bill55, amount: '100.00' }] });
    const payId = String(p.payments[0].id);
    expect(m2((await txn(w.bill55)).balanceDue)).toBe('300.00');
    await apInvariants(w, '2026-11-04', '300.00');
    await expectBalanced([CONV, '2026-11-04']);
    expect(await net('2026-11-01', '2026-11-30', 'accrual')).toBe('0.00');
    expect(await net('2026-11-01', '2026-11-30', 'cash')).toBe('0.00');
    // Credits only (no cash) on the rest is covered by the vendor credit leg above; now the rest in cash on a later date.
    await ok('POST', `/bill-payments/${payId}/void`, { reason: 'spike' });
    await apInvariants(w, '2026-11-10', '800.00');
    await expectBalanced(['2026-11-10']);
    const b = (await ok('GET', `/bills/${w.bill55}`)).bill;
    await ok('POST', `/bills/${w.bill55}/void`, { reason: 'spike', expectedUpdatedAt: b.updatedAt });
    await apInvariants(w, '2026-11-30', '-100.00');
    expect(dec(await accountBalance(c, w.payHist, '2026-11-30')).negated().toFixed(2), 'history account shows the void').toBe('900.00');
    await expectBalanced(['2026-11-30']);
    expect(await net('2026-11-01', '2026-11-30', 'accrual')).toBe('0.00');
    expect(await net('2026-11-01', '2026-11-30', 'cash')).toBe('0.00');
  });

  it('C7 credits-only bill settlement: imported vendor credit alone pays part of the imported bill', async () => {
    const w = await world();
    const p = await req('POST', '/bill-payments', { bankAccountId: w.bank, txnDate: '2026-11-04', method: 'check', printLater: true,
      bills: [{ billId: w.bill55, amount: '100.00' }], credits: [{ creditId: w.vc3, billId: w.bill55, amount: '100.00' }] });
    console.log('[spike] C7 credits-only', p.status, p.json?.error?.code ?? '');
    expect([200, 201]).toContain(p.status);
    await apInvariants(w, '2026-11-04', '800.00');
    await expectBalanced(['2026-11-04']);
    expect(await net('2026-11-01', '2026-11-30', 'cash')).toBe('0.00');
  });

  it('C8 inventory opening: exact total value with a non-inventory offset nets to zero against history', async () => {
    const w = await world();
    await ok('PUT', '/company/settings', { inventoryEnabled: true });
    const [asset] = await db.select().from(accounts).where(and(eq(accounts.tenantId, c.tenantId), eq(accounts.systemTag, 'inventory_asset')));
    const [cogs] = await db.select().from(accounts).where(and(eq(accounts.tenantId, c.tenantId), eq(accounts.accountType, 'cogs'), eq(accounts.isActive, true)));
    const item = await ok('POST', '/items', { name: 'Widget', itemType: 'inventory_part', unitPrice: '50.00', incomeAccountId: w.revenue,
      assetAccountId: asset!.id, cogsAccountId: cogs!.id });
    // QBD history put 100.00 on Inventory Asset; re-pointed to the history account.
    await je('2026-05-01', [[w.invHist, '100', '0'], [w.bank, '0', '100']]);
    // Inventory Valuation Summary at conversion: 3 units, 100.00 (does not divide).
    await ok('POST', '/inventory/adjustments', { txnDate: CONV, adjustmentAccountId: w.invHist, memo: 'Opening stock from QuickBooks',
      lines: [{ itemId: item.item.id, quantityChange: '3', valueChange: '100.00' }] });
    expect(await accountBalance(c, asset!.id, CONV)).toBe('100.00');
    expect(await accountBalance(c, w.invHist, CONV)).toBe('0.00');
    const mv = await db.select().from(inventoryMovements).where(eq(inventoryMovements.tenantId, c.tenantId));
    console.log('[spike] C8 movements', JSON.stringify(mv.map((m) => ({ q: (m as Body)['quantity'], v: (m as Body)['value'] ?? (m as Body)['totalCost'] }))));
    await expectBalanced([CONV]);
    expect(await net('2026-01-01', CONV, 'accrual')).toBe('400.00');
    expect(await net('2026-01-01', CONV, 'cash')).toBe('400.00');
    // Refused: the adjustment account can not be an inventory asset account.
    const bad = await req('POST', '/inventory/adjustments', { txnDate: CONV, adjustmentAccountId: asset!.id,
      lines: [{ itemId: item.item.id, quantityChange: '1', valueChange: '1.00' }] });
    expect([bad.status, bad.json?.error?.code]).toEqual([400, 'VALIDATION_ERROR']);
  });

  it('C9 FINDING: an unapplied payment imported as a customer payment puts cash-basis income at its date and takes it back when applied', async () => {
    const w = await world('payment');
    await arInvariants(w, CONV, '1300.00');
    await expectBalanced([CONV]);
    expect(await net('2026-01-01', CONV, 'accrual')).toBe('400.00');
    // U-152: cash basis books an unapplied customer payment's A/R leg as Unapplied receipts income.
    expect(await net('2026-01-01', CONV, 'cash')).toBe('500.00');
    await ok('POST', `/payments/${w.pmtB}/apply`, { date: '2026-11-06', applications: [{ invoiceId: w.inv1002, amount: '100.00' }] });
    await expectBalanced(['2026-11-30']);
    expect(await net('2026-11-01', '2026-11-30', 'accrual')).toBe('0.00');
    expect(await net('2026-11-01', '2026-11-30', 'cash')).toBe('-100.00');
    expect(await net('2026-01-01', '2026-11-30', 'cash')).toBe('400.00');
  });
});