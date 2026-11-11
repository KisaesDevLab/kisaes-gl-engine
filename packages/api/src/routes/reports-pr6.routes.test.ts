// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

// Report fixes from the ClientLedger PR-6 review (U-213, report-fixes-v2):
//   B1 the Trial Balance's prior-years retained earnings is on the report's
//      basis (cash TB balances across a year end), tag split too;
//   B2 exact Balance Sheet: calculated rows, includesPriorYearsIncome on the
//      Retained Earnings account, calculatedEquityExact, fiscalYearStart;
//   S1 fiscal_year_start (retail 52-53 week starts) on the Balance Sheet,
//      Trial Balance and General Ledger, drills sum to the cells;
//   S2 a tag filter on the exact Balance Sheet / Trial Balance is 400
//      TAG_FILTER_NOT_AVAILABLE; the cash TB's tag filter is per transaction
//      (debits = credits), as the accrual one;
//   S5 meta.cashArApResidue on cash Balance Sheet / Trial Balance.

import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import 'express-async-errors';
import express from 'express';
import http from 'http';
import type { AddressInfo, Server } from 'net';
import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { accounts, paymentApplications, billPaymentApplications, tagGroups, tags } from '../db/schema/index.js';
import * as authService from '../services/auth.service.js';
import * as ledger from '../services/ledger.service.js';
import * as reportService from '../services/report.service.js';
import { DESKTOP_CAPABILITIES } from '../desktop/capabilities.js';
import { reportsRouter } from './reports.routes.js';
import { errorHandler } from '../middleware/error-handler.js';

let server: Server | null = null;
let port = 0;
let token = '';
let tenantId = '';
let companyId = '';
const ids = { checking: '', sales: '', supplies: '', ar: '', ap: '', re: '' };

async function cleanDb() {
  await db.execute(sql`TRUNCATE
    audit_log, journal_lines, transaction_tags, payment_applications, bill_payment_applications, deposit_lines,
    recurring_schedules, budget_lines, budgets, vendor_1099_account_mappings,
    bank_feed_items, reconciliation_lines, reconciliations,
    plaid_account_mappings, plaid_accounts, plaid_items, bank_connections,
    transactions, contacts, tags, tag_groups, api_keys, sessions,
    accounts, companies, users, tenants
    CASCADE`);
}

function get(path: string): Promise<{ status: number; body: any }> {
  return new Promise((res, rej) => {
    const r = http.request({
      method: 'GET', hostname: '127.0.0.1', port, path: `/api/v1/reports${path}`,
      headers: { Authorization: `Bearer ${token}` },
    }, (resp) => {
      let data = '';
      resp.on('data', (c) => (data += c));
      resp.on('end', () => res({ status: resp.statusCode!, body: data ? JSON.parse(data) : null }));
    });
    r.on('error', rej);
    r.end();
  });
}

async function mk(name: string, accountType: string, accountNumber: string, detailType: string) {
  const [a] = await db.insert(accounts).values({ tenantId, name, accountNumber, accountType, detailType } as typeof accounts.$inferInsert).returning();
  return a!.id;
}
async function system(tag: string) {
  const a = await db.query.accounts.findFirst({ where: (x, { and, eq }) => and(eq(x.tenantId, tenantId), eq(x.systemTag, tag)) });
  return a!.id;
}

type Line = { accountId: string; debit: string; credit: string; tagId?: string | null };
const dr = (accountId: string, amount: string, tagId: string | null = null): Line => ({ accountId, debit: amount, credit: '0', tagId });
const cr = (accountId: string, amount: string, tagId: string | null = null): Line => ({ accountId, debit: '0', credit: amount, tagId });
async function post(txnType: string, txnDate: string, lines: Line[], total?: string) {
  return ledger.postTransaction(tenantId, {
    txnType: txnType as never, txnDate, memo: txnType, ...(total ? { total } : {}), lines,
  } as Parameters<typeof ledger.postTransaction>[1], undefined, companyId);
}
/** An invoice and a payment applied to it in full. */
async function paidInvoice(invDate: string, payDate: string, amount: string, tagId: string | null = null) {
  const inv = await post('invoice', invDate, [dr(ids.ar, amount), cr(ids.sales, amount, tagId)], amount);
  const pay = await post('customer_payment', payDate, [dr(ids.checking, amount), cr(ids.ar, amount)], amount);
  await db.insert(paymentApplications).values({ tenantId, paymentId: pay.id, invoiceId: inv.id, amount });
}
async function paidBill(billDate: string, payDate: string, amount: string) {
  const bill = await post('bill', billDate, [dr(ids.supplies, amount), cr(ids.ap, amount)], amount);
  const pay = await post('bill_payment', payDate, [dr(ids.ap, amount), cr(ids.checking, amount)], amount);
  await db.insert(billPaymentApplications).values({ tenantId, paymentId: pay.id, billId: bill.id, amount });
}

const tbBalances = (body: any) => expect(body.totalDebitsExact, JSON.stringify(body.data)).toBe(body.totalCreditsExact);
const tbRow = (body: any, name: string) => body.data.find((r: any) => r.name === name);
const tbAccount = (body: any, id: string) => body.data.find((r: any) => r.accountId === id && (r.rowKind ?? 'account_total') === 'account_total');

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/reports', reportsRouter);
  app.use(errorHandler);
  await new Promise<void>((done) => { server = app.listen(0, () => { port = (server!.address() as AddressInfo).port; done(); }); });
});

afterAll(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  await cleanDb();
});

beforeEach(async () => {
  await cleanDb();
  const reg = await authService.register({
    email: `pr6-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`,
    password: 'password123456', displayName: 'PR6', companyName: 'PR6 Co',
  });
  token = reg.tokens.accessToken;
  tenantId = reg.user.tenantId;
  companyId = (await db.query.companies.findFirst({ where: (c, { eq }) => eq(c.tenantId, tenantId) }))!.id;
  Object.assign(ids, {
    checking: await mk('PR6 Checking', 'asset', '1011', 'bank'),
    sales: await mk('PR6 Sales', 'revenue', '4011', 'service'),
    supplies: await mk('PR6 Supplies', 'expense', '6011', 'office_expenses'),
    ar: await system('accounts_receivable'),
    ap: await system('accounts_payable'),
    re: await system('retained_earnings'),
  });
});

describe('report-fixes-v2 capability', () => {
  it('is advertised', () => {
    expect(DESKTOP_CAPABILITIES).toContain('report-fixes-v2');
  });
});

describe('B1: prior-years retained earnings on the report basis', () => {
  it('a cash Trial Balance balances after an invoice and a bill open at the year end; accrual unchanged; tag split too', async () => {
    await paidInvoice('2025-12-15', '2026-01-10', '1000.0000');
    await paidBill('2025-12-20', '2026-01-05', '400.0000');
    // A cash-only entry before the year start.
    await ledger.postTransaction(tenantId, {
      txnType: 'journal_entry', txnDate: '2025-11-30', memo: 'cash only', basis: 'cash',
      lines: [dr(ids.checking, '50.0000'), cr(ids.sales, '50.0000')],
    } as Parameters<typeof ledger.postTransaction>[1], undefined, companyId);

    const cash = await get('/trial-balance?exact=1&basis=cash&start_date=2026-01-01&end_date=2026-01-31');
    expect(cash.status, JSON.stringify(cash.body)).toBe(200);
    tbBalances(cash.body);
    // Cash prior years: only the cash-only 50 (the invoice and bill were paid in 2026).
    expect(tbRow(cash.body, 'Retained Earnings (Prior Years)').creditExact).toBe('50.0000');
    expect(tbAccount(cash.body, ids.sales).creditExact).toBe('1000.0000');
    expect(tbAccount(cash.body, ids.supplies).debitExact).toBe('400.0000');

    const accrual = await get('/trial-balance?exact=1&basis=accrual&start_date=2026-01-01&end_date=2026-01-31');
    tbBalances(accrual.body);
    // Accrual prior years: 1000 - 400 (the cash-only entry is not on accrual).
    expect(tbRow(accrual.body, 'Retained Earnings (Prior Years)').creditExact).toBe('600.0000');

    // The cash TB's retained earnings = the cash Balance Sheet's prior years (folded into the RE account).
    const bs = await get('/balance-sheet?exact=1&basis=cash&as_of_date=2026-01-31');
    expect(bs.body.equity.find((e: any) => e.accountId === ids.re).priorYearsIncomeExact).toBe('50.0000');

    // Tag split on the cash TB: totals unchanged, the RE row's parts sum to it.
    const [group] = await db.insert(tagGroups).values({ tenantId, name: 'Region' }).returning();
    await db.insert(tags).values({ tenantId, groupId: group!.id, name: 'Lake', tagNumber: '10', sortOrder: 1 });
    const split = await get(`/trial-balance?exact=1&basis=cash&start_date=2026-01-01&end_date=2026-01-31&tag_split=1&tag_group_id=${group!.id}`);
    expect(split.status, JSON.stringify(split.body)).toBe(200);
    tbBalances(split.body);
    const reRows = split.body.data.filter((r: any) => r.name === 'Retained Earnings (Prior Years)');
    expect(reRows.find((r: any) => r.rowKind === 'account').creditExact).toBe('50.0000');
    expect(reRows.find((r: any) => r.rowKind === 'account_total').creditExact).toBe('50.0000');
  });
});

describe('B2: Balance Sheet equity rows say what drills', () => {
  it('flags the Retained Earnings account holding prior years\' income and the calculated rows', async () => {
    await post('journal_entry', '2025-06-01', [dr(ids.checking, '1000.0000'), cr(ids.sales, '1000.0000')]);
    await post('journal_entry', '2026-01-15', [dr(ids.checking, '200.0000'), cr(ids.sales, '200.0000')]);
    const bs = await get('/balance-sheet?exact=1&as_of_date=2026-01-31');
    expect(bs.status, JSON.stringify(bs.body)).toBe(200);
    const re = bs.body.equity.find((e: any) => e.accountId === ids.re);
    expect(re).toMatchObject({ includesPriorYearsIncome: true, priorYearsIncomeExact: '1000.0000', balanceExact: '1000.0000' });
    const ni = bs.body.equity.find((e: any) => e.name === 'Net Income (Current Year)');
    expect(ni).toMatchObject({ accountId: null, calculated: true, balanceExact: '200.0000' });
    expect(bs.body.calculatedEquityExact).toBe('1200.0000');
    expect(bs.body.fiscalYearStart).toBe('2026-01-01');
    // The same flags in the detail-type grouping.
    const grouped = await get('/balance-sheet?exact=1&as_of_date=2026-01-31&group_by=detail_type');
    expect(grouped.body.equity.find((e: any) => e.accountId === ids.re).includesPriorYearsIncome).toBe(true);

    // No prior-years income: no flag; legacy responses carry none of the new fields.
    const first = await get('/balance-sheet?exact=1&as_of_date=2025-12-31');
    expect(first.body.equity.find((e: any) => e.name === 'Net Income (Current Year)').calculated).toBe(true);
    expect(first.body.equity.some((e: any) => e.includesPriorYearsIncome)).toBe(false);
    const legacy = await get('/balance-sheet?as_of_date=2026-01-31');
    expect(legacy.status).toBe(200);
    expect(legacy.body.calculatedEquityExact).toBeUndefined();
    expect(legacy.body.equity.some((e: any) => 'calculated' in e || 'includesPriorYearsIncome' in e)).toBe(false);
  });
});

describe('S1: fiscal_year_start (retail calendars)', () => {
  it('splits the Trial Balance, Balance Sheet and General Ledger at the given start, and the drills sum to the cells', async () => {
    // FY2026 of a calendar-year 4-4-5 company: 2025-12-28 .. 2026-12-26.
    await post('journal_entry', '2025-12-29', [dr(ids.checking, '5000.0000'), cr(ids.sales, '5000.0000')]);
    await post('journal_entry', '2026-01-10', [dr(ids.checking, '300.0000'), cr(ids.sales, '300.0000')]);
    await post('journal_entry', '2025-06-10', [dr(ids.checking, '70.0000'), cr(ids.sales, '70.0000')]);
    const fy = 'fiscal_year_start=2024-12-29,2025-12-28';

    // Without the parameter: the month rule (Jan 1).
    const plain = await get('/trial-balance?exact=1&start_date=2026-01-01&end_date=2026-01-24');
    expect(tbAccount(plain.body, ids.sales).creditExact).toBe('300.0000');
    expect(plain.body.fiscalYearStart).toBe('2026-01-01');

    const tb = await get(`/trial-balance?exact=1&start_date=2025-12-28&end_date=2026-01-24&${fy}`);
    expect(tb.status, JSON.stringify(tb.body)).toBe(200);
    tbBalances(tb.body);
    expect(tbAccount(tb.body, ids.sales).creditExact).toBe('5300.0000');
    expect(tbRow(tb.body, 'Retained Earnings (Prior Years)').creditExact).toBe('70.0000');
    expect(tb.body.fiscalYearStart).toBe('2025-12-28');
    expect(tb.body.drillTarget).toMatchObject({ startDate: '2025-12-28', endDate: '2026-01-24' });
    expect(tb.body.drillTarget.params.fiscal_year_start).toBe('2025-12-28');

    // The drill: GL from the drill target's start with its params.
    const p = new URLSearchParams({ ...tb.body.drillTarget.params, exact: '1', account_ids: ids.sales,
      start_date: tb.body.drillTarget.startDate, end_date: tb.body.drillTarget.endDate });
    const gl = await get(`/general-ledger?${p.toString()}`);
    expect(gl.status, JSON.stringify(gl.body)).toBe(200);
    expect(gl.body.accounts[0].beginningBalanceExact).toBe('0.0000');
    expect(gl.body.accounts[0].endingBalanceExact).toBe('5300.0000');
    // Without it the GL resets income at Jan 1 2025 (the 2025-06-10 sale is in the beginning balance).
    const glMonth = await get(`/general-ledger?exact=1&account_ids=${ids.sales}&start_date=2025-12-28&end_date=2026-01-24`);
    expect(glMonth.body.accounts[0].beginningBalanceExact).toBe('70.0000');

    // Balance Sheet: Net Income from the retail start; the classic and column layouts agree.
    const bs = await get(`/balance-sheet?exact=1&as_of_date=2026-01-24&${fy}`);
    expect(bs.body.equity.find((e: any) => e.name === 'Net Income (Current Year)').balanceExact).toBe('5300.0000');
    expect(bs.body.fiscalYearStart).toBe('2025-12-28');
    const bsPlain = await get('/balance-sheet?exact=1&as_of_date=2026-01-24');
    expect(bsPlain.body.equity.find((e: any) => e.name === 'Net Income (Current Year)').balanceExact).toBe('300.0000');
    const cols = await get(`/balance-sheet?exact=1&period_ranges=2025-12-28..2026-01-24&prior=year&${fy}`);
    expect(cols.status, JSON.stringify(cols.body)).toBe(200);
    const niRow = cols.body.equity.find((e: any) => e.name === 'Net Income (Current Year)');
    expect(niRow.valuesExact[0]).toBe('5300.0000');
    expect(cols.body.columns[0].fiscalYearStart).toBe('2025-12-28');
    expect(cols.body.columns[1]).toMatchObject({ kind: 'prior', asOf: '2025-01-24', fiscalYearStart: '2024-12-29' });

    // Errors: not covered, not ascending, not a date, without exact=1, with compare.
    const err = async (q: string, status = 400) => {
      const r = await get(q);
      expect(r.status, `${q} ${JSON.stringify(r.body)}`).toBe(status);
      expect(r.body.error.details.param).toBe('fiscal_year_start');
    };
    await err('/trial-balance?exact=1&end_date=2026-01-24&fiscal_year_start=2026-02-01');
    await err('/trial-balance?exact=1&end_date=2027-03-01&fiscal_year_start=2025-12-28');
    await err('/balance-sheet?exact=1&as_of_date=2026-01-24&fiscal_year_start=2025-12-28,2024-12-29');
    await err('/general-ledger?exact=1&start_date=2026-01-01&end_date=2026-01-24&fiscal_year_start=soon');
    await err('/trial-balance?end_date=2026-01-24&fiscal_year_start=2025-12-28');
    await err('/balance-sheet?exact=1&as_of_date=2026-01-24&compare=previous_year&fiscal_year_start=2025-12-28');
    // A column's prior as-of not covered by the list.
    await err('/balance-sheet?exact=1&period_ranges=2025-12-28..2026-01-24&prior=year&fiscal_year_start=2025-12-28');
  });
});

describe('S2: tag filters on balance reports', () => {
  it('the exact Balance Sheet and Trial Balance refuse a tag filter with TAG_FILTER_NOT_AVAILABLE', async () => {
    const [group] = await db.insert(tagGroups).values({ tenantId, name: 'Region' }).returning();
    const [lake] = await db.insert(tags).values({ tenantId, groupId: group!.id, name: 'Lake', tagNumber: '10', sortOrder: 1 }).returning();
    for (const q of [
      `/trial-balance?exact=1&tag_id=${lake!.id}`,
      `/balance-sheet?exact=1&tag_id=${lake!.id}`,
      '/balance-sheet?exact=1&tag_id=untagged',
      `/balance-sheet?exact=1&period_ranges=2026-01-01..2026-01-31&tag_id=${lake!.id}`,
    ]) {
      const r = await get(q);
      expect(r.status, q).toBe(400);
      expect(r.body.error.code, q).toBe('TAG_FILTER_NOT_AVAILABLE');
      expect(r.body.error.details.param).toBe('tag_id');
    }
    // The tag split still works on both.
    expect((await get(`/balance-sheet?exact=1&as_of_date=2026-01-31&tag_split=1&tag_group_id=${group!.id}`)).status).toBe(200);
    expect((await get(`/trial-balance?exact=1&end_date=2026-01-31&tag_split=1&tag_group_id=${group!.id}`)).status).toBe(200);
  });

  it('a tag-filtered cash Trial Balance (service and legacy route) keeps whole transactions, so debits = credits', async () => {
    const [group] = await db.insert(tagGroups).values({ tenantId, name: 'Region' }).returning();
    const [lake] = await db.insert(tags).values({ tenantId, groupId: group!.id, name: 'Lake', tagNumber: '10', sortOrder: 1 }).returning();
    const lakeId = lake!.id;
    // A check to Supplies tagged Lake, the bank line untagged (this year and last year).
    await post('expense', '2026-01-12', [dr(ids.supplies, '100.0000', lakeId), cr(ids.checking, '100.0000')], '100.0000');
    await post('expense', '2025-07-12', [dr(ids.supplies, '40.0000', lakeId), cr(ids.checking, '40.0000')], '40.0000');
    // A paid invoice whose revenue line is tagged; the payment is untagged.
    await paidInvoice('2026-01-03', '2026-01-20', '250.0000', lakeId);
    for (const basis of ['cash', 'accrual'] as const) {
      const tb = await reportService.buildTrialBalance(tenantId, '2026-01-01', '2026-01-31', companyId, lakeId, basis, { exactAmounts: true });
      expect(tb.totalDebitsExact, basis).toBe(tb.totalCreditsExact);
      const re = tb.data.find((r) => r.name === 'Retained Earnings (Prior Years)');
      expect(re?.debitExact, basis).toBe('40.0000');
      const supplies = tb.data.find((r) => r.id === ids.supplies);
      expect(supplies?.debitExact, basis).toBe('100.0000');
    }
    const legacy = await get(`/trial-balance?basis=cash&start_date=2026-01-01&end_date=2026-01-31&tag_id=${lakeId}`);
    expect(legacy.status).toBe(200);
    expect(legacy.body.totalDebits).toBe(legacy.body.totalCredits);
    expect(legacy.body.data.some((r: any) => 'pre_net' in r)).toBe(false);
  });
});

describe('S5: cash-basis A/R and A/P residue', () => {
  it('meta.cashArApResidue names what A/R and A/P keep on cash from entries other than payments', async () => {
    await paidInvoice('2026-01-03', '2026-01-20', '250.0000');
    await post('journal_entry', '2026-01-15', [dr(ids.ar, '300.0000'), cr(ids.sales, '300.0000')]);
    await post('journal_entry', '2026-01-16', [dr(ids.supplies, '80.0000'), cr(ids.ap, '80.0000')]);
    const bs = await get('/balance-sheet?exact=1&basis=cash&as_of_date=2026-01-31');
    expect(bs.status, JSON.stringify(bs.body)).toBe(200);
    expect(bs.body.meta.cashArApResidue).toEqual({
      accountsReceivableExact: '300.0000', accountsPayableExact: '80.0000',
      accountIds: [ids.ar, ids.ap].sort(), txnTypes: ['journal_entry'],
    });
    // It ties to the cash A/R balance on the sheet (the paid invoice leaves none).
    expect(bs.body.assets.find((a: any) => a.accountId === ids.ar).balanceExact).toBe('300.0000');
    // The cash GL selects exactly those lines.
    const res = bs.body.meta.cashArApResidue;
    const gl = await get(`/general-ledger?exact=1&basis=cash&start_date=2026-01-01&end_date=2026-01-31&account_ids=${ids.ar}&txn_types=${res.txnTypes.join(',')}`);
    expect(gl.body.accounts[0].endingBalanceExact).toBe('300.0000');
    // Trial Balance (cash) too; accrual and an earlier date: null.
    const tb = await get('/trial-balance?exact=1&basis=cash&start_date=2026-01-01&end_date=2026-01-31');
    expect(tb.body.meta.cashArApResidue.accountsReceivableExact).toBe('300.0000');
    expect((await get('/balance-sheet?exact=1&basis=accrual&as_of_date=2026-01-31')).body.meta.cashArApResidue).toBeNull();
    expect((await get('/balance-sheet?exact=1&basis=cash&as_of_date=2026-01-10')).body.meta.cashArApResidue).toBeNull();
    const cols = await get('/balance-sheet?exact=1&basis=cash&period_ranges=2026-01-01..2026-01-31');
    expect(cols.body.meta.cashArApResidue.accountsPayableExact).toBe('80.0000');
  });
});
