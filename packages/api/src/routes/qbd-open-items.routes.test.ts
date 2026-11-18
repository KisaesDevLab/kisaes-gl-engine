// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.
//
// QBD open items through "before conversion" accounts (U-264,
// qbd-open-items-v1; ClientLedger P31 E2a, design (a) of the P31 spike).
// A synthetic QuickBooks Desktop conversion (chart, customers, vendors,
// trial balance, journal, Open Invoices, Unpaid Bills Detail; Latin-1) is
// committed as one batch, at two history depths: an opening trial balance
// plus a year of journal, and a trial balance at the conversion date only.
// At the conversion date A/R and A/P hold exactly the open items (ledger,
// exact agings, statements, contact balances), both before-conversion
// accounts are 0.00, and the balance sheet balances on both bases. Undo
// restores the company exactly. The spike's flows (receive, apply, void, pay
// with a vendor credit) are regression checks on the imported documents.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'express-async-errors';
import { and, eq, sql } from 'drizzle-orm';
import DecimalLib from 'decimal.js';
import { db } from '../db/index.js';
import { accounts, contacts, companies, transactions, billPaymentApplications, vendorCreditApplications } from '../db/schema/index.js';
import { importsRouter } from './imports.routes.js';
import { invoicesRouter } from './invoices.routes.js';
import { paymentsRouter } from './payments.routes.js';
import { creditMemosRouter } from './credit-memos.routes.js';
import { billsRouter } from './bills.routes.js';
import { billPaymentsRouter } from './bill-payments.routes.js';
import { vendorCreditsRouter } from './vendor-credits.routes.js';
import { reportsRouter } from './reports.routes.js';
import * as importsService from '../services/imports/imports.service.js';
import * as batchService from '../services/imports/import-batch.service.js';
import { arOpenItemsAsOf, ageOpenItems } from '../services/ar-open-items.js';
import { apOpenItemsAsOf } from '../services/ap-open-items.js';
import { getBalances } from '../services/contacts.service.js';
import { buildCustomerStatement } from '../services/customer-statement.service.js';
import { buildApAgingAsOf } from '../services/open-balances.service.js';
import { DESKTOP_CAPABILITIES } from '../desktop/capabilities.js';
import { Harness, type Co, key, accountBalance, m2, txn } from './receivables.test-support.js';
import { companySnapshot, cleanImports, batchRow, stamped } from './imports-batch.test-support.js';

const Decimal = DecimalLib.default || DecimalLib;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Body = any;
const dec = (x: unknown) => new Decimal(String(x ?? '0'));

const CONV = '2026-10-31';
const h = new Harness();
let c: Co;

beforeEach(async () => {
  h.extraCleanup = [cleanImports, async (tid) => {
    await db.delete(billPaymentApplications).where(eq(billPaymentApplications.tenantId, tid));
    await db.delete(vendorCreditApplications).where(eq(vendorCreditApplications.tenantId, tid));
  }];
  await h.start([
    ['/api/v1/imports', importsRouter], ['/api/v1/invoices', invoicesRouter], ['/api/v1/payments', paymentsRouter],
    ['/api/v1/credit-memos', creditMemosRouter], ['/api/v1/bills', billsRouter], ['/api/v1/bill-payments', billPaymentsRouter],
    ['/api/v1/vendor-credits', vendorCreditsRouter], ['/api/v1/reports', reportsRouter],
  ]);
  c = await h.company();
});
afterEach(async () => { await h.stop(); });

// ── Synthetic QuickBooks Desktop files (Latin-1) ──────────────────

const COA = `,Account,Type,Balance Total,Description,Accnt. #,Tax Line
,"91010 · Checking",Bank,"1,500.00",,91010,
,"91200 · Accounts Receivable",Accounts Receivable,"1,350.00",,91200,
,"91250 · A/R - Retail",Accounts Receivable,500.00,Second A/R account,91250,
,"92000 · Accounts Payable",Accounts Payable,"1,050.00",,92000,
,"93000 · Opening Balance Equity",Equity,"-1,100.00",,93000,
,"94000 · Sales",Income,"2,250.00",,94000,
,"96000 · Supplies",Expense,"1,050.00",,96000,
`;

const CUSTOMERS = `,Active Status,Customer,Balance,Balance Total,Company,Main Phone
,Active,Alder Café,"1,400.00","1,400.00",Alder Café LLC,555-0101
,Active,Birch & Co,400.00,400.00,Birch & Co,555-0102
,Inactive,Dogwood Ltd,50.00,50.00,Dogwood Ltd,555-0104
`;

const VENDORS = `,Active Status,Vendor,Balance,Balance Total,Company,Main Phone
,Active,Cedar Supply,800.00,800.00,Cedar Supply Inc,555-0201
,Active,Birch & Co,250.00,250.00,Birch & Co,555-0102
`;

const TB_OPENING = `"Shoal Creek Outfitters (synthetic)"
"Trial Balance"
"As of December 31, 2025"
,Debit,Credit
"91010 · Checking","1,000.00",
"91200 · Accounts Receivable",300.00,
"92000 · Accounts Payable",,200.00
"93000 · Opening Balance Equity",,"1,100.00"
TOTAL,"1,300.00","1,300.00"
`;

/** At the conversion date only (the shallow history depth). */
const TB_AT_CONVERSION = `"Shoal Creek Outfitters (synthetic)"
"Trial Balance"
"As of October 31, 2026"
,Debit,Credit
"91010 · Checking","1,500.00",
"91200 · Accounts Receivable","1,350.00",
"91250 · A/R - Retail",500.00,
"92000 · Accounts Payable",,"1,050.00"
"93000 · Opening Balance Equity",,"2,300.00"
TOTAL,"3,350.00","3,350.00"
`;

const JOURNAL_2026 = `,Trans #,Type,Date,Num,Name,Memo,Account,Debit,Credit
,1,Invoice,06/15/2026,1001,Alder Café,,91200 · Accounts Receivable,"1,000.00",
,,,,,Alder Café,,94000 · Sales,,"1,000.00"
,,,,,,,,"1,000.00","1,000.00"
,2,Invoice,09/20/2026,1002,Birch & Co,,91250 · A/R - Retail,500.00,
,,,,,Birch & Co,,94000 · Sales,,500.00
,,,,,,,,500.00,500.00
,3,Payment,07/01/2026,,Alder Café,,91010 · Checking,300.00,
,,,,,Alder Café,,91200 · Accounts Receivable,,300.00
,,,,,,,,300.00,300.00
,4,Credit Memo,08/01/2026,CM-7,Alder Café,,94000 · Sales,100.00,
,,,,,Alder Café,,91200 · Accounts Receivable,,100.00
,,,,,,,,100.00,100.00
,5,Payment,10/05/2026,,Birch & Co,,91010 · Checking,100.00,
,,,,,Birch & Co,,91250 · A/R - Retail,,100.00
,,,,,,,,100.00,100.00
,6,Invoice,10/10/2026,1003,Alder Café,,91200 · Accounts Receivable,800.00,
,,,,,Alder Café,,94000 · Sales,,800.00
,,,,,,,,800.00,800.00
,7,Payment,10/20/2026,,Alder Café,,91010 · Checking,300.00,
,,,,,Alder Café,,91200 · Accounts Receivable,,300.00
,,,,,,,,300.00,300.00
,8,Invoice,05/01/2026,1004,Dogwood Ltd,,91200 · Accounts Receivable,50.00,
,,,,,Dogwood Ltd,,94000 · Sales,,50.00
,,,,,,,,50.00,50.00
,9,Bill,06/20/2026,B-55,Cedar Supply,,96000 · Supplies,900.00,
,,,,,Cedar Supply,,92000 · Accounts Payable,,900.00
,,,,,,,,900.00,900.00
,10,Bill Pmt -Check,07/15/2026,2001,Cedar Supply,,92000 · Accounts Payable,200.00,
,,,,,Cedar Supply,,91010 · Checking,,200.00
,,,,,,,,200.00,200.00
,11,Credit,09/01/2026,VC-3,Cedar Supply,,92000 · Accounts Payable,100.00,
,,,,,Cedar Supply,,96000 · Supplies,,100.00
,,,,,,,,100.00,100.00
,12,Bill,09/10/2026,B-60,Birch & Co,,96000 · Supplies,250.00,
,,,,,Birch & Co,,92000 · Accounts Payable,,250.00
,,,,,,,,250.00,250.00
TOTAL,,,,,,,,"4,600.00","4,600.00"
`;

/** QBD's default layout: grouped by customer, no Name column; a partly paid invoice (1003), a credit memo, an unapplied payment. */
const OPEN_INVOICES = `"Shoal Creek Outfitters (synthetic)"
"Open Invoices"
"As of October 31, 2026"
,,Type,Date,Num,P. O. #,Terms,Due Date,Aging,Amount,Open Balance
"Alder Café",,,,,,,,,,
,,Invoice,06/15/2026,1001,,Net 30,07/15/2026,108,"1,000.00","1,000.00"
,,Credit Memo,08/01/2026,CM-7,,,08/01/2026,,-100.00,-100.00
,,Invoice,10/10/2026,1003,,Net 30,11/09/2026,,800.00,500.00
"Total Alder Café",,,,,,,,,,"1,400.00"
"Birch & Co",,,,,,,,,,
,,Invoice,09/20/2026,1002,,Net 30,10/20/2026,11,500.00,500.00
,,Payment,10/05/2026,,,,10/05/2026,,-100.00,-100.00
"Total Birch & Co",,,,,,,,,,400.00
"Dogwood Ltd",,,,,,,,,,
,,Invoice,05/01/2026,1004,,Net 30,05/31/2026,153,50.00,50.00
"Total Dogwood Ltd",,,,,,,,,,50.00
TOTAL,,,,,,,,,,"1,850.00"
`;

const UNPAID_BILLS = `"Shoal Creek Outfitters (synthetic)"
"Unpaid Bills Detail"
"As of October 31, 2026"
,,Type,Date,Num,Due Date,Aging,Open Balance
"Birch & Co",,,,,,,
,,Bill,09/10/2026,B-60,10/10/2026,21,250.00
"Total Birch & Co",,,,,,,250.00
"Cedar Supply",,,,,,,
,,Bill,06/20/2026,B-55,07/20/2026,103,900.00
,,Credit,09/01/2026,VC-3,,,(100.00)
"Total Cedar Supply",,,,,,,800.00
TOTAL,,,,,,,"1,050.00"
`;

const EMPTY_UNPAID_BILLS = `"Shoal Creek Outfitters (synthetic)"
"Unpaid Bills Detail"
"As of October 31, 2026"
,,Type,Date,Num,Due Date,Aging,Open Balance
TOTAL,,,,,,,0.00
`;

type Kind = 'coa' | 'contacts' | 'trial_balance' | 'gl_transactions' | 'open_invoices' | 'unpaid_bills';

async function upload(name: string, text: string, kind: Kind, options: Record<string, unknown> = {}, sourceSystem = 'quickbooks_desktop', encoding: BufferEncoding = 'latin1') {
  return importsService.createSession({
    tenantId: c.tenantId, companyId: c.companyId, userId: c.userId,
    file: { originalname: name, buffer: Buffer.from(text, encoding) },
    kind, sourceSystem: sourceSystem as never, options: options as never,
  });
}

async function uploadId(name: string, text: string, kind: Kind, options: Record<string, unknown> = {}) {
  const out = await upload(name, text, kind, options);
  expect(out.validationErrors, `${name}: ${JSON.stringify(out.validationErrors)}`).toEqual([]);
  return out.session.id;
}

type Depth = 'journal' | 'tb-only';

async function uploadConversion(depth: Depth, opts: { unpaidBills?: string; openInvoices?: boolean } = {}) {
  const ids = [
    await uploadId('accounts.csv', COA, 'coa'),
    await uploadId('customers.csv', CUSTOMERS, 'contacts', { contactKind: 'customer' }),
    await uploadId('vendors.csv', VENDORS, 'contacts', { contactKind: 'vendor' }),
  ];
  if (depth === 'journal') {
    ids.push(await uploadId('tb-2025-12-31.csv', TB_OPENING, 'trial_balance'));
    ids.push(await uploadId('journal-2026.csv', JOURNAL_2026, 'gl_transactions'));
  } else {
    ids.push(await uploadId('tb-2026-10-31.csv', TB_AT_CONVERSION, 'trial_balance'));
  }
  if (opts.openInvoices !== false) ids.push(await uploadId('open-invoices.csv', OPEN_INVOICES, 'open_invoices'));
  if (opts.unpaidBills !== '') ids.push(await uploadId('unpaid-bills.csv', opts.unpaidBills ?? UNPAID_BILLS, 'unpaid_bills'));
  return ids;
}

async function commit(sessionIds: string[]) {
  const r = await h.request('POST', '/api/v1/imports/batches', c.token, {
    sourceSystem: 'quickbooks_desktop', kind: 'conversion', sessionIds, options: { conversionDate: CONV },
  });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  const id = String(r.json['batch'].id);
  const cm = await h.request('POST', `/api/v1/imports/batches/${id}/commit`, c.token, { backupRef: 'before-import.clb' }, { 'Idempotency-Key': key() });
  expect(cm.status, JSON.stringify(cm.json)).toBe(202);
  await batchService.__batchJobs.last;
  const b = await h.request('GET', `/api/v1/imports/batches/${id}`, c.token);
  expect(b.json['batch'].status, JSON.stringify(b.json)).toBe('committed');
  return { id, batch: b.json['batch'] as Body };
}

const req = (method: string, p: string, body?: unknown) =>
  h.request(method, `/api/v1${p}`, c.token, body, method === 'GET' ? {} : { 'Idempotency-Key': key() });
const ok = async (method: string, p: string, body?: unknown) => {
  const r = await req(method, p, body);
  expect([200, 201], `${method} ${p}: ${r.status} ${JSON.stringify(r.json)}`).toContain(r.status);
  return r.json as Body;
};

async function accountId(where: { systemTag?: string; name?: string }) {
  const [a] = await db.select().from(accounts).where(and(
    eq(accounts.tenantId, c.tenantId),
    where.systemTag ? eq(accounts.systemTag, where.systemTag) : eq(accounts.name, where.name!),
  ));
  return a?.id;
}

async function contactId(name: string, contactType: string) {
  const [x] = await db.select().from(contacts).where(and(eq(contacts.tenantId, c.tenantId), eq(contacts.displayName, name), eq(contacts.contactType, contactType)));
  return x!.id;
}

async function docs(batchId: string) {
  return db.select().from(transactions).where(and(eq(transactions.tenantId, c.tenantId), eq(transactions.importBatchId, batchId)));
}

async function bs(asOf: string, basis: 'accrual' | 'cash') {
  const j = await ok('GET', `/reports/balance-sheet?exact=1&basis=${basis}&as_of_date=${asOf}`);
  return dec(j.totalAssetsExact).minus(dec(j.totalLiabilitiesExact)).minus(dec(j.totalEquityExact)).toFixed(4);
}

async function net(from: string, to: string, basis: 'accrual' | 'cash') {
  return dec((await ok('GET', `/reports/profit-loss?exact=1&basis=${basis}&start_date=${from}&end_date=${to}`)).netIncomeExact).toFixed(2);
}

async function expectBalanced(dates: string[]) {
  for (const d of dates) for (const b of ['accrual', 'cash'] as const) expect(await bs(d, b), `${b} balance sheet ${d}`).toBe('0.0000');
}

/** A/R: ledger = exact aging = statements = contact balances = expected. */
async function arTies(asOf: string, expected: string, customers: string[]) {
  const ar = (await accountId({ systemTag: 'accounts_receivable' }))!;
  expect(await accountBalance(c, ar, asOf), 'A/R ledger').toBe(expected);
  const items = await arOpenItemsAsOf(db, { tenantId: c.tenantId, companyId: c.companyId, asOf });
  const aging = ageOpenItems(items, asOf);
  expect(m2(aging.totalExact), 'A/R aging').toBe(expected);
  expect(aging.difference).toBe('0.00');
  let stmt = new Decimal(0);
  for (const id of customers) stmt = stmt.plus((await buildCustomerStatement(db, c.tenantId, c.companyId, { contactId: id, asOf })).amountDue);
  expect(stmt.toFixed(2), 'statements').toBe(expected);
  const bal = await getBalances(c.tenantId, customers, c.companyId);
  expect([...bal.values()].reduce((s, b) => s.plus(b.openBalance), new Decimal(0)).toFixed(2), 'contact balances').toBe(expected);
  return items;
}

/** A/P: ledger (credit) = open items = exact aging = vendor balances = expected. */
async function apTies(asOf: string, expected: string, vendors: string[]) {
  const ap = (await accountId({ systemTag: 'accounts_payable' }))!;
  expect(dec(await accountBalance(c, ap, asOf)).negated().toFixed(2), 'A/P ledger').toBe(expected);
  const items = await apOpenItemsAsOf(db, { tenantId: c.tenantId, companyId: c.companyId, asOf });
  expect(items.reduce((s, i) => s.plus(i.openExact), new Decimal(0)).toFixed(2), 'A/P open items').toBe(expected);
  const aging = await buildApAgingAsOf(c.tenantId, asOf, c.companyId, null) as Body;
  expect(m2(aging.totalsExact.total), 'exact A/P aging').toBe(expected);
  const bal = await getBalances(c.tenantId, vendors, c.companyId);
  expect([...bal.values()].reduce((s, b) => s.plus(b.payableBalance ?? '0'), new Decimal(0)).toFixed(2), 'vendor balances').toBe(expected);
  return items;
}

async function historyBalances(asOf: string) {
  const ar = await accountId({ name: 'Receivables before conversion' });
  const ap = await accountId({ name: 'Payables before conversion' });
  return { ar: ar ? await accountBalance(c, ar, asOf) : null, ap: ap ? await accountBalance(c, ap, asOf) : null };
}

describe('U-264 capability and parser', () => {
  it('advertises qbd-open-items-v1', () => {
    expect(DESKTOP_CAPABILITIES).toContain('qbd-open-items-v1');
  });

  it('reads the QBD Open Invoices layout: group headings as names, Latin-1, as-of date, partly paid and Payment rows', async () => {
    const out = await upload('open-invoices.csv', OPEN_INVOICES, 'open_invoices');
    expect(out.validationErrors).toEqual([]);
    expect(out.session.reportDate).toBe(CONV);
    expect(out.preview.openTotal).toBe('1850.00');
    expect((out.preview.sampleRows as Body[]).map((r) => [r.name, r.sourceType, r.docType, r.number ?? null, r.openBalance, r.originalAmount ?? null, r.dueDate ?? null])).toEqual([
      ['Alder Café', 'Invoice', 'invoice', '1001', '1000.00', '1000.00', '2026-07-15'],
      ['Alder Café', 'Credit Memo', 'credit_memo', 'CM-7', '-100.00', '-100.00', '2026-08-01'],
      ['Alder Café', 'Invoice', 'invoice', '1003', '500.00', '800.00', '2026-11-09'],
      ['Birch & Co', 'Invoice', 'invoice', '1002', '500.00', '500.00', '2026-10-20'],
      ['Birch & Co', 'Payment', 'credit_memo', null, '-100.00', '-100.00', '2026-10-05'],
      ['Dogwood Ltd', 'Invoice', 'invoice', '1004', '50.00', '50.00', '2026-05-31'],
    ]);
    // Open-item sessions carry their date range (closed-period check before the 202).
    expect([out.session.dateFrom, out.session.dateTo]).toEqual(['2026-05-01', '2026-10-10']);
  });

  it('reads a Name column (Generic and QBO layouts); refuses unknown types, wrong signs and sub-cent balances by row; an empty report is valid', async () => {
    const generic = `Type,Date,Num,Name,Due Date,Amount,Open Balance
Invoice,2026-09-01,G-1,Generic Customer,2026-10-01,120.00,120.00
Credit Memo,2026-09-02,G-2,Generic Customer,,,-20.00
Estimate,2026-09-03,G-3,Generic Customer,,,10.00
Invoice,2026-09-04,G-4,Generic Customer,,,-10.00
Invoice,2026-09-05,G-5,Generic Customer,,,10.005
Invoice,2026-09-06,G-6,Generic Customer,,,0.00
`;
    const g = await upload('generic-open.csv', generic, 'open_invoices', { reportDate: CONV }, 'generic', 'utf8');
    expect(g.session.reportDate).toBe(CONV);
    expect((g.preview.sampleRows as Body[]).map((r) => `${r.number}:${r.docType}:${r.openBalance}`)).toEqual(['G-1:invoice:120.00', 'G-2:credit_memo:-20.00']);
    expect(g.validationErrors.map((e) => `${e.rowNumber}:${e.code}`)).toEqual(['4:IMPORT_UNKNOWN_TYPE', '5:IMPORT_OPEN_ITEM_SIGN', '6:IMPORT_OPEN_ITEM_CENTS']);

    const qbo = `Unpaid Bills
"As of October 31, 2026"
Date,Transaction Type,Num,Vendor,Due Date,Past Due,Amount,Open Balance
10/01/2026,Bill,Q-1,Online Vendor,10/31/2026,0,75.50,75.50
10/02/2026,Vendor Credit,Q-2,Online Vendor,,,-5.50,-5.50
`;
    const q = await upload('qbo-unpaid.csv', qbo, 'unpaid_bills', {}, 'quickbooks_online', 'utf8');
    expect(q.validationErrors).toEqual([]);
    expect(q.session.reportDate).toBe(CONV);
    expect((q.preview.sampleRows as Body[]).map((r) => `${r.name}:${r.docType}:${r.openBalance}`)).toEqual(['Online Vendor:bill:75.50', 'Online Vendor:vendor_credit:-5.50']);

    const empty = await upload('unpaid-empty.csv', EMPTY_UNPAID_BILLS, 'unpaid_bills');
    expect(empty.validationErrors).toEqual([]);
    expect(empty.preview.totalRows).toBe(0);
    expect(empty.session.reportDate).toBe(CONV);

    const wrong = await upload('not-a-report.csv', 'a,b,c\n1,2,3\n', 'open_invoices');
    expect(wrong.validationErrors.map((e) => e.code)).toEqual(['IMPORT_HEADER_NOT_FOUND']);
  });
});

describe.each<Depth>(['journal', 'tb-only'])('QBD conversion with open items, history depth %s (U-264)', (depth) => {
  it('A/R and A/P equal the open items exactly, both history accounts are 0.00, both bases balance; undo restores exactly', async () => {
    const before = await companySnapshot(c);
    const { id, batch } = await commit(await uploadConversion(depth));

    // Several QBD A/R accounts merged into the one system account (Q-P31k); no QBD A/R or A/P account was created.
    for (const n of ['91200', '91250', '92000']) {
      expect((await db.select().from(accounts).where(and(eq(accounts.tenantId, c.tenantId), eq(accounts.accountNumber, n)))).length, n).toBe(0);
    }
    const recvHist = await accountId({ name: 'Receivables before conversion' });
    const payHist = await accountId({ name: 'Payables before conversion' });
    expect(batch.result.historyAccounts).toEqual({ ar: recvHist, ap: payHist });
    expect(batch.result.redirectedAccountKeys).toEqual(['91200', '91250', '92000']);
    const [hist] = await db.select().from(accounts).where(eq(accounts.id, recvHist!));
    expect([hist!.accountType, hist!.detailType, hist!.systemTag, hist!.importBatchId]).toEqual(['asset', 'other_current_asset', null, id]);

    const sessions = batch.sessions as Body[];
    const oi = sessions.find((s) => s.kind === 'open_invoices')!.commitResult;
    expect(oi).toEqual({ created: 6, skipped: 0, documents: { invoice: 4, credit_memo: 2 }, contactsCreated: 1 });
    expect(sessions.find((s) => s.kind === 'unpaid_bills')!.commitResult)
      .toEqual({ created: 3, skipped: 0, documents: { bill: 2, vendor_credit: 1 } });
    expect(sessions.find((s) => s.kind === 'coa')!.commitResult.mergedIntoSystemAccounts).toBe(3);

    const alder = await contactId('Alder Café', 'customer');
    const birchC = await contactId('Birch & Co', 'customer');
    const dogwood = await contactId('Dogwood Ltd', 'customer');
    const birchV = await contactId('Birch & Co', 'vendor');
    const cedar = await contactId('Cedar Supply', 'vendor');
    // The inactive customer (left out of the list import) was created by the open items, stamped with the batch.
    expect((await db.select().from(contacts).where(eq(contacts.id, dogwood)))[0]!.importBatchId).toBe(id);

    const items = await arTies(CONV, '1850.00', [alder, birchC, dogwood]);
    expect(items.map((i) => `${i.txnType}:${m2(i.openExact)}`).sort()).toEqual([
      'credit_memo:-100.00', 'credit_memo:-100.00', 'invoice:1000.00', 'invoice:50.00', 'invoice:500.00', 'invoice:500.00',
    ]);
    const bal = await getBalances(c.tenantId, [alder, birchC, dogwood, birchV, cedar], c.companyId);
    expect([alder, birchC, dogwood].map((x) => m2(bal.get(x)?.openBalance))).toEqual(['1400.00', '400.00', '50.00']);
    // The customer that is also a vendor: the invoice on the customer, the bill on the vendor.
    expect([birchV, cedar].map((x) => m2(bal.get(x)?.payableBalance))).toEqual(['250.00', '800.00']);
    await apTies(CONV, '1050.00', [birchV, cedar]);
    expect(await historyBalances(CONV)).toEqual({ ar: '0.00', ap: '0.00' });
    await expectBalanced(depth === 'journal' ? ['2025-12-31', '2026-06-30', '2026-09-30', CONV] : [CONV]);
    if (depth === 'journal') {
      expect(await net('2026-01-01', CONV, 'accrual')).toBe('1200.00');
      expect(await net('2026-01-01', CONV, 'cash')).toBe('1200.00');
    }

    // The documents keep the QBD number, date and due date; the partly paid one its original amount in the memo.
    const all = await docs(id);
    const byNum = (n: string) => all.find((t) => t.txnType !== 'journal_entry' && (t.txnNumber === n || t.vendorInvoiceNumber === n))!;
    expect([byNum('1003').txnType, byNum('1003').txnDate, byNum('1003').dueDate, m2(byNum('1003').total)]).toEqual(['invoice', '2026-10-10', '2026-11-09', '500.00']);
    expect(byNum('1003').memo).toContain('original amount 800.00, open 500.00');
    expect([byNum('B-55').txnType, byNum('B-55').dueDate, m2(byNum('B-55').balanceDue)]).toEqual(['bill', '2026-07-20', '900.00']);
    expect(byNum('VC-3').txnType).toBe('vendor_credit');
    // The unapplied QBD payment is a credit memo, never a customer payment (spike C9).
    const pmt = all.filter((t) => t.txnType === 'credit_memo' && t.contactId === birchC);
    expect(pmt).toHaveLength(1);
    expect(pmt[0]!.memo).toContain('Payment');
    expect(all.some((t) => t.txnType === 'customer_payment')).toBe(false);

    // Undo: everything the batch made goes, the company is exactly as before (counters included).
    const u = await h.request('POST', `/api/v1/imports/batches/${id}/undo`, c.token, { backupRef: 'before-undo.clb' }, { 'Idempotency-Key': key() });
    expect(u.status, JSON.stringify(u.json)).toBe(202);
    await batchService.__batchJobs.last;
    expect((await batchRow(id)).status).toBe('undone');
    expect(await stamped(c, id)).toEqual({ accounts: 0, contacts: 0, transactions: 0, tags: 0 });
    expect(await companySnapshot(c)).toEqual(before);
  });

  it('regression (spike C2-C6) on the imported documents: receive, apply credits, void, pay a bill with a vendor credit', async () => {
    const { id } = await commit(await uploadConversion(depth));
    const all = await docs(id);
    const byNum = (n: string) => all.find((t) => t.txnType !== 'journal_entry' && (t.txnNumber === n || t.vendorInvoiceNumber === n))!.id;
    const alder = await contactId('Alder Café', 'customer');
    const birchC = await contactId('Birch & Co', 'customer');
    const dogwood = await contactId('Dogwood Ltd', 'customer');
    const birchV = await contactId('Birch & Co', 'vendor');
    const cedar = await contactId('Cedar Supply', 'vendor');
    const bank = c.roles['checking'];

    // Receive the rest of the partly paid invoice (500.00).
    await ok('POST', '/payments/receive', { customerId: alder, date: '2026-11-10', amount: '500.00', depositTo: bank,
      applications: [{ invoiceId: byNum('1003'), amount: '500.00' }] });
    expect(m2((await txn(byNum('1003'))).balanceDue)).toBe('0.00');
    // Apply the credit memo and the unapplied payment (a credit memo).
    await ok('POST', `/credit-memos/${byNum('CM-7')}/apply`, { date: '2026-11-11', applications: [{ invoiceId: byNum('1001'), amount: '100.00' }] });
    const pmt = all.find((t) => t.txnType === 'credit_memo' && t.contactId === birchC)!.id;
    await ok('POST', `/credit-memos/${pmt}/apply`, { date: '2026-11-12', applications: [{ invoiceId: byNum('1002'), amount: '100.00' }] });
    await arTies('2026-11-15', '1350.00', [alder, birchC, dogwood]);
    // Void an imported invoice: A/R and the aging drop; the history account shows it (the designed signal).
    const inv = (await ok('GET', `/invoices/${byNum('1004')}`)).invoice;
    await ok('POST', `/invoices/${byNum('1004')}/void`, { reason: 'test', expectedUpdatedAt: inv.updatedAt });
    await arTies('2026-11-20', '1300.00', [alder, birchC, dogwood]);
    expect((await historyBalances('2026-11-20')).ar).toBe('50.00');
    // Pay the imported bill with the imported vendor credit plus cash.
    await ok('POST', '/bill-payments', { bankAccountId: bank, txnDate: '2026-11-14', method: 'check', printLater: true,
      bills: [{ billId: byNum('B-55'), amount: '900.00' }], credits: [{ creditId: byNum('VC-3'), billId: byNum('B-55'), amount: '100.00' }] });
    await apTies('2026-11-20', '250.00', [birchV, cedar]);
    expect((await historyBalances('2026-11-20')).ap).toBe('0.00');
    await expectBalanced([CONV, '2026-11-10', '2026-11-14', '2026-11-30']);
    // The documents' only lines are balance-sheet lines: November adds nothing to the P&L on either basis.
    expect(await net('2026-11-01', '2026-11-30', 'accrual')).toBe('0.00');
    expect(await net('2026-11-01', '2026-11-30', 'cash')).toBe('0.00');
  });
});

async function commitFails(sessionIds: string[]) {
  const r = await h.request('POST', '/api/v1/imports/batches', c.token, { sourceSystem: 'quickbooks_desktop', kind: 'conversion', sessionIds });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  const id = String(r.json['batch'].id);
  const cm = await h.request('POST', `/api/v1/imports/batches/${id}/commit`, c.token, {}, { 'Idempotency-Key': key() });
  expect(cm.status, JSON.stringify(cm.json)).toBe(202);
  await batchService.__batchJobs.last;
  return batchRow(id);
}

async function undo(batchId: string) {
  const u = await h.request('POST', `/api/v1/imports/batches/${batchId}/undo`, c.token, {}, { 'Idempotency-Key': key() });
  expect(u.status, JSON.stringify(u.json)).toBe(202);
  await batchService.__batchJobs.last;
  expect((await batchRow(batchId)).status).toBe('undone');
}

describe('U-264 outer transaction, system tags and counters', () => {
  it('a failure after the open items posted rolls all of it back: documents, created contact, history account, claimed number', async () => {
    const before = await companySnapshot(c);
    const ids = await uploadConversion('journal');
    const oi = ids[ids.length - 2]!;
    batchService.__batchTestHooks.afterSession = ({ sessionId }) => {
      if (sessionId === oi) throw new Error('synthetic failure after the open invoices');
    };
    try {
      const b = await commitFails(ids);
      expect(b.status).toBe('failed');
      expect((b.error as Body).sessionId).toBe(oi);
    } finally {
      batchService.__batchTestHooks.afterSession = undefined;
    }
    expect(await companySnapshot(c)).toEqual(before);
    expect(await accountId({ name: 'Receivables before conversion' })).toBeUndefined();
  });

  it('with no tagged A/R or A/P account: the first QBD A/R row becomes it, the second merges, an untagged account with the A/P number takes the role; undo restores exactly', async () => {
    await db.update(accounts).set({ systemTag: null, isSystem: false })
      .where(and(eq(accounts.tenantId, c.tenantId), sql`${accounts.systemTag} IN ('accounts_receivable', 'accounts_payable')`));
    const [oldAp] = await db.insert(accounts).values({
      tenantId: c.tenantId, companyId: c.companyId, accountNumber: '92000', name: 'Old payables', accountType: 'liability',
    }).returning();
    const before = await companySnapshot(c);
    const { id } = await commit(await uploadConversion('journal'));
    const [ar] = await db.select().from(accounts).where(and(eq(accounts.tenantId, c.tenantId), eq(accounts.systemTag, 'accounts_receivable')));
    expect([ar!.accountNumber, ar!.detailType, ar!.isSystem, ar!.importBatchId]).toEqual(['91200', 'accounts_receivable', true, id]);
    expect((await db.select().from(accounts).where(and(eq(accounts.tenantId, c.tenantId), eq(accounts.accountNumber, '91250')))).length).toBe(0);
    const [ap] = await db.select().from(accounts).where(and(eq(accounts.tenantId, c.tenantId), eq(accounts.systemTag, 'accounts_payable')));
    expect(ap!.id).toBe(oldAp!.id);
    const customers = await Promise.all(['Alder Café', 'Birch & Co', 'Dogwood Ltd'].map((n) => contactId(n, 'customer')));
    const vendors = await Promise.all(['Birch & Co', 'Cedar Supply'].map((n) => contactId(n, 'vendor')));
    await arTies(CONV, '1850.00', customers);
    await apTies(CONV, '1050.00', vendors);
    expect(await historyBalances(CONV)).toEqual({ ar: '0.00', ap: '0.00' });
    // The Payment row is still a credit memo on the (new) A/R.
    expect((await docs(id)).filter((t) => t.txnType === 'credit_memo')).toHaveLength(2);
    await expectBalanced([CONV]);
    await undo(id);
    expect(await companySnapshot(c)).toEqual(before);
  });

  it('undo gives back only the credit memo number the import took: a prefix set since stays', async () => {
    const { id } = await commit(await uploadConversion('tb-only'));
    const [co] = await db.select({ dn: companies.documentNumbers }).from(companies).where(eq(companies.id, c.companyId));
    expect((co!.dn as Body)['credit_memo']?.next).toEqual(expect.any(Number));
    await db.execute(sql`UPDATE companies SET document_numbers = jsonb_set(document_numbers, '{credit_memo,prefix}', '"CR-"') WHERE id = ${c.companyId}`);
    await undo(id);
    const [after] = await db.select({ dn: companies.documentNumbers }).from(companies).where(eq(companies.id, c.companyId));
    expect((after!.dn as Body)['credit_memo']).toEqual({ prefix: 'CR-' });
  });
});

describe('U-264 batch rules', () => {
  it('an empty Unpaid Bills report is valid: A/P history still goes to Payables before conversion and nets with nothing open', async () => {
    // Without bills the A/P history must already be 0 at conversion: drop the A/P lines from the set.
    const coa = await uploadId('accounts.csv', COA, 'coa');
    const tb = await uploadId('tb.csv', `"As of October 31, 2026"
,Debit,Credit
"91010 · Checking",100.00,
"93000 · Opening Balance Equity",,100.00
`, 'trial_balance');
    const oi = await uploadId('open-invoices.csv', `"As of October 31, 2026"
,,Type,Date,Num,Due Date,Open Balance
TOTAL,,,,,,0.00
`, 'open_invoices');
    const ub = await uploadId('unpaid-bills.csv', EMPTY_UNPAID_BILLS, 'unpaid_bills');
    const { batch } = await commit([coa, tb, oi, ub]);
    expect((batch.sessions as Body[]).find((s) => s.kind === 'unpaid_bills')!.commitResult).toEqual({ created: 0, skipped: 0 });
    // A/R and A/P merged into the system accounts even with nothing open.
    expect((await db.select().from(accounts).where(and(eq(accounts.tenantId, c.tenantId), eq(accounts.accountNumber, '92000')))).length).toBe(0);
    await expectBalanced([CONV]);
  });

  it('without open-item files the chart and history import as before: QBD A/R stays a plain account, no history accounts', async () => {
    const ids = [
      await uploadId('accounts.csv', COA, 'coa'),
      await uploadId('tb-2025-12-31.csv', TB_OPENING, 'trial_balance'),
    ];
    const { batch } = await commit(ids);
    const [plain] = await db.select().from(accounts).where(and(eq(accounts.tenantId, c.tenantId), eq(accounts.accountNumber, '91200')));
    expect([plain!.systemTag, plain!.detailType]).toEqual([null, null]);
    expect(await accountBalance(c, plain!.id, '2025-12-31')).toBe('300.00');
    expect(await accountId({ name: 'Receivables before conversion' })).toBeUndefined();
    expect(batch.result.historyAccounts).toBeUndefined();
  });

  it('closed periods: an open item dated on or before the closing date is refused before the 202 (423)', async () => {
    const oi = await uploadId('open-invoices.csv', OPEN_INVOICES, 'open_invoices');
    await db.execute(sql`UPDATE companies SET lock_date = '2026-06-30' WHERE id = ${c.companyId}`);
    const r = await h.request('POST', '/api/v1/imports/batches', c.token, { sourceSystem: 'quickbooks_desktop', kind: 'conversion', sessionIds: [oi] });
    expect(r.status).toBe(201);
    const cm = await h.request('POST', `/api/v1/imports/batches/${r.json['batch'].id}/commit`, c.token, {}, { 'Idempotency-Key': key() });
    expect([cm.status, cm.json['error']?.code]).toEqual([423, 'TB_PERIOD_LOCKED']);
    expect((await batchRow(String(r.json['batch'].id))).status).toBe('draft');
  });

  it('the old one-session commit needs the admin right (403 IMPORT_ADMIN_REQUIRED); a dry run does not', async () => {
    const bk = await h.staffToken(c, { imports: 'full' });
    const s = await uploadId('open-invoices.csv', OPEN_INVOICES, 'open_invoices');
    const dry = await h.request('POST', `/api/v1/imports/${s}/commit`, bk, { dryRun: true });
    expect(dry.status, JSON.stringify(dry.json)).toBe(200);
    const r = await h.request('POST', `/api/v1/imports/${s}/commit`, bk, {});
    expect([r.status, r.json['error']?.code]).toEqual([403, 'IMPORT_ADMIN_REQUIRED']);
    // The owner may; a one-session open-items commit posts to the before-conversion account on its own.
    const okr = await h.request('POST', `/api/v1/imports/${s}/commit`, c.token, {});
    expect(okr.status, JSON.stringify(okr.json)).toBe(200);
    expect(okr.json['result'].created).toBe(6);
    expect(await accountBalance(c, (await accountId({ name: 'Receivables before conversion' }))!, CONV)).toBe('-1850.00');
  });
});
