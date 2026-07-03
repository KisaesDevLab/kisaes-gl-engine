// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

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
import { reportsRouter } from './reports.routes.js';
import { errorHandler } from '../middleware/error-handler.js';

let server: Server | null = null;
let port = 0;
let token = '';
let tenantId = '';

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
    // Totals: debits = credits = 5000 (prior bank) + 1200 (current bank)
    // + 300 (expense)… TB shows bank cumulative 5900 debit, expense 300,
    // revenue 1200 credit, RE 5000 credit → 6200 each side.
    expect(r.body).toContain('"6,200.00"');
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
    expect(r.body).toContain('Retained Earnings (Prior Years)');
    expect(r.body).toContain('Net Income (Current Year)');
    expect(r.body).toContain('TOTAL LIABILITIES & EQUITY');
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
    expect(names).toContain('Retained Earnings (Prior Years)');
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
