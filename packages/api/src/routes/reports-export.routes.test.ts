// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Route-level coverage for the report CSV export path (?format=csv).
// Reproduces the "cannot export the trial balance to CSV" report and
// guards the Trial Balance / Balance Sheet / P&L CSV branches against
// regressions — including the virtual Retained Earnings rows (id: null)
// injected by buildTrialBalance / buildBalanceSheet.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import 'express-async-errors';
import express from 'express';
import http from 'http';
import type { AddressInfo, Server } from 'net';
import { sql } from 'drizzle-orm';
import { db, pool } from '../db/index.js';
import * as authService from '../services/auth.service.js';
import * as ledger from '../services/ledger.service.js';
import { reportsRouter, extractDataAndColumns, buildHtmlTable } from './reports.routes.js';
import { errorHandler } from '../middleware/error-handler.js';

let server: Server | null = null;
let port = 0;
let token = '';
let tenantId = '';
let revenueName = '';
let expenseName = '';

const testEmail = `reports-export-${Date.now()}@example.com`;

async function cleanDb() {
  await db.execute(sql`TRUNCATE
    audit_log, journal_lines, transaction_tags, payment_applications, deposit_lines,
    recurring_schedules, budget_lines, budgets,
    bank_feed_items, reconciliation_lines, reconciliations,
    plaid_account_mappings, plaid_accounts, plaid_items, bank_connections,
    transactions, contacts, tags, tag_groups, api_keys, sessions,
    accounts, companies, users, tenants
    CASCADE`);
}

async function startApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/reports', reportsRouter);
  app.use(errorHandler);
  return new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      port = (server!.address() as AddressInfo).port;
      resolve();
    });
  });
}

interface RawResponse {
  status: number;
  contentType: string;
  body: string;
}

function get(path: string): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const r = http.request({
      method: 'GET', hostname: '127.0.0.1', port, path: `/api/v1/reports${path}`,
      headers: { Authorization: `Bearer ${token}` },
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({
        status: res.statusCode!,
        contentType: String(res.headers['content-type'] || ''),
        body: data,
      }));
    });
    r.on('error', reject);
    r.end();
  });
}

// File-level setup/teardown — both describes below share the server,
// tenant, and seeded postings.
beforeAll(async () => {
    await cleanDb();
    await startApp();

    const result = await authService.register({
      email: testEmail,
      password: 'password123456',
      displayName: 'Reports Export Test',
      companyName: 'Reports Export Co',
    });
    token = result.tokens.accessToken;
    tenantId = result.user.tenantId;

    // Reports scope to the request's company (X-Company-Id, or the
    // tenant's first company) — post against that same company.
    const company = await db.query.companies.findFirst({
      where: (c, { eq }) => eq(c.tenantId, tenantId),
    });
    const companyId = company!.id;

    // Seeded COA — pick a bank, revenue, and expense account.
    const allAccounts = await db.query.accounts.findMany({
      where: (a, { eq }) => eq(a.tenantId, tenantId),
    });
    const bank = allAccounts.find((a) => a.accountType === 'asset' && (a.detailType === 'checking' || a.detailType === 'bank'))
      || allAccounts.find((a) => a.accountType === 'asset')!;
    const revenue = allAccounts.find((a) => a.accountType === 'revenue')!;
    const expense = allAccounts.find((a) => a.accountType === 'expense')!;
    revenueName = revenue.name;
    expenseName = expense.name;

    const post = (date: string, memo: string, lines: Array<{ accountId: string; debit: string; credit: string }>) =>
      ledger.postTransaction(tenantId, { txnType: 'journal_entry', txnDate: date, memo, lines }, undefined, companyId);

    // PRIOR fiscal year income → forces the virtual Retained Earnings
    // (Prior Years) row on TB (id: null, account_number '30120') and on
    // the Balance Sheet equity section (accountId: null).
    await post('2025-06-01', 'Prior-year revenue', [
      { accountId: bank.id, debit: '5000.00', credit: '0' },
      { accountId: revenue.id, debit: '0', credit: '5000.00' },
    ]);
    // Current-year activity.
    await post('2026-02-01', 'Current revenue', [
      { accountId: bank.id, debit: '1200.00', credit: '0' },
      { accountId: revenue.id, debit: '0', credit: '1200.00' },
    ]);
    await post('2026-03-01', 'Current expense', [
      { accountId: expense.id, debit: '300.00', credit: '0' },
      { accountId: bank.id, debit: '0', credit: '300.00' },
    ]);
}, 30000);

afterAll(async () => {
  await new Promise<void>((r) => server?.close(() => r()));
  await cleanDb();
  await pool.end();
});

describe('report CSV exports (route-level, ?format=csv)', () => {
  it('trial balance exports CSV including the virtual Retained Earnings row', async () => {
    const r = await get('/trial-balance?start_date=2026-01-01&end_date=2026-12-31&format=csv');
    expect(r.status).toBe(200);
    expect(r.contentType).toContain('text/csv');
    expect(r.body).toContain('"#","Account","Type","Debit","Credit"');
    expect(r.body).toContain('Retained Earnings (Prior Years)');
    expect(r.body).toContain('TOTALS');
    // Netted TB totals: debit side = bank 5,900 (6,200 dr − 300 cr)
    // + expense 300; credit side = revenue 1,200 + virtual RE 5,000
    // → 6,200 each side.
    expect(r.body).toContain('"6,200.00"');
    expect(r.body).toContain('"5,900.00"');
  });

  it('trial balance JSON uses proper netted format (one column per account)', async () => {
    const r = await get('/trial-balance?start_date=2026-01-01&end_date=2026-12-31');
    expect(r.status).toBe(200);
    const data = JSON.parse(r.body);
    type TbRow = { name: string; debit: number; credit: number; total_debit: number; total_credit: number };
    const rows = data.data as TbRow[];

    // Net-credit account (revenue) shows ONLY in the credit column.
    const rev = rows.find((x) => x.name === revenueName)!;
    expect(rev.credit).toBeCloseTo(1200, 2);
    expect(rev.debit).toBe(0);

    // Mixed-activity bank account nets to a single debit figure
    // (6,200 dr − 300 cr = 5,900), while the legacy gross-activity
    // fields stay available for API compatibility.
    const bank = rows.find((x) => x.total_debit === 6200)!;
    expect(bank).toBeDefined();
    expect(bank.debit).toBeCloseTo(5900, 2);
    expect(bank.credit).toBe(0);
    expect(bank.total_credit).toBeCloseTo(300, 2);

    // Virtual Retained Earnings row still injected, netted credit-side.
    const re = rows.find((x) => x.name === 'Retained Earnings (Prior Years)')!;
    expect(re.credit).toBeCloseTo(5000, 2);
    expect(re.debit).toBe(0);

    // Totals are the netted column sums — and they tie.
    expect(data.totalDebits).toBeCloseTo(6200, 2);
    expect(data.totalCredits).toBeCloseTo(6200, 2);
  });

  it('account activity summary returns gross debits/credits + signed net', async () => {
    const r = await get('/account-activity-summary?start_date=2026-01-01&end_date=2026-12-31');
    expect(r.status).toBe(200);
    const data = JSON.parse(r.body);
    type ActRow = { name: string; total_debit: number; total_credit: number; net: number };
    const rows = data.data as ActRow[];

    // Plain period activity: BOTH columns populated for the bank
    // (1,200 in, 300 out — the 2025 posting is outside the range).
    const bank = rows.find((x) => x.total_debit === 1200 && x.total_credit === 300)!;
    expect(bank).toBeDefined();
    expect(bank.net).toBeCloseTo(900, 2);

    // Net is SIGNED: a credit-heavy account goes negative.
    const rev = rows.find((x) => x.name === revenueName)!;
    expect(rev.total_credit).toBeCloseTo(1200, 2);
    expect(rev.net).toBeCloseTo(-1200, 2);

    // No virtual RE row on an activity report.
    expect(rows.some((x) => x.name === 'Retained Earnings (Prior Years)')).toBe(false);

    // Activity totals tie (posted entries balance) and net sums to zero.
    expect(data.totalDebits).toBeCloseTo(1500, 2);
    expect(data.totalCredits).toBeCloseTo(1500, 2);
    expect(data.totalNet).toBeCloseTo(0, 2);
  });

  it('account activity summary exports CSV with a TOTALS row', async () => {
    const r = await get('/account-activity-summary?start_date=2026-01-01&end_date=2026-12-31&format=csv');
    expect(r.status).toBe(200);
    expect(r.contentType).toContain('text/csv');
    expect(r.body).toContain('"#","Account","Type","Total Debits","Total Credits","Net"');
    expect(r.body).toContain('TOTALS');
    expect(r.body).toContain('"1,500.00"');
  });

  it('trial balance CSV neutralizes null ids and never leaks internal keys', async () => {
    const r = await get('/trial-balance?start_date=2026-01-01&end_date=2026-12-31&format=csv');
    expect(r.status).toBe(200);
    expect(r.body).not.toContain('null');
    expect(r.body).not.toContain('[object Object]');
  });

  it('balance sheet exports CSV with computed equity rows', async () => {
    const r = await get('/balance-sheet?as_of_date=2026-12-31&format=csv');
    expect(r.status).toBe(200);
    expect(r.contentType).toContain('text/csv');
    // Prior-years retained earnings folds into the designated system RE account
    // line (QBO-style), so there's no separate "(Prior Years)" row.
    expect(r.body).toContain('Retained Earnings');
    expect(r.body).not.toContain('Retained Earnings (Prior Years)');
    expect(r.body).toContain('Net Income (Current Year)');
    expect(r.body).toContain('TOTAL LIABILITIES & EQUITY');
  });

  it('P&L and Balance Sheet titles carry the accounting basis', async () => {
    const acc = JSON.parse((await get('/profit-loss?start_date=2026-01-01&end_date=2026-12-31')).body);
    expect(acc.title).toBe('Profit and Loss - Accrual Basis');
    const cash = JSON.parse((await get('/profit-loss?start_date=2026-01-01&end_date=2026-12-31&basis=cash')).body);
    expect(cash.title).toBe('Profit and Loss - Cash Basis');
    const bs = JSON.parse((await get('/balance-sheet?as_of_date=2026-12-31')).body);
    expect(bs.title).toBe('Balance Sheet - Accrual Basis');
    const cmp = JSON.parse((await get('/profit-loss?start_date=2026-01-01&end_date=2026-12-31&compare=previous_year')).body);
    expect(cmp.title).toBe('Profit and Loss (Comparative) - Accrual Basis');
  });

  it('profit and loss exports CSV with section totals', async () => {
    const r = await get('/profit-loss?start_date=2026-01-01&end_date=2026-12-31&format=csv');
    expect(r.status).toBe(200);
    expect(r.contentType).toContain('text/csv');
    expect(r.body).toContain('Total Revenue');
    expect(r.body).toContain('NET INCOME');
    expect(r.body).toContain('"1,200.00"');
  });
});

describe('group_by=detail_type (P&L / Balance Sheet)', () => {
  it('P&L default response has no groups key (shape unchanged)', async () => {
    const r = await get('/profit-loss?start_date=2026-01-01&end_date=2026-12-31');
    expect(r.status).toBe(200);
    const data = JSON.parse(r.body);
    expect(data.groups).toBeUndefined();
    expect(data.groupBy).toBeUndefined();
    expect(data.revenue[0].detailType).toBeUndefined();
  });

  it('P&L grouped response adds groups + entry detailType, totals unchanged', async () => {
    const base = JSON.parse((await get('/profit-loss?start_date=2026-01-01&end_date=2026-12-31')).body);
    const r = await get('/profit-loss?start_date=2026-01-01&end_date=2026-12-31&group_by=detail_type');
    expect(r.status).toBe(200);
    const data = JSON.parse(r.body);
    expect(data.groupBy).toBe('detail_type');
    expect(data.groups).toBeDefined();
    // Totals must not shift when grouping is requested.
    expect(data.totalRevenue).toBe(base.totalRevenue);
    expect(data.totalExpenses).toBe(base.totalExpenses);
    expect(data.netIncome).toBe(base.netIncome);
    // Entries carry detailType; groups subtotal to the section total.
    for (const entry of data.revenue) expect('detailType' in entry).toBe(true);
    const revSubtotals = data.groups.revenue.reduce((s: number, g: { subtotal: number }) => s + g.subtotal, 0);
    expect(revSubtotals).toBeCloseTo(data.totalRevenue, 4);
    const expSubtotals = data.groups.expenses.reduce((s: number, g: { subtotal: number }) => s + g.subtotal, 0);
    expect(expSubtotals).toBeCloseTo(data.totalExpenses, 4);
    // Labels are humanized ('service' → 'Service', null → 'Other').
    for (const g of data.groups.revenue) {
      expect(typeof g.label).toBe('string');
      expect(g.label.length).toBeGreaterThan(0);
      expect(g.label).not.toMatch(/_/);
    }
  });

  it('Balance Sheet grouped response puts computed rows under Equity (Calculated)', async () => {
    const base = JSON.parse((await get('/balance-sheet?as_of_date=2026-12-31')).body);
    const r = await get('/balance-sheet?as_of_date=2026-12-31&group_by=detail_type');
    expect(r.status).toBe(200);
    const data = JSON.parse(r.body);
    expect(data.groupBy).toBe('detail_type');
    expect(data.totalAssets).toBe(base.totalAssets);
    expect(data.totalEquity).toBe(base.totalEquity);
    expect(data.totalLiabilitiesAndEquity).toBe(base.totalLiabilitiesAndEquity);
    const calc = data.groups.equity.find((g: { label: string }) => g.label === 'Equity (Calculated)');
    expect(calc).toBeDefined();
    const names = calc.entries.map((e: { name: string }) => e.name);
    // Prior-years RE folds into the designated account (a real 'Retained
    // Earnings' detail group), so only Net Income (Current Year) is calculated.
    expect(names).not.toContain('Retained Earnings (Prior Years)');
    expect(names).toContain('Net Income (Current Year)');
    // Asset group subtotals foot to Total Assets.
    const assetSubtotals = data.groups.assets.reduce((s: number, g: { subtotal: number }) => s + g.subtotal, 0);
    expect(assetSubtotals).toBeCloseTo(data.totalAssets, 4);
  });

  it('grouped CSV export includes a Detail Type column (P&L and BS)', async () => {
    const pl = await get('/profit-loss?start_date=2026-01-01&end_date=2026-12-31&group_by=detail_type&format=csv');
    expect(pl.status).toBe(200);
    expect(pl.body).toContain('"Account","Detail Type","Amount"');
    const bs = await get('/balance-sheet?as_of_date=2026-12-31&group_by=detail_type&format=csv');
    expect(bs.status).toBe(200);
    expect(bs.body).toContain('"Account","Detail Type","Balance"');
    expect(bs.body).toContain('Equity (Calculated)');
    // Ungrouped CSV keeps the original two-column layout.
    const plPlain = await get('/profit-loss?start_date=2026-01-01&end_date=2026-12-31&format=csv');
    expect(plPlain.body).toContain('"Account","Amount"');
  });
});

describe('comparative grouping + condensed / export presentation', () => {
  it('comparative P&L grouped: per-group subtotals carry values for every column', async () => {
    const r = await get('/profit-loss?start_date=2026-01-01&end_date=2026-12-31&compare=previous_year&group_by=detail_type');
    expect(r.status).toBe(200);
    const data = JSON.parse(r.body);
    expect(data.groupBy).toBe('detail_type');
    expect(data.groups).toBeDefined();
    // Existing comparative shape untouched.
    expect(Array.isArray(data.rows)).toBe(true);
    expect(data.columns.length).toBe(4);

    for (const section of ['revenue', 'expenses'] as const) {
      // Cost sections flip the change columns (favorability): spending more is
      // a negative change. Revenue stays raw. Amount columns (0,1) never flip.
      const sign = section === 'expenses' ? -1 : 1;
      const groups = data.groups[section] as Array<{ label: string; rows: Array<{ values: Array<number | null> }>; values: Array<number | null> }>;
      for (const g of groups) {
        // Period columns (0 = current, 1 = prior) are plain sums of the
        // member rows; the change columns are re-derived from the sums.
        for (const colIdx of [0, 1]) {
          const sum = g.rows.reduce((a, row) => a + (row.values[colIdx] ?? 0), 0);
          expect(g.values[colIdx]).toBeCloseTo(sum, 4);
        }
        expect(g.values[2]).toBeCloseTo(sign * ((g.values[0] ?? 0) - (g.values[1] ?? 0)), 4);
        const prior = g.values[1] ?? 0;
        if (prior === 0) expect(g.values[3]).toBeNull();
        else expect(g.values[3]).toBeCloseTo(sign * (((g.values[0] ?? 0) - prior) / Math.abs(prior)) * 100, 4);
      }
      // Group subtotals foot to the section totals, column for column.
      for (const colIdx of [0, 1]) {
        const total = groups.reduce((a, g) => a + (g.values[colIdx] ?? 0), 0);
        const sectionTotals = section === 'revenue' ? data.totalRevenue : data.totalExpenses;
        expect(total).toBeCloseTo(sectionTotals[colIdx] ?? 0, 4);
      }
    }
  });

  it('comparative BS grouped: Equity (Calculated) group + column-wise footing', async () => {
    const r = await get('/balance-sheet?as_of_date=2026-12-31&compare=previous_year&group_by=detail_type');
    expect(r.status).toBe(200);
    const data = JSON.parse(r.body);
    expect(data.groups).toBeDefined();
    const calc = data.groups.equity.find((g: { label: string }) => g.label === 'Equity (Calculated)');
    expect(calc).toBeDefined();
    // Asset groups foot to Total Assets for both period columns.
    for (const colIdx of [0, 1]) {
      const sum = data.groups.assets.reduce((a: number, g: { values: Array<number | null> }) => a + (g.values[colIdx] ?? 0), 0);
      expect(sum).toBeCloseTo(data.totalAssets[colIdx] ?? 0, 4);
    }
  });

  it('comparative CSV honors grouped and condensed display modes', async () => {
    const grouped = await get('/profit-loss?start_date=2026-01-01&end_date=2026-12-31&compare=previous_year&group_by=detail_type&format=csv');
    expect(grouped.status).toBe(200);
    expect(grouped.body).toContain(revenueName);      // account rows present
    expect(grouped.body).toContain('"Total ');        // group subtotal rows

    const condensed = await get('/profit-loss?start_date=2026-01-01&end_date=2026-12-31&compare=previous_year&group_by=detail_type&display=condensed&format=csv');
    expect(condensed.status).toBe(200);
    expect(condensed.body).not.toContain(revenueName); // no account rows
    expect(condensed.body).toContain('Total Revenue'); // section totals stay
  });

  it('standard condensed CSV drops account rows but keeps group + section totals', async () => {
    const r = await get('/profit-loss?start_date=2026-01-01&end_date=2026-12-31&group_by=detail_type&display=condensed&format=csv');
    expect(r.status).toBe(200);
    expect(r.body).not.toContain(revenueName);
    expect(r.body).not.toContain(expenseName);
    expect(r.body).toContain('Total Revenue');
    expect(r.body).toContain('NET INCOME');
  });

  it('standard P&L CSV can mirror the %-of-Revenue column (?show_pct=1)', async () => {
    const r = await get('/profit-loss?start_date=2026-01-01&end_date=2026-12-31&show_pct=1&format=csv');
    expect(r.status).toBe(200);
    expect(r.body).toContain('% of Revenue');
    expect(r.body).toContain('"100.0%"');
  });

  it('comparative P&L CSV gains a companion % column per period (?show_pct=1)', async () => {
    const r = await get('/profit-loss?start_date=2026-01-01&end_date=2026-12-31&compare=previous_year&show_pct=1&format=csv');
    expect(r.status).toBe(200);
    const header = r.body.split('\n')[0]!;
    // One "<period label> %" header per period column; variance / % change
    // columns are ratios already and must NOT get a companion.
    expect((header.match(/ %"/g) || []).length).toBe(2);
    expect(header).not.toContain('$ Change %');
    expect(header).not.toContain('% Change %');
    // Common-size: the Total Revenue row reads 100.0% in a period column.
    expect(r.body).toContain('"100.0%"');

    // Without the flag the comparative export shape is unchanged.
    const plain = await get('/profit-loss?start_date=2026-01-01&end_date=2026-12-31&compare=previous_year&format=csv');
    expect((plain.body.split('\n')[0]!.match(/ %"/g) || []).length).toBe(0);
  });

  it('comparative BS CSV exports rows (pre-existing "No data" gate bug)', async () => {
    // Before the gate fix, the comparative BS (which has no `rows` key)
    // fell through to the generic path and exported 404 "No data".
    const r = await get('/balance-sheet?as_of_date=2026-12-31&compare=previous_year&format=csv');
    expect(r.status).toBe(200);
    expect(r.contentType).toContain('text/csv');
    expect(r.body).toContain('Total Assets');
    expect(r.body).toContain('TOTAL LIABILITIES & EQUITY');
  });

  it('PDF HTML mirrors the on-screen presentation for grouped and condensed', async () => {
    // Assert on the export HTML directly (extractDataAndColumns +
    // buildHtmlTable are exactly what the PDF pipeline feeds Puppeteer)
    // so the test does not need a Chromium install.
    const groupedData = JSON.parse((await get('/profit-loss?start_date=2026-01-01&end_date=2026-12-31&group_by=detail_type')).body);
    const g = extractDataAndColumns(groupedData);
    const groupedHtml = buildHtmlTable(g.rows, g.columns);
    expect(groupedHtml).toContain(revenueName);          // member accounts
    expect(groupedHtml).toContain('padding-left:22px');  // indented under group headers
    expect(groupedHtml).toContain('Total ');             // group subtotal rows

    const condensedData = JSON.parse((await get('/profit-loss?start_date=2026-01-01&end_date=2026-12-31&group_by=detail_type&display=condensed')).body);
    const c = extractDataAndColumns({ ...condensedData, display: 'condensed' });
    const condensedHtml = buildHtmlTable(c.rows, c.columns);
    expect(condensedHtml).not.toContain(revenueName);    // subtotals only
    expect(condensedHtml).toContain('NET INCOME');

    // Comparative BS grouped HTML carries the calculated-equity group label.
    const cbs = JSON.parse((await get('/balance-sheet?as_of_date=2026-12-31&compare=previous_year&group_by=detail_type')).body);
    const b = extractDataAndColumns(cbs);
    const bsHtml = buildHtmlTable(b.rows, b.columns);
    expect(bsHtml).toContain('Equity (Calculated)');
  });

  it('Transaction List hints landscape and rules between transaction groups', async () => {
    const data = JSON.parse((await get('/transaction-list?start_date=2026-01-01&end_date=2026-12-31')).body);
    expect(data._landscape).toBe(true);
    const rows = data.data as Array<{ id: string; _groupStart?: boolean }>;
    expect(rows.length).toBeGreaterThan(2);
    expect(rows[0]!._groupStart).toBeFalsy(); // first row never a boundary
    // A boundary appears exactly when the transaction id changes.
    for (let i = 1; i < rows.length; i++) {
      expect(!!rows[i]!._groupStart).toBe(rows[i]!.id !== rows[i - 1]!.id);
    }
    // The thicker group rule renders in the PDF HTML.
    const html = buildHtmlTable(extractDataAndColumns(data).rows, extractDataAndColumns(data).columns);
    expect(html).toContain('border-top:2px solid #9ca3af');
  });
});
