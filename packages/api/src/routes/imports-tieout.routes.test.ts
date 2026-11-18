// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.
//
// Import tie-out, verify, spot-check and the batch's transactions (U-267,
// U-271; imports-tieout-v1; ClientLedger P31 E3). A synthetic QuickBooks
// Desktop conversion (chart, names, an opening trial balance with income,
// two journal years, the reference trial balance, Open Invoices and Unpaid
// Bills at the conversion date) ties to exactly zero, prior years' income
// included. Altered sets give exactly the differences they should: a journal
// line re-pointed from 6100 to 6200 moves those two accounts only; an open
// invoice raised by 10.00 shows on the A/R account (+10.00) and on the
// before-conversion row (-10.00) while the item itself stays 0 (the same file
// is on both sides). A Generic set needs its reference trial balance (S9) and,
// in a company with other books, ties out on the batch's own lines (Q-P31h).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'express-async-errors';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import { accounts, importRows, importSessions } from '../db/schema/index.js';
import { importsRouter } from './imports.routes.js';
import * as importsService from '../services/imports/imports.service.js';
import * as batchService from '../services/imports/import-batch.service.js';
import { buildTrialBalance } from '../services/report.service.js';
import { DESKTOP_CAPABILITIES } from '../desktop/capabilities.js';
import { Harness, type Co, key } from './receivables.test-support.js';
import { cleanImports, batchRow, companySnapshot } from './imports-batch.test-support.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Body = any;

const CONV = '2026-10-31';
const h = new Harness();
let c: Co;

beforeEach(async () => {
  h.extraCleanup = [cleanImports];
  await h.start([['/api/v1/imports', importsRouter]]);
  c = await h.company();
});
afterEach(async () => { await h.stop(); });

// ── Synthetic QuickBooks Desktop files (Latin-1) ──────────────────

const COA = `,Account,Type,Balance Total,Description,Accnt. #,Tax Line
,"10100 · Checking",Bank,"1,530.00",,10100,
,"11000 · Accounts Receivable",Accounts Receivable,"1,200.00",,11000,
,"20000 · Accounts Payable",Accounts Payable,400.00,,20000,
,"30000 · Opening Balance Equity",Equity,-500.00,,30000,
,"40000 · Sales",Income,"1,500.00",,40000,
,"6100 · Supplies",Expense,400.00,,6100,
,"6200 · Repairs",Expense,120.00,,6200,
`;

const CUSTOMERS = `,Active Status,Customer,Balance,Balance Total,Company,Main Phone
,Active,Alder Café,700.00,700.00,Alder Café LLC,555-0101
,Active,Birch & Co,500.00,500.00,Birch & Co,555-0102
`;

const VENDORS = `,Active Status,Vendor,Balance,Balance Total,Company,Main Phone
,Active,Cedar Supply,400.00,400.00,Cedar Supply Inc,555-0201
`;

/** Opening balances with a year of income (2024: 300.00) and earlier retained earnings. */
const TB_OPENING = `"Shoal Creek Outfitters (synthetic)"
"Trial Balance"
"As of December 31, 2024"
,Debit,Credit
"10100 · Checking","1,000.00",
"11000 · Accounts Receivable",200.00,
"20000 · Accounts Payable",,100.00
"30000 · Opening Balance Equity",,500.00
"Retained Earnings",,300.00
"40000 · Sales",,900.00
"6100 · Supplies",600.00,
TOTAL,"1,800.00","1,800.00"
`;

/** 2025: income 250.00; A/R and A/P cleared. */
const JOURNAL_2025 = `,Trans #,Type,Date,Num,Name,Memo,Account,Debit,Credit
,1,Invoice,03/10/2025,2001,Alder Café,,11000 · Accounts Receivable,400.00,
,,,,,Alder Café,,40000 · Sales,,400.00
,,,,,,,,400.00,400.00
,2,Payment,04/01/2025,,Alder Café,,10100 · Checking,600.00,
,,,,,Alder Café,,11000 · Accounts Receivable,,600.00
,,,,,,,,600.00,600.00
,3,Bill,05/01/2025,B-10,Cedar Supply,,6100 · Supplies,150.00,
,,,,,Cedar Supply,,20000 · Accounts Payable,,150.00
,,,,,,,,150.00,150.00
,4,Bill Pmt -Check,06/01/2025,401,Cedar Supply,,20000 · Accounts Payable,250.00,
,,,,,Cedar Supply,,10100 · Checking,,250.00
,,,,,,,,250.00,250.00
TOTAL,,,,,,,,"1,400.00","1,400.00"
`;

const journal2026 = (supplies = '6100 · Supplies') => `,Trans #,Type,Date,Num,Name,Memo,Account,Debit,Credit
,5,Invoice,06/15/2026,3001,Alder Café,,11000 · Accounts Receivable,"1,000.00",
,,,,,Alder Café,,40000 · Sales,,"1,000.00"
,,,,,,,,"1,000.00","1,000.00"
,6,Invoice,09/20/2026,3002,Birch & Co,,11000 · Accounts Receivable,500.00,
,,,,,Birch & Co,,40000 · Sales,,500.00
,,,,,,,,500.00,500.00
,7,Payment,10/05/2026,,Alder Café,,10100 · Checking,300.00,
,,,,,Alder Café,,11000 · Accounts Receivable,,300.00
,,,,,,,,300.00,300.00
,8,Bill,07/01/2026,B-20,Cedar Supply,,${supplies},400.00,
,,,,,Cedar Supply,,20000 · Accounts Payable,,400.00
,,,,,,,,400.00,400.00
,9,Check,08/01/2026,501,Cedar Supply,,6200 · Repairs,120.00,
,,,,,Cedar Supply,,10100 · Checking,,120.00
,,,,,,,,120.00,120.00
TOTAL,,,,,,,,"2,320.00","2,320.00"
`;

/** QuickBooks' own trial balance at the conversion date: P&L for 2026, earlier income in Retained Earnings (300 + 300 + 250). */
const TB_REFERENCE = `"Shoal Creek Outfitters (synthetic)"
"Trial Balance"
"As of October 31, 2026"
,Debit,Credit
"10100 · Checking","1,530.00",
"11000 · Accounts Receivable","1,200.00",
"20000 · Accounts Payable",,400.00
"30000 · Opening Balance Equity",,500.00
"Retained Earnings",,850.00
"40000 · Sales",,"1,500.00"
"6100 · Supplies",400.00,
"6200 · Repairs",120.00,
TOTAL,"3,250.00","3,250.00"
`;

const openInvoices = (birch = '500.00') => `"Shoal Creek Outfitters (synthetic)"
"Open Invoices"
"As of October 31, 2026"
,,Type,Date,Num,P. O. #,Terms,Due Date,Aging,Amount,Open Balance
"Alder Café",,,,,,,,,,
,,Invoice,06/15/2026,3001,,Net 30,07/15/2026,108,"1,000.00",700.00
"Total Alder Café",,,,,,,,,,700.00
"Birch & Co",,,,,,,,,,
,,Invoice,09/20/2026,3002,,Net 30,10/20/2026,11,${birch},${birch}
"Total Birch & Co",,,,,,,,,,${birch}
TOTAL,,,,,,,,,,"1,200.00"
`;

const UNPAID_BILLS = `"Shoal Creek Outfitters (synthetic)"
"Unpaid Bills Detail"
"As of October 31, 2026"
,,Type,Date,Num,Due Date,Aging,Open Balance
"Cedar Supply",,,,,,,
,,Bill,07/01/2026,B-20,07/31/2026,92,400.00
"Total Cedar Supply",,,,,,,400.00
TOTAL,,,,,,,400.00
`;

type Kind = 'coa' | 'contacts' | 'trial_balance' | 'gl_transactions' | 'open_invoices' | 'unpaid_bills';

async function upload(
  name: string, text: string, kind: Kind, opts: { options?: Record<string, unknown>; role?: 'post' | 'reference'; source?: string } = {},
): Promise<string> {
  const source = opts.source ?? 'quickbooks_desktop';
  const out = await importsService.createSession({
    tenantId: c.tenantId, companyId: c.companyId, userId: c.userId,
    file: { originalname: name, buffer: Buffer.from(text, source === 'quickbooks_desktop' ? 'latin1' : 'utf8') },
    kind, sourceSystem: source as never, options: (opts.options ?? {}) as never, role: opts.role ?? 'post',
  });
  expect(out.validationErrors, `${name}: ${JSON.stringify(out.validationErrors)}`).toEqual([]);
  return out.session.id;
}

/** U-272: the same files with QuickBooks' Retained Earnings numbered (in the chart and both trial balances). */
const numberedRe = (text: string, n: string) => text.replace('"Retained Earnings"', `"${n} · Retained Earnings"`);
const coaWithRe = (n: string) => `${COA},"${n} · Retained Earnings",Equity,,,${n},\n`;

async function qbdSet(alter: { supplies?: string; birch?: string; retainedNumber?: string } = {}) {
  const n = alter.retainedNumber;
  return [
    await upload('accounts.csv', n ? coaWithRe(n) : COA, 'coa'),
    await upload('customers.csv', CUSTOMERS, 'contacts', { options: { contactKind: 'customer' } }),
    await upload('vendors.csv', VENDORS, 'contacts', { options: { contactKind: 'vendor' } }),
    await upload('tb-2024-12-31.csv', n ? numberedRe(TB_OPENING, n) : TB_OPENING, 'trial_balance'),
    await upload('journal-2025.csv', JOURNAL_2025, 'gl_transactions'),
    await upload('journal-2026.csv', journal2026(alter.supplies), 'gl_transactions'),
    await upload('tb-2026-10-31.csv', n ? numberedRe(TB_REFERENCE, n) : TB_REFERENCE, 'trial_balance', { role: 'reference' }),
    await upload('open-invoices.csv', openInvoices(alter.birch), 'open_invoices'),
    await upload('unpaid-bills.csv', UNPAID_BILLS, 'unpaid_bills'),
  ];
}

const post = (p: string, body: unknown, token = c.token) => h.request('POST', `/api/v1/imports${p}`, token, body, { 'Idempotency-Key': key() });
const get = (p: string, token = c.token) => h.request('GET', `/api/v1/imports${p}`, token);

async function commit(sessionIds: string[], sourceSystem = 'quickbooks_desktop', options: Record<string, unknown> = { conversionDate: CONV }) {
  const r = await h.request('POST', '/api/v1/imports/batches', c.token, { sourceSystem, kind: 'conversion', sessionIds, options });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  const id = String(r.json['batch'].id);
  const cm = await post(`/batches/${id}/commit`, { backupRef: 'before-import.clb' });
  expect(cm.status, JSON.stringify(cm.json)).toBe(202);
  await batchService.__batchJobs.last;
  const b = await get(`/batches/${id}`);
  expect(b.json['batch'].status, JSON.stringify(b.json)).toBe('committed');
  return id;
}

async function tieout(id: string, body: Record<string, unknown> = {}): Promise<Body> {
  const r = await post(`/batches/${id}/tieout`, body);
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return r.json;
}

const nonzero = (t: Body) => ({
  accounts: t.accounts.filter((a: Body) => a.diffExact !== '0.00').map((a: Body) => [a.sourceKeys[0] ?? a.number ?? a.name, a.diffExact]),
  arItems: t.arItems.filter((a: Body) => a.diffExact !== '0.00').map((a: Body) => [a.sourceRow, a.diffExact]),
  apItems: t.apItems.filter((a: Body) => a.diffExact !== '0.00').map((a: Body) => [a.sourceRow, a.diffExact]),
  balanceRows: t.balanceRows.filter((a: Body) => a.diffExact !== '0.00').map((a: Body) => [a.key, a.diffExact]),
});

const NONE = { accounts: [], arItems: [], apItems: [], balanceRows: [] };

describe('U-267 QuickBooks Desktop conversion tie-out', () => {
  it('advertises the capability', () => {
    expect(DESKTOP_CAPABILITIES).toContain('imports-tieout-v1');
  });

  it('the base set ties to exactly zero, prior years\' income in retained earnings; verify purges the parsed rows', async () => {
    const sessions = await qbdSet();
    const id = await commit(sessions);
    const t = await tieout(id);
    expect(nonzero(t), JSON.stringify(t.accounts)).toEqual(NONE);
    expect(t.allZero).toBe(true);
    expect(t.differenceCount).toBe(0);
    expect(t.asOf).toBe(CONV);
    expect(t.books).toBe('company');
    expect(t.referenceTrialBalance.sessionId).toBe(sessions[6]);

    // Accounts: the reference rows resolved, A/R on the system account, nothing else in the books.
    const ar = t.accounts.find((a: Body) => a.sourceKeys.includes('11000'));
    expect(ar).toMatchObject({ sourceExact: '1200.00', booksExact: '1200.00', diffExact: '0.00' });
    const re = t.accounts.find((a: Body) => a.sourceKeys.includes('Retained Earnings'));
    expect(re).toMatchObject({ sourceExact: '-850.00', booksExact: '-850.00' });
    expect(t.accounts.every((a: Body) => a.sourceRow !== null)).toBe(true);
    expect(t.totals.accounts).toEqual({ sourceDebitExact: '3250.00', sourceCreditExact: '3250.00', booksDebitExact: '3250.00', booksCreditExact: '3250.00' });

    // Books side = the engine's exact trial balance (retained earnings row folded in).
    const tb = await buildTrialBalance(c.tenantId, CONV, CONV, c.companyId, null, 'accrual', { exactAmounts: true });
    const tbDebits = (tb.data as Body[]).reduce((s, r) => s + Number(r.debitExact), 0);
    expect(tbDebits.toFixed(2)).toBe('3250.00');

    // Open items keyed by source row; totals for the tiles.
    expect(t.arItems.map((i: Body) => [i.contactName, i.number, i.sourceExact, i.booksExact])).toEqual([
      ['Alder Café', '3001', '700.00', '700.00'], ['Birch & Co', '3002', '500.00', '500.00'],
    ]);
    expect(t.arItems.every((i: Body) => typeof i.sourceRow === 'number' && i.transactionId)).toBe(true);
    expect(t.apItems).toHaveLength(1);
    expect(t.totals.ar).toEqual({ sourceExact: '1200.00', booksExact: '1200.00', diffExact: '0.00' });
    expect(t.totals.ap).toEqual({ sourceExact: '400.00', booksExact: '400.00', diffExact: '0.00' });
    expect(t.totals.inventory).toBeNull();
    expect(t.balanceRows.map((r: Body) => [r.key, r.sourceExact, r.booksExact])).toEqual([
      ['history_ar', '0.00', '0.00'], ['history_ap', '0.00', '0.00'],
    ]);

    // GET shows the summary only.
    const g = (await get(`/batches/${id}`)).json['batch'];
    expect(g.tieout).toMatchObject({ asOf: CONV, allZero: true, differenceCount: 0, verifiedAt: null, counts: { arItems: 2, apItems: 1 } });
    expect(g.tieout.accounts).toBeUndefined();

    // Verify: 200, verified, parsed rows gone; again 200 with what it kept.
    expect(await db.select().from(importRows).where(inArray(importRows.sessionId, sessions))).not.toHaveLength(0);
    const v = await post(`/batches/${id}/verify`, {});
    expect(v.status, JSON.stringify(v.json)).toBe(200);
    expect(v.json['batch'].verifiedAt).toBeTruthy();
    expect(v.json['batch'].verifiedBy).toBe(c.userId);
    expect(v.json['tieout'].allZero).toBe(true);
    expect(v.json['tieout'].verifiedAt).toBeTruthy();
    expect(await db.select().from(importRows).where(inArray(importRows.sessionId, sessions))).toHaveLength(0);
    const v2 = await post(`/batches/${id}/verify`, {});
    expect(v2.status).toBe(200);
    expect(v2.json['tieout'].verifiedAt).toBe(v.json['tieout'].verifiedAt);
    const again = await tieout(id);
    expect(again.verifiedAt).toBe(v.json['tieout'].verifiedAt);
    expect(again.arItems).toHaveLength(2);
    expect((await batchRow(id)).verifiedBy).toBe(c.userId);
  });

  it('a journal line re-pointed from 6100 to 6200 gives +/- that amount on those two accounts only', async () => {
    const id = await commit(await qbdSet({ supplies: '6200 · Repairs' }));
    const t = await tieout(id);
    expect(nonzero(t)).toEqual({ ...NONE, accounts: [['6100', '-400.00'], ['6200', '400.00']] });
    expect(t.allZero).toBe(false);
    const v = await post(`/batches/${id}/verify`, {});
    expect(v.status).toBe(409);
    expect(v.json['error'].code).toBe('TIEOUT_NOT_ZERO');
    const d = v.json['error'].details;
    expect(d.differenceCount).toBe(2);
    const rows = Object.fromEntries(t.accounts.map((a: Body) => [a.accountId, a.sourceRow]));
    expect(d.firstDifferences.map((x: Body) => x.sourceRow)).toEqual(d.firstDifferences.map((x: Body) => rows[x.accountId]));
    expect(d.firstDifferences.every((x: Body) => typeof x.sourceRow === 'number' && x.accountId)).toBe(true);
    expect(d.firstDifferences.map((x: Body) => [x.section, x.key, x.diffExact])).toEqual([
      ['accounts', null, '-400.00'], ['accounts', null, '400.00'],
    ]);
    // Codes and ids only: no account or contact names in the error.
    expect(JSON.stringify(v.json['error'])).not.toMatch(/Supplies|Repairs|Cedar/);
    expect((await batchRow(id)).verifiedAt).toBeNull();
    expect(await db.select().from(importRows).where(inArray(importRows.sessionId, await sessionIds(id)))).not.toHaveLength(0);
  });

  it('an open invoice raised by 10.00: A/R +10.00, history_ar -10.00, the item row 0', async () => {
    const id = await commit(await qbdSet({ birch: '510.00' }));
    const t = await tieout(id);
    expect(nonzero(t)).toEqual({ ...NONE, accounts: [['11000', '10.00']], balanceRows: [['history_ar', '-10.00']] });
    const birch = t.arItems.find((i: Body) => i.number === '3002');
    expect(birch).toMatchObject({ sourceExact: '510.00', booksExact: '510.00', diffExact: '0.00' });
    expect(t.totals.ar).toEqual({ sourceExact: '1210.00', booksExact: '1210.00', diffExact: '0.00' });
    const v = await post(`/batches/${id}/verify`, {});
    expect(v.json['error'].details.firstDifferences.map((x: Body) => [x.section, x.key, x.diffExact])).toEqual([
      ['accounts', null, '10.00'], ['balanceRows', 'history_ar', '-10.00'],
    ]);
  });

  it('verify needs the owner (403 IMPORT_ADMIN_REQUIRED); tie-out, spot-check and the transaction list do not', async () => {
    const id = await commit(await qbdSet());
    const bk = await h.staffToken(c, { imports: 'full' });
    const v = await post(`/batches/${id}/verify`, {}, bk);
    expect(v.status).toBe(403);
    expect(v.json['error'].code).toBe('IMPORT_ADMIN_REQUIRED');
    expect((await post(`/batches/${id}/tieout`, {}, bk)).status).toBe(200);
    const items = [
      { key: 'invoice:3001', label: 'Open invoice 3001', done: true, note: 'matches' },
      { key: 'bank', label: 'Checking balance', done: false },
    ];
    const s = await h.request('PUT', `/api/v1/imports/batches/${id}/spot-check`, bk, { items });
    expect(s.status, JSON.stringify(s.json)).toBe(200);
    expect(s.json['spotCheck'].items).toEqual(items);
    const g = (await get(`/batches/${id}`)).json['batch'];
    expect(g.spotCheck.items).toEqual(items);
    expect(g.spotCheck.updatedAt).toBeTruthy();
    const bad = await h.request('PUT', `/api/v1/imports/batches/${id}/spot-check`, bk, { items: [{ key: '', label: 'x', done: true }] });
    expect(bad.status).toBe(400);
  });

  it('lists the batch\'s transactions, paged, filtered by type', async () => {
    const id = await commit(await qbdSet());
    const all: Body[] = [];
    let cursor: string | null = null;
    let total = -1;
    do {
      const r = await get(`/batches/${id}/transactions?limit=4${cursor ? `&cursor=${cursor}` : ''}`);
      expect(r.status, JSON.stringify(r.json)).toBe(200);
      all.push(...r.json['transactions']);
      total = r.json['total'];
      cursor = r.json['nextCursor'];
    } while (cursor);
    expect(all).toHaveLength(total);
    expect(new Set(all.map((x) => x.id)).size).toBe(total);
    const dates = all.map((x) => x.txnDate);
    expect([...dates].sort()).toEqual(dates);
    const inv = await get(`/batches/${id}/transactions?txnType=invoice`);
    expect(inv.json['total']).toBe(2);
    expect(inv.json['transactions'].map((x: Body) => [x.txnNumber, x.contactName, x.total])).toEqual([
      ['3001', 'Alder Café', '700.00'], ['3002', 'Birch & Co', '500.00'],
    ]);
    expect((await get(`/batches/${id}/transactions?cursor=nope`)).status).toBe(400);
  });

  it('the same trial balance file may be uploaded to post and as the reference; twice in one role is 409 IMPORT_SESSION_ACTIVE', async () => {
    await upload('tb.csv', TB_REFERENCE, 'trial_balance');
    await upload('tb-ref.csv', TB_REFERENCE, 'trial_balance', { role: 'reference' });
    await expect(importsService.createSession({
      tenantId: c.tenantId, companyId: c.companyId, userId: c.userId,
      file: { originalname: 'tb-again.csv', buffer: Buffer.from(TB_REFERENCE, 'latin1') },
      kind: 'trial_balance', sourceSystem: 'quickbooks_desktop', options: {} as never, role: 'reference',
    })).rejects.toMatchObject({ code: 'IMPORT_SESSION_ACTIVE' });
  });

  it('refuses a batch that is not committed', async () => {
    const r = await h.request('POST', '/api/v1/imports/batches', c.token, {
      sourceSystem: 'quickbooks_desktop', kind: 'conversion', sessionIds: await qbdSet(), options: { conversionDate: CONV },
    });
    const id = r.json['batch'].id;
    const t = await post(`/batches/${id}/tieout`, {});
    expect([t.status, t.json['error'].code]).toEqual([409, 'IMPORT_BATCH_NOT_COMMITTED']);
    const s = await h.request('PUT', `/api/v1/imports/batches/${id}/spot-check`, c.token, { items: [] });
    expect([s.status, s.json['error'].code]).toEqual([409, 'IMPORT_BATCH_NOT_COMMITTED']);
  });
});

// ── Generic (S9, Q-P31h) ──────────────────────────────────────────

const G_COA = `Account Number,Account Name,Account Type,Detail Type
7100,Gen Checking,asset,bank
7300,Gen Equity,equity,
7400,Gen Sales,revenue,
7600,Gen Supplies,expense,
`;

const gTb = (checking: string, equity: string, sales: string, supplies: string, pad = '') => `Account Number,Account Name,Debit,Credit
7100,Gen Checking,${checking},
7300,Gen Equity,,${equity}
7400,Gen Sales,,${sales}
7600,Gen Supplies,${supplies},
${pad}`;

async function genericTb(name: string, text: string, date: string, role: 'post' | 'reference' = 'post') {
  return upload(name, text, 'trial_balance', { source: 'generic', role, options: { tbReportDate: date } });
}

describe('U-267 Generic tie-out', () => {
  it('needs the reference trial balance (422 TIEOUT_REFERENCE_REQUIRED) unless requireReference is false', async () => {
    const id = await commit([
      await upload('g-coa.csv', G_COA, 'coa', { source: 'generic' }),
      await genericTb('g-tb.csv', gTb('1000.00', '700.00', '500.00', '200.00'), CONV),
    ], 'generic');
    const r = await post(`/batches/${id}/tieout`, {});
    expect([r.status, r.json['error'].code]).toEqual([422, 'TIEOUT_REFERENCE_REQUIRED']);
    const v = await post(`/batches/${id}/verify`, {});
    expect(v.json['error'].code).toBe('TIEOUT_REFERENCE_REQUIRED');
    const t = await tieout(id, { requireReference: false });
    expect(t.accounts).toEqual([]);
    expect(t.referenceTrialBalance).toBeNull();
    expect(t.totals.accounts).toBeNull();
  });

  it('an altered Generic set shows its differences; with other books in the company only the batch\'s lines count', async () => {
    // Other books first: the company is not empty when the conversion commits.
    await commit([
      await upload('g-coa.csv', G_COA, 'coa', { source: 'generic' }),
      await genericTb('g-tb-jan.csv', gTb('50.00', '50.00', '0.00', '0.00'), '2026-01-31'),
    ], 'generic', { conversionDate: '2026-01-31' });
    const id = await commit([
      await genericTb('g-tb.csv', gTb('1000.00', '700.00', '500.00', '200.00'), CONV),
      // The reference differs from what was posted: Checking 1,010.00 and Sales 510.00.
      await genericTb('g-ref.csv', gTb('1010.00', '700.00', '510.00', '200.00', '\n'), CONV, 'reference'),
    ], 'generic');
    const t = await tieout(id);
    expect(t.books).toBe('batch');
    expect(nonzero(t)).toEqual({ ...NONE, accounts: [['7100', '-10.00'], ['7400', '10.00']] });
    expect(t.accounts.find((a: Body) => a.number === '7100')).toMatchObject({ sourceExact: '1010.00', booksExact: '1000.00' });
    // The fixed reference ties: only the batch's lines (the January books are left out).
    const ok = await commit([
      await genericTb('g-tb2.csv', gTb('2000.00', '1400.00', '1000.00', '400.00'), '2026-10-30'),
      await genericTb('g-ref2.csv', gTb('2000.00', '1400.00', '1000.00', '400.00', '\n'), '2026-10-30', 'reference'),
    ], 'generic', { conversionDate: '2026-10-30' });
    const t2 = await tieout(ok);
    expect(t2.books).toBe('batch');
    expect(t2.allZero, JSON.stringify(nonzero(t2))).toBe(true);
    expect((await post(`/batches/${ok}/verify`, {})).status).toBe(200);
  });
});

describe('U-267 batch books across a year end', () => {
  it('with other books in the company, the batch\'s earlier-year income ties to the reference\'s retained earnings', async () => {
    await commit([
      await upload('g-coa.csv', G_COA, 'coa', { source: 'generic' }),
      await genericTb('g-tb-mid.csv', gTb('50.00', '50.00', '0.00', '0.00'), '2025-06-30'),
    ], 'generic', { conversionDate: '2025-06-30' });
    // Opening balances at the prior year end, income 300.00 in 2025; QuickBooks shows it in Retained Earnings in 2026.
    const id = await commit([
      await genericTb('g-tb-ye.csv', gTb('1000.00', '700.00', '500.00', '200.00'), '2025-12-31'),
      await genericTb('g-ref-26.csv', `Account Number,Account Name,Debit,Credit
7100,Gen Checking,1000.00,
7300,Gen Equity,,700.00
,Retained Earnings,,300.00
`, CONV, 'reference'),
    ], 'generic');
    const t = await tieout(id);
    expect(t.books).toBe('batch');
    expect(nonzero(t), JSON.stringify(t.accounts)).toEqual(NONE);
    expect(t.accounts.find((a: Body) => a.sourceKeys.includes('Retained Earnings'))).toMatchObject({ sourceExact: '-300.00', booksExact: '-300.00' });
  });
});

describe('U-272 QuickBooks Desktop retained earnings merge (qbd-retained-earnings-v1)', () => {
  const RE_NO = '32000';
  const reRows = () => db.select().from(accounts).where(and(eq(accounts.tenantId, c.tenantId), eq(accounts.systemTag, 'retained_earnings')));

  it('advertises the capability; the chart row carries systemRole retained_earnings', async () => {
    expect(DESKTOP_CAPABILITIES).toContain('qbd-retained-earnings-v1');
    const s = await importsService.createSession({
      tenantId: c.tenantId, companyId: c.companyId, userId: c.userId,
      file: { originalname: 'accounts.csv', buffer: Buffer.from(coaWithRe(RE_NO), 'latin1') },
      kind: 'coa', sourceSystem: 'quickbooks_desktop', options: {} as never, role: 'post',
    });
    const m = (s.preview as Body).accountMatches.find((a: Body) => a.sourceKey === RE_NO);
    expect(m).toMatchObject({ systemRole: 'retained_earnings', name: 'Retained Earnings' });
    // An equity account of another name is not it.
    expect((s.preview as Body).accountMatches.find((a: Body) => a.sourceKey === '30000').systemRole).toBeUndefined();
  });

  it('a numbered chart with prior-year history ties to exactly zero; the source row is the system account; undo is exact', async () => {
    const [sys] = await reRows();
    expect(sys, 'the test company has a retained earnings account').toBeTruthy();
    const before = await companySnapshot(c);
    const id = await commit(await qbdSet({ retainedNumber: RE_NO }));

    // Not created: no account 32000; the trial balance's lines went to the system account.
    expect(await db.select().from(accounts).where(and(eq(accounts.tenantId, c.tenantId), eq(accounts.accountNumber, RE_NO)))).toHaveLength(0);
    expect((await reRows()).map((a) => a.id)).toEqual([sys!.id]);

    const t = await tieout(id);
    expect(nonzero(t), JSON.stringify(t.accounts)).toEqual(NONE);
    expect(t.allZero).toBe(true);
    const re = t.accounts.find((a: Body) => a.sourceKeys.includes(RE_NO));
    expect(re).toMatchObject({ accountId: sys!.id, sourceExact: '-850.00', booksExact: '-850.00', diffExact: '0.00' });
    expect(t.accounts.filter((a: Body) => a.accountId === sys!.id)).toHaveLength(1);
    expect((await post(`/batches/${id}/verify`, {})).status).toBe(200);

    const u = await h.request('POST', `/api/v1/imports/batches/${id}/undo`, c.token, { backupRef: 'before-undo.clb' }, { 'Idempotency-Key': key() });
    expect(u.status, JSON.stringify(u.json)).toBe(202);
    await batchService.__batchJobs.last;
    expect((await batchRow(id)).status).toBe('undone');
    expect(await companySnapshot(c)).toEqual(before);
  });

  it('accountMap "create" keeps a separate account (the old behaviour: +/- prior years\' income on two rows)', async () => {
    const id = await commit(await qbdSet({ retainedNumber: RE_NO }), 'quickbooks_desktop', { conversionDate: CONV, accountMap: { [RE_NO]: 'create' } });
    const [made] = await db.select().from(accounts).where(and(eq(accounts.tenantId, c.tenantId), eq(accounts.accountNumber, RE_NO)));
    expect(made?.systemTag ?? null).toBeNull();
    const t = await tieout(id);
    expect(t.allZero).toBe(false);
    const diffs = nonzero(t).accounts.map(([, d]: [string, string]) => d).sort();
    expect(diffs).toEqual(['-550.00', '550.00']);
  });

  it('with no tagged retained earnings account, the QuickBooks row becomes it; undo gives the company its old chart', async () => {
    await db.update(accounts).set({ systemTag: null, isSystem: false })
      .where(and(eq(accounts.tenantId, c.tenantId), eq(accounts.systemTag, 'retained_earnings')));
    const before = await companySnapshot(c);
    const id = await commit(await qbdSet({ retainedNumber: RE_NO }));
    const tagged = await reRows();
    expect(tagged.map((a) => a.accountNumber)).toEqual([RE_NO]);
    const t = await tieout(id);
    expect(nonzero(t), JSON.stringify(t.accounts)).toEqual(NONE);
    const u = await h.request('POST', `/api/v1/imports/batches/${id}/undo`, c.token, { backupRef: 'before-undo.clb' }, { 'Idempotency-Key': key() });
    expect(u.status, JSON.stringify(u.json)).toBe(202);
    await batchService.__batchJobs.last;
    expect(await companySnapshot(c)).toEqual(before);
  });
});

async function sessionIds(batchId: string): Promise<string[]> {
  return (await db.select({ id: importSessions.id }).from(importSessions)
    .where(and(eq(importSessions.batchId, batchId), eq(importSessions.tenantId, c.tenantId)))).map((s) => s.id);
}
