// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

// Route-level coverage for the statement-driven reconciliation reports:
//   GET /reports/bank-reconciliation-summary
//     - last completed reconciliation per bank account
//     - uncleared posted-line count + oldest uncleared date
//     - statement coverage gap count (missing calendar months)
//     - stale outstanding checks (>90 days) sub-list
//     - CSV export 200 with both sections
//   GET /reports/reconciliation-detail?reconciliation_id=
//     - header + cleared/uncleared line lists + totals
//     - 400 without reconciliation_id, CSV export 200

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import 'express-async-errors';
import express from 'express';
import http from 'http';
import type { AddressInfo, Server } from 'net';
import { sql, eq, and } from 'drizzle-orm';
import { db, pool } from '../db/index.js';
import { accounts, transactions, bankStatements, reconciliationLines } from '../db/schema/index.js';
import * as authService from '../services/auth.service.js';
import * as ledger from '../services/ledger.service.js';
import * as reconciliation from '../services/reconciliation.service.js';
import { reportsRouter } from './reports.routes.js';
import { errorHandler } from '../middleware/error-handler.js';

let server: Server | null = null;
let port = 0;
let token = '';
let tenantId = '';
let checkingId = '';
let reconId = '';

const testEmail = `reports-reconciliation-${Date.now()}@example.com`;

async function cleanDb() {
  await db.execute(sql`TRUNCATE
    audit_log, journal_lines, transaction_tags, payment_applications, deposit_lines,
    recurring_schedules, budget_lines, budgets,
    bank_feed_items, bank_statements, reconciliation_lines, reconciliations,
    plaid_account_mappings, plaid_accounts, plaid_items, bank_connections,
    ai_jobs, attachments,
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

interface RawResponse { status: number; contentType: string; body: string }

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

beforeAll(async () => {
  await cleanDb();
  await startApp();

  const result = await authService.register({
    email: testEmail,
    password: 'password123456',
    displayName: 'Recon Reports Test',
    companyName: 'Recon Reports Co',
  });
  token = result.tokens.accessToken;
  tenantId = result.user.tenantId;

  // The reports router scopes to the requester's active company
  // (companyContext), so transactions must carry the company id.
  const company = await db.query.companies.findFirst({
    where: (c, { eq: e }) => e(c.tenantId, tenantId),
  });
  const companyId = company!.id;

  const [checking] = await db.insert(accounts).values({
    tenantId, name: 'Report Checking', accountNumber: '1011', accountType: 'asset', detailType: 'bank',
  }).returning();
  checkingId = checking!.id;

  const revenue = (await db.query.accounts.findMany({
    where: (a, { eq: e }) => e(a.tenantId, tenantId),
  })).find((a) => a.accountType === 'revenue')!;
  const expense = (await db.query.accounts.findMany({
    where: (a, { eq: e }) => e(a.tenantId, tenantId),
  })).find((a) => a.accountType === 'expense')!;

  // A deposit that will be cleared by the completed reconciliation.
  await ledger.postTransaction(tenantId, {
    txnType: 'journal_entry', txnDate: '2026-01-05', memo: 'January deposit',
    lines: [
      { accountId: checkingId, debit: '140.00', credit: '0' },
      { accountId: revenue.id, debit: '0', credit: '140.00' },
    ],
  }, undefined, companyId);

  // A stale outstanding check (uncleared, >90 days old, carries a check number).
  const staleCheck = await ledger.postTransaction(tenantId, {
    txnType: 'expense', txnDate: '2020-01-15', memo: 'Old check',
    lines: [
      { accountId: expense.id, debit: '40.00', credit: '0' },
      { accountId: checkingId, debit: '0', credit: '40.00' },
    ],
  }, undefined, companyId);
  await db.update(transactions).set({ checkNumber: 101, payeeNameOnCheck: 'Acme Supply' })
    .where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, staleCheck.id)));

  // Complete a reconciliation clearing ONLY the deposit; the old check stays
  // uncleared. Beginning 0 + 140 - 0 = statement 100? No: cleared must equal
  // the statement balance, so statement = 140 - 40 if both cleared, or 140
  // with only the deposit cleared... the old check is on the worksheet too
  // (txn_date <= statement date), so statement balance = +140 (deposit only).
  const rec = await reconciliation.start(tenantId, checkingId, '2026-01-31', '140.00');
  reconId = rec.id;
  const lines = await db.select().from(reconciliationLines).where(eq(reconciliationLines.reconciliationId, rec.id));
  // Clear every line EXCEPT the stale check's (credit 40).
  const lineRows = await db.execute(sql`
    SELECT rl.journal_line_id, jl.credit FROM reconciliation_lines rl
    JOIN journal_lines jl ON jl.id = rl.journal_line_id
    WHERE rl.reconciliation_id = ${rec.id}
  `);
  const toClear = (lineRows.rows as Array<{ journal_line_id: string; credit: string }>)
    .filter((l) => parseFloat(l.credit) !== 40)
    .map((l) => ({ journalLineId: l.journal_line_id, isCleared: true }));
  expect(lines.length).toBe(2);
  await reconciliation.updateLines(tenantId, rec.id, toClear);
  await reconciliation.complete(tenantId, rec.id);

  // Statements on file: January + March period ends → February is a gap.
  await db.insert(bankStatements).values([
    { tenantId, accountId: checkingId, periodStart: '2026-01-01', periodEnd: '2026-01-31', closingBalance: '140.0000', reconciliationId: rec.id },
    { tenantId, accountId: checkingId, periodStart: '2026-03-01', periodEnd: '2026-03-31', closingBalance: '150.0000' },
  ]);
});

afterAll(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  await cleanDb();
  await pool.end();
});

describe('GET /reports/bank-reconciliation-summary', () => {
  it('returns per-account summary with last rec, uncleared count, gaps and stale checks', async () => {
    const res = await get('/bank-reconciliation-summary');
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    const row = data.accounts.find((a: { name: string }) => a.name === 'Report Checking');
    expect(row).toBeDefined();
    expect(row.lastReconciledDate).toBe('2026-01-31');
    expect(row.lastReconciledBalance).toBe(140);
    expect(row.latestStatementEnd).toBe('2026-03-31');
    expect(row.statementCount).toBe(2);
    expect(row.statementGapCount).toBe(1); // 2026-02 missing
    expect(row.unclearedCount).toBe(1); // the stale check line
    expect(row.oldestUnclearedDate).toBe('2020-01-15');
    expect(row.staleCheckCount).toBe(1);

    expect(data.staleChecks.length).toBe(1);
    const check = data.staleChecks[0];
    expect(check.accountName).toBe('Report Checking');
    expect(check.txnDate).toBe('2020-01-15');
    expect(check.checkNumber).toBe('101');
    expect(check.payee).toBe('Acme Supply');
    expect(check.amount).toBe(40);
  });

  it('exports CSV with the account table and the stale-checks section', async () => {
    const res = await get('/bank-reconciliation-summary?format=csv');
    expect(res.status).toBe(200);
    expect(res.contentType).toContain('text/csv');
    expect(res.body).toContain('Report Checking');
    expect(res.body).toContain('Stale Outstanding Checks');
    expect(res.body).toContain('Acme Supply');
  });
});

describe('GET /reports/reconciliation-detail', () => {
  it('requires reconciliation_id', async () => {
    const res = await get('/reconciliation-detail');
    expect(res.status).toBe(400);
  });

  it('returns header, cleared and uncleared lines with totals', async () => {
    const res = await get(`/reconciliation-detail?reconciliation_id=${reconId}`);
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.reconciliation.accountName).toBe('Report Checking');
    expect(data.reconciliation.statementDate).toBe('2026-01-31');
    expect(data.reconciliation.status).toBe('complete');
    expect(data.reconciliation.statementEndingBalance).toBe(140);
    // Linked statement (January) rides along.
    expect(data.statement?.periodEnd).toBe('2026-01-31');
    expect(data.cleared.length).toBe(1);
    expect(data.cleared[0].deposit).toBe(140);
    expect(data.uncleared.length).toBe(1);
    expect(data.uncleared[0].payment).toBe(40);
    expect(data.totals.clearedDeposits).toBe(140);
    expect(data.totals.unclearedPayments).toBe(40);
  });

  it('exports CSV with both sections', async () => {
    const res = await get(`/reconciliation-detail?reconciliation_id=${reconId}&format=csv`);
    expect(res.status).toBe(200);
    expect(res.contentType).toContain('text/csv');
    expect(res.body).toContain('Cleared Transactions');
    expect(res.body).toContain('Uncleared as of 2026-01-31');
  });

  it('404s for an unknown reconciliation', async () => {
    const res = await get('/reconciliation-detail?reconciliation_id=00000000-0000-0000-0000-000000000000');
    expect(res.status).toBe(404);
  });
});
