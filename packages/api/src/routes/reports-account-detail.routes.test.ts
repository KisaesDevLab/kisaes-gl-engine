// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

// Route coverage for the "<Group> by Account" detail reports
// (Revenues / Assets / Liabilities / Equity) and the Expenses by Vendor
// detail mode. Guards:
//   - credit-normal groups (revenue, liability, equity) total on SUM(credit)
//     and their detail subtotal reads positive (credits − debits)
//   - debit-normal groups (assets) total on SUM(debit)
//   - the detail groups reuse the GL-style shape (lines + subtotal +
//     grandTotal) so the existing detail CSV export applies
//   - Expenses by Vendor ?display=detail returns per-vendor per-account
//     totals + a vendor total, and its CSV export mirrors the screen

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import 'express-async-errors';
import express from 'express';
import http from 'http';
import type { AddressInfo, Server } from 'net';
import { sql } from 'drizzle-orm';
import { db, pool } from '../db/index.js';
import { accounts, contacts } from '../db/schema/index.js';
import * as authService from '../services/auth.service.js';
import * as ledger from '../services/ledger.service.js';
import { reportsRouter } from './reports.routes.js';
import { errorHandler } from '../middleware/error-handler.js';

let server: Server | null = null;
let port = 0;
let token = '';
let tenantId = '';

const testEmail = `reports-acctdetail-${Date.now()}@example.com`;

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

interface RawResponse { status: number; contentType: string; body: string }

function get(path: string): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const r = http.request({
      method: 'GET', hostname: '127.0.0.1', port, path: `/api/v1/reports${path}`,
      headers: { Authorization: `Bearer ${token}` },
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode!, contentType: String(res.headers['content-type'] || ''), body: data }));
    });
    r.on('error', reject);
    r.end();
  });
}

const RANGE = 'start_date=2026-01-01&end_date=2026-12-31';

beforeAll(async () => {
  await cleanDb();
  const app = express();
  app.use(express.json());
  app.use('/api/v1/reports', reportsRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => { server = app.listen(0, () => { port = (server!.address() as AddressInfo).port; resolve(); }); });

  const result = await authService.register({ email: testEmail, password: 'password123456', displayName: 'AcctDetail', companyName: 'AcctDetail Co' });
  token = result.tokens.accessToken;
  tenantId = result.user.tenantId;
  const company = await db.query.companies.findFirst({ where: (c, { eq }) => eq(c.tenantId, tenantId) });
  const companyId = company!.id;

  const mk = async (name: string, num: string, type: 'asset' | 'liability' | 'equity' | 'revenue' | 'other_revenue' | 'expense', detailType?: string) => {
    const [a] = await db.insert(accounts).values({ tenantId, name, accountNumber: num, accountType: type, detailType: detailType ?? null }).returning();
    return a!;
  };
  const cash = await mk('Cash', '1000', 'asset', 'bank');
  const equipment = await mk('Equipment', '1500', 'asset', 'fixed_asset');
  const loan = await mk('Loan Payable', '2500', 'liability', 'long_term_liability');
  const equity = await mk("Owner's Capital", '3010', 'equity', 'owners_equity');
  const rev = await mk('Service Revenue', '4000', 'revenue');
  const otherRev = await mk('Interest Income', '4900', 'other_revenue');
  const advertising = await mk('Advertising', '6000', 'expense');
  const contractors = await mk('Contractors', '6500', 'expense');

  const [vendor] = await db.insert(contacts).values({ tenantId, contactType: 'vendor', displayName: 'Acme LLC' }).returning();

  const post = (date: string, lines: Array<{ accountId: string; debit: string; credit: string }>, contactId?: string) =>
    ledger.postTransaction(tenantId, { txnType: 'journal_entry', txnDate: date, contactId, lines }, undefined, companyId);

  // Revenue: cash debit, revenue credit (credit-normal).
  await post('2026-02-01', [{ accountId: cash.id, debit: '1000.00', credit: '0' }, { accountId: rev.id, debit: '0', credit: '1000.00' }]);
  await post('2026-03-01', [{ accountId: cash.id, debit: '250.00', credit: '0' }, { accountId: otherRev.id, debit: '0', credit: '250.00' }]);
  // Equity contribution: cash debit, equity credit.
  await post('2026-02-15', [{ accountId: cash.id, debit: '500.00', credit: '0' }, { accountId: equity.id, debit: '0', credit: '500.00' }]);
  // Loan received: cash debit, liability credit.
  await post('2026-04-01', [{ accountId: cash.id, debit: '2000.00', credit: '0' }, { accountId: loan.id, debit: '0', credit: '2000.00' }]);
  // Asset purchase: equipment debit, cash credit.
  await post('2026-05-01', [{ accountId: equipment.id, debit: '800.00', credit: '0' }, { accountId: cash.id, debit: '0', credit: '800.00' }]);
  // Expenses to the vendor across two accounts (for vendor detail).
  await post('2026-06-01', [{ accountId: advertising.id, debit: '300.00', credit: '0' }, { accountId: cash.id, debit: '0', credit: '300.00' }], vendor!.id);
  await post('2026-06-10', [{ accountId: contractors.id, debit: '700.00', credit: '0' }, { accountId: cash.id, debit: '0', credit: '700.00' }], vendor!.id);
}, 30000);

afterAll(async () => {
  await new Promise<void>((r) => server?.close(() => r()));
  await cleanDb();
  await pool.end();
});

describe('GET /reports/revenue-by-category (credit-normal)', () => {
  it('summary totals revenue on SUM(credit)', async () => {
    const data = JSON.parse((await get(`/revenue-by-category?${RANGE}`)).body);
    expect(data.title).toBe('Revenues by Category');
    const byName = Object.fromEntries(data.data.map((r: { category: string; total: string }) => [r.category, r]));
    expect(parseFloat(byName['Service Revenue'].total)).toBeCloseTo(1000, 4);
    expect(parseFloat(byName['Interest Income'].total)).toBeCloseTo(250, 4);
    // No expense/asset accounts leak in.
    expect(byName['Advertising']).toBeUndefined();
    expect(byName['Cash']).toBeUndefined();
  });

  it('detail subtotal reads positive (credits − debits) with a grandTotal', async () => {
    const data = JSON.parse((await get(`/revenue-by-category?${RANGE}&display=detail`)).body);
    const svc = data.groups.find((g: { name: string }) => g.name === 'Service Revenue');
    expect(svc.totalCredits).toBeCloseTo(1000, 4);
    expect(svc.subtotal).toBeCloseTo(1000, 4); // positive, not −1000
    expect(svc.lines[0].balance).toBeCloseTo(1000, 4);
    expect(data.grandTotal).toBeCloseTo(1250, 4);
  });
});

describe('GET /reports/assets-by-account & liabilities & equity', () => {
  it('assets are debit-normal', async () => {
    const data = JSON.parse((await get(`/assets-by-account?${RANGE}&display=detail`)).body);
    const equip = data.groups.find((g: { name: string }) => g.name === 'Equipment');
    expect(equip.subtotal).toBeCloseTo(800, 4); // debit − credit
    // Cash has many debits/credits; it appears and nets its period activity.
    expect(data.groups.some((g: { name: string }) => g.name === 'Cash')).toBe(true);
  });

  it('liabilities and equity are credit-normal', async () => {
    const liab = JSON.parse((await get(`/liabilities-by-account?${RANGE}&display=detail`)).body);
    const loan = liab.groups.find((g: { name: string }) => g.name === 'Loan Payable');
    expect(loan.subtotal).toBeCloseTo(2000, 4);

    const eq = JSON.parse((await get(`/equity-by-account?${RANGE}&display=detail`)).body);
    const cap = eq.groups.find((g: { name: string }) => g.name === "Owner's Capital");
    expect(cap.subtotal).toBeCloseTo(500, 4);
    expect(eq.title).toBe('Equity by Account');
  });

  it('detail CSV export mirrors the screen (reuses the GL-style branch)', async () => {
    const r = await get(`/revenue-by-category?${RANGE}&display=detail&format=csv`);
    expect(r.contentType).toContain('text/csv');
    expect(r.body).toContain('4000 — Service Revenue');
    expect(r.body).toContain('Total 4000 — Service Revenue');
    expect(r.body).toContain('TOTAL');
  });
});

describe('GET /reports/expense-by-vendor?display=detail', () => {
  it('groups per-account totals under each vendor with a vendor total', async () => {
    const data = JSON.parse((await get(`/expense-by-vendor?${RANGE}&display=detail`)).body);
    // Summary rows still present alongside detail groups.
    expect(Array.isArray(data.data)).toBe(true);
    const acme = data.groups.find((g: { vendorName: string }) => g.vendorName === 'Acme LLC');
    expect(acme.total).toBeCloseTo(1000, 4);
    const acctNames = acme.accounts.map((a: { name: string }) => a.name);
    expect(acctNames).toContain('Advertising');
    expect(acctNames).toContain('Contractors');
    const contractors = acme.accounts.find((a: { name: string }) => a.name === 'Contractors');
    expect(contractors.total).toBeCloseTo(700, 4);
    // Accounts ordered by descending total (Contractors 700 before Advertising 300).
    expect(acme.accounts[0].name).toBe('Contractors');
  });

  it('detail CSV export lists vendor header, account rows, and vendor subtotal', async () => {
    const r = await get(`/expense-by-vendor?${RANGE}&display=detail&format=csv`);
    expect(r.contentType).toContain('text/csv');
    expect(r.body).toContain('Acme LLC');
    expect(r.body).toContain('Contractors');
    expect(r.body).toContain('Total Acme LLC');
    expect(r.body).toContain('"700.00"');
  });

  it('default (summary) response is unchanged — no groups', async () => {
    const data = JSON.parse((await get(`/expense-by-vendor?${RANGE}`)).body);
    expect(data.groups).toBeUndefined();
    expect(Array.isArray(data.data)).toBe(true);
  });
});
