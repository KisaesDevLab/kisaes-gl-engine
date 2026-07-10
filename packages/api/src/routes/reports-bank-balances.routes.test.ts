// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Route-level coverage for the Bank Account Balances report
// (GET /reports/bank-balances). Guards:
//   - only bank-detail-type asset accounts appear (non-bank assets don't)
//   - the as-of cutoff excludes transactions after the report date
//   - draft transactions never contribute to balances
//   - active bank accounts appear even at $0; inactive ones only while
//     they still carry a nonzero balance (flagged " (inactive)")
//   - CSV export works and carries the account name + TOTAL row

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import 'express-async-errors';
import express from 'express';
import http from 'http';
import type { AddressInfo, Server } from 'net';
import { sql } from 'drizzle-orm';
import { db, pool } from '../db/index.js';
import { accounts, transactions, journalLines } from '../db/schema/index.js';
import * as authService from '../services/auth.service.js';
import * as ledger from '../services/ledger.service.js';
import { reportsRouter } from './reports.routes.js';
import { errorHandler } from '../middleware/error-handler.js';

let server: Server | null = null;
let port = 0;
let token = '';
let tenantId = '';

const testEmail = `reports-bank-balances-${Date.now()}@example.com`;

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

async function mkAccount(name: string, accountNumber: string, detailType: string, isActive = true) {
  const [a] = await db.insert(accounts).values({
    tenantId, name, accountNumber, accountType: 'asset', detailType, isActive,
  }).returning();
  return a!;
}

beforeAll(async () => {
  await cleanDb();
  await startApp();

  const result = await authService.register({
    email: testEmail,
    password: 'password123456',
    displayName: 'Bank Balances Test',
    companyName: 'Bank Balances Co',
  });
  token = result.tokens.accessToken;
  tenantId = result.user.tenantId;

  const company = await db.query.companies.findFirst({
    where: (c, { eq }) => eq(c.tenantId, tenantId),
  });
  const companyId = company!.id;

  const revenue = (await db.query.accounts.findMany({
    where: (a, { eq }) => eq(a.tenantId, tenantId),
  })).find((a) => a.accountType === 'revenue')!;

  const checking = await mkAccount('Test Checking', '1010', 'bank');
  await mkAccount('Test Savings', '1020', 'savings'); // active, no activity → $0 row
  const oldBank = await mkAccount('Old Bank', '1030', 'bank', false); // inactive w/ balance
  await mkAccount('Closed Bank', '1040', 'bank', false); // inactive, zero → hidden
  const equipment = await mkAccount('Equipment', '1500', 'fixed_asset'); // non-bank asset

  const post = (date: string, memo: string, lines: Array<{ accountId: string; debit: string; credit: string }>) =>
    ledger.postTransaction(tenantId, { txnType: 'journal_entry', txnDate: date, memo, lines }, undefined, companyId);

  // Before the as-of date (2026-06-30):
  await post('2026-02-01', 'Deposit into checking', [
    { accountId: checking.id, debit: '1000.00', credit: '0' },
    { accountId: revenue.id, debit: '0', credit: '1000.00' },
  ]);
  await post('2026-03-01', 'Deposit into old (inactive) bank', [
    { accountId: oldBank.id, debit: '250.00', credit: '0' },
    { accountId: revenue.id, debit: '0', credit: '250.00' },
  ]);
  await post('2026-04-01', 'Non-bank asset purchase', [
    { accountId: equipment.id, debit: '400.00', credit: '0' },
    { accountId: revenue.id, debit: '0', credit: '400.00' },
  ]);
  // AFTER the as-of date — must be excluded:
  await post('2026-07-15', 'Deposit after as-of', [
    { accountId: checking.id, debit: '500.00', credit: '0' },
    { accountId: revenue.id, debit: '0', credit: '500.00' },
  ]);

  // DRAFT transaction before the as-of date — must be excluded:
  const [draft] = await db.insert(transactions).values({
    tenantId, companyId, txnType: 'journal_entry', txnDate: '2026-05-01',
    status: 'draft', memo: 'Draft deposit', total: '999.00',
  }).returning();
  await db.insert(journalLines).values([
    { tenantId, companyId, transactionId: draft!.id, accountId: checking.id, debit: '999.00', credit: '0' },
    { tenantId, companyId, transactionId: draft!.id, accountId: revenue.id, debit: '0', credit: '999.00' },
  ]);
}, 30000);

afterAll(async () => {
  await new Promise<void>((r) => server?.close(() => r()));
  await cleanDb();
  await pool.end();
});

describe('GET /reports/bank-balances', () => {
  it('returns only bank accounts with as-of balances (posted, <= as_of_date)', async () => {
    const r = await get('/bank-balances?as_of_date=2026-06-30');
    expect(r.status).toBe(200);
    const data = JSON.parse(r.body);

    expect(data.title).toBe('Bank Account Balances');
    expect(data.asOfDate).toBe('2026-06-30');

    const names = data.accounts.map((a: { name: string }) => a.name);
    // Non-bank asset never appears.
    expect(names).not.toContain('Equipment');
    // Inactive with zero balance is hidden.
    expect(names.some((n: string) => n.startsWith('Closed Bank'))).toBe(false);

    // Active with activity: 1000 posted before as-of; the 500 posted
    // after as-of and the 999 draft are both excluded.
    const checking = data.accounts.find((a: { name: string }) => a.name === 'Test Checking');
    expect(checking).toBeDefined();
    expect(checking.balance).toBeCloseTo(1000, 4);
    expect(checking.isInactive).toBe(false);
    expect(checking.accountNumber).toBe('1010');
    expect(checking.accountId).toBeTruthy();

    // Active with no activity still appears at $0.
    const savings = data.accounts.find((a: { name: string }) => a.name === 'Test Savings');
    expect(savings).toBeDefined();
    expect(savings.balance).toBe(0);

    // Inactive with a nonzero balance appears, flagged.
    const oldBank = data.accounts.find((a: { name: string }) => a.name === 'Old Bank (inactive)');
    expect(oldBank).toBeDefined();
    expect(oldBank.balance).toBeCloseTo(250, 4);
    expect(oldBank.isInactive).toBe(true);

    expect(data.totalBalance).toBeCloseTo(1250, 4);
  });

  it('includes post-as-of activity when the report date moves past it', async () => {
    const r = await get('/bank-balances?as_of_date=2026-12-31');
    expect(r.status).toBe(200);
    const data = JSON.parse(r.body);
    const checking = data.accounts.find((a: { name: string }) => a.name === 'Test Checking');
    expect(checking.balance).toBeCloseTo(1500, 4); // 1000 + 500, draft still excluded
    expect(data.totalBalance).toBeCloseTo(1750, 4);
  });

  it('exports CSV with the Account/Balance columns and a TOTAL row', async () => {
    const r = await get('/bank-balances?as_of_date=2026-06-30&format=csv');
    expect(r.status).toBe(200);
    expect(r.contentType).toContain('text/csv');
    expect(r.body).toContain('"Account","Balance"');
    expect(r.body).toContain('Test Checking');
    expect(r.body).toContain('Old Bank (inactive)');
    expect(r.body).toContain('"1,000.00"');
    expect(r.body).toContain('TOTAL');
    expect(r.body).toContain('"1,250.00"');
    expect(r.body).not.toContain('Equipment');
  });
});
