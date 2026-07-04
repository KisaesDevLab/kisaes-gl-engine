// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

// Route-level coverage for the rebuilt Expenses by Category report
// (GET /reports/expense-by-category). Guards:
//   - the DEFAULT response keeps the legacy summary shape (api-v2 / MCP
//     compat): { title, startDate, endDate, data } with SUM(jl.debit)
//     semantics — refund credits do NOT reduce summary totals
//   - ?display=detail returns GL-style groups with correct lines,
//     running balances, per-account subtotals (net of credits) and a
//     grandTotal — while `data` keeps the summary rows
//   - a credit line (expense refund) appears in detail and the subtotal
//     nets it out
//   - ?account_ids filters BOTH modes; explicitly selected accounts with
//     zero activity still get an empty $0 section in detail mode;
//     malformed ids are dropped
//   - detail CSV export mirrors the screen: account section header,
//     transaction lines, per-account subtotal row, grand TOTAL row
//   - summary CSV export is unchanged

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import 'express-async-errors';
import express from 'express';
import http from 'http';
import type { AddressInfo, Server } from 'net';
import { sql } from 'drizzle-orm';
import { db, pool } from '../db/index.js';
import { accounts } from '../db/schema/index.js';
import * as authService from '../services/auth.service.js';
import * as ledger from '../services/ledger.service.js';
import { reportsRouter } from './reports.routes.js';
import { errorHandler } from '../middleware/error-handler.js';

let server: Server | null = null;
let port = 0;
let token = '';
let tenantId = '';

let rentId = '';
let utilitiesId = '';
let travelId = '';

const testEmail = `reports-expcat-${Date.now()}@example.com`;

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

const RANGE = 'start_date=2026-01-01&end_date=2026-12-31';

beforeAll(async () => {
  await cleanDb();
  await startApp();

  const result = await authService.register({
    email: testEmail,
    password: 'password123456',
    displayName: 'ExpCat Test',
    companyName: 'ExpCat Co',
  });
  token = result.tokens.accessToken;
  tenantId = result.user.tenantId;

  const company = await db.query.companies.findFirst({
    where: (c, { eq }) => eq(c.tenantId, tenantId),
  });
  const companyId = company!.id;

  const mk = async (name: string, accountNumber: string, accountType: 'asset' | 'revenue' | 'expense') => {
    const [a] = await db.insert(accounts).values({ tenantId, name, accountNumber, accountType }).returning();
    return a!;
  };

  const cash = await mk('Test Cash', '1001', 'asset');
  const sales = await mk('Test Sales', '4001', 'revenue');
  const rent = await mk('Rent Expense', '6000', 'expense');
  const utilities = await mk('Utilities Expense', '6100', 'expense');
  const travel = await mk('Travel Expense', '6200', 'expense'); // no activity
  rentId = rent.id;
  utilitiesId = utilities.id;
  travelId = travel.id;

  const post = (date: string, memo: string, lines: Array<{ accountId: string; debit: string; credit: string; description?: string }>) =>
    ledger.postTransaction(tenantId, { txnType: 'journal_entry', txnDate: date, memo, lines }, undefined, companyId);

  await post('2026-01-15', 'January rent', [
    { accountId: rent.id, debit: '1000.00', credit: '0' },
    { accountId: cash.id, debit: '0', credit: '1000.00' },
  ]);
  await post('2026-02-10', 'February rent', [
    { accountId: rent.id, debit: '500.00', credit: '0', description: 'Feb office rent' },
    { accountId: cash.id, debit: '0', credit: '500.00' },
  ]);
  await post('2026-03-01', 'Power bill', [
    { accountId: utilities.id, debit: '200.00', credit: '0' },
    { accountId: cash.id, debit: '0', credit: '200.00' },
  ]);
  // Expense refund — CREDIT to the rent account.
  await post('2026-03-20', 'Rent refund', [
    { accountId: cash.id, debit: '100.00', credit: '0' },
    { accountId: rent.id, debit: '0', credit: '100.00' },
  ]);
  // Revenue transaction — its credit hits a revenue account; must never
  // appear on this report.
  await post('2026-04-01', 'A sale', [
    { accountId: cash.id, debit: '300.00', credit: '0' },
    { accountId: sales.id, debit: '0', credit: '300.00' },
  ]);
  // Out of the report range — must be excluded.
  await post('2027-01-05', 'Next-year rent', [
    { accountId: rent.id, debit: '999.00', credit: '0' },
    { accountId: cash.id, debit: '0', credit: '999.00' },
  ]);
}, 30000);

afterAll(async () => {
  await new Promise<void>((r) => server?.close(() => r()));
  await cleanDb();
  await pool.end();
});

describe('GET /reports/expense-by-category (summary — default)', () => {
  it('keeps the legacy summary shape and SUM(debit) semantics', async () => {
    const r = await get(`/expense-by-category?${RANGE}`);
    expect(r.status).toBe(200);
    const data = JSON.parse(r.body);

    expect(data.title).toBe('Expenses by Category');
    expect(data.startDate).toBe('2026-01-01');
    expect(data.endDate).toBe('2026-12-31');
    // Detail-mode fields must NOT ride along on the default response.
    expect(data.groups).toBeUndefined();
    expect(data.grandTotal).toBeUndefined();

    const byName = Object.fromEntries(data.data.map((row: { category: string; total: string }) => [row.category, row]));
    // Debits only — the $100 refund credit does NOT reduce the summary.
    expect(parseFloat(byName['Rent Expense'].total)).toBeCloseTo(1500, 4);
    expect(parseFloat(byName['Utilities Expense'].total)).toBeCloseTo(200, 4);
    // Revenue and zero-activity accounts never appear in the summary.
    expect(byName['Test Sales']).toBeUndefined();
    expect(byName['Travel Expense']).toBeUndefined();
  });

  it('filters the summary by account_ids', async () => {
    const r = await get(`/expense-by-category?${RANGE}&account_ids=${rentId}`);
    const data = JSON.parse(r.body);
    expect(data.data).toHaveLength(1);
    expect(data.data[0].category).toBe('Rent Expense');
  });

  it('drops malformed account_ids entries instead of failing', async () => {
    const r = await get(`/expense-by-category?${RANGE}&account_ids=${rentId},not-a-uuid`);
    expect(r.status).toBe(200);
    const data = JSON.parse(r.body);
    expect(data.data).toHaveLength(1);
    expect(data.data[0].category).toBe('Rent Expense');
  });

  it('summary CSV export is unchanged', async () => {
    const r = await get(`/expense-by-category?${RANGE}&format=csv`);
    expect(r.status).toBe(200);
    expect(r.contentType).toContain('text/csv');
    expect(r.body).toContain('"#","Category","Total"');
    expect(r.body).toContain('Rent Expense');
    expect(r.body).toContain('"1,500.00"');
  });
});

describe('GET /reports/expense-by-category?display=detail', () => {
  it('returns GL-style groups with lines, running balances, netted subtotals and a grandTotal', async () => {
    const r = await get(`/expense-by-category?${RANGE}&display=detail`);
    expect(r.status).toBe(200);
    const data = JSON.parse(r.body);

    // Summary rows still present alongside the detail groups.
    expect(Array.isArray(data.data)).toBe(true);

    // Only accounts with activity (no account_ids selection).
    expect(data.groups).toHaveLength(2);
    const names = data.groups.map((g: { name: string }) => g.name);
    expect(names).toContain('Rent Expense');
    expect(names).toContain('Utilities Expense');
    expect(names).not.toContain('Travel Expense');
    expect(names).not.toContain('Test Sales');

    const rent = data.groups.find((g: { name: string }) => g.name === 'Rent Expense');
    expect(rent.accountId).toBe(rentId);
    expect(rent.accountNumber).toBe('6000');
    expect(rent.accountType).toBe('expense');

    // 3 lines in date order: 1000 D, 500 D, 100 C (refund) — the 2027
    // transaction is outside the range.
    expect(rent.lines).toHaveLength(3);
    const [l1, l2, l3] = rent.lines;
    expect(l1.date).toBe('2026-01-15');
    expect(l1.debit).toBeCloseTo(1000, 4);
    expect(l1.balance).toBeCloseTo(1000, 4);
    expect(l1.memo).toBe('January rent'); // falls back to the txn memo
    expect(l1.txnType).toBe('journal_entry');
    expect(l1.transactionId).toBeTruthy();

    expect(l2.date).toBe('2026-02-10');
    expect(l2.memo).toBe('Feb office rent'); // line description preferred
    expect(l2.balance).toBeCloseTo(1500, 4);

    // The expense-refund CREDIT appears in detail...
    expect(l3.date).toBe('2026-03-20');
    expect(l3.credit).toBeCloseTo(100, 4);
    expect(l3.debit).toBeCloseTo(0, 4);
    expect(l3.balance).toBeCloseTo(1400, 4);

    // ...and the subtotal nets it out (1500 − 100).
    expect(rent.totalDebits).toBeCloseTo(1500, 4);
    expect(rent.totalCredits).toBeCloseTo(100, 4);
    expect(rent.subtotal).toBeCloseTo(1400, 4);

    const utilities = data.groups.find((g: { name: string }) => g.name === 'Utilities Expense');
    expect(utilities.lines).toHaveLength(1);
    expect(utilities.subtotal).toBeCloseTo(200, 4);

    expect(data.grandTotal).toBeCloseTo(1600, 4); // 1400 + 200
  });

  it('account_ids filters the groups, and a selected zero-activity account gets an empty $0 section', async () => {
    const r = await get(`/expense-by-category?${RANGE}&display=detail&account_ids=${rentId},${travelId}`);
    const data = JSON.parse(r.body);

    expect(data.groups).toHaveLength(2);
    const rent = data.groups.find((g: { accountId: string }) => g.accountId === rentId);
    const travel = data.groups.find((g: { accountId: string }) => g.accountId === travelId);
    expect(rent.subtotal).toBeCloseTo(1400, 4);
    // Explicitly selected but no activity: empty section at $0.
    expect(travel.lines).toHaveLength(0);
    expect(travel.subtotal).toBe(0);
    // Utilities was not selected — excluded from groups AND the total.
    expect(data.groups.find((g: { accountId: string }) => g.accountId === utilitiesId)).toBeUndefined();
    expect(data.grandTotal).toBeCloseTo(1400, 4);
  });

  it('detail CSV export mirrors the screen: section header, lines, subtotal, grand TOTAL', async () => {
    const r = await get(`/expense-by-category?${RANGE}&display=detail&format=csv`);
    expect(r.status).toBe(200);
    expect(r.contentType).toContain('text/csv');
    expect(r.body).toContain('"Date","Type","Number","Name","Memo","Debit","Credit","Balance"');
    // Account section header (lands in the Memo column for CSV).
    expect(r.body).toContain('6000 — Rent Expense');
    // A transaction line with its date and amount.
    expect(r.body).toContain('2026-01-15');
    expect(r.body).toContain('"1,000.00"');
    // Per-account subtotal (netted) and the grand TOTAL.
    expect(r.body).toContain('Total 6000 — Rent Expense');
    expect(r.body).toContain('"1,400.00"');
    expect(r.body).toContain('TOTAL');
    expect(r.body).toContain('"1,600.00"');
  });
});
