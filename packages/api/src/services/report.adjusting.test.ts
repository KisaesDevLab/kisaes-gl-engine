// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Adjusting-entry lens (U-60, je-adjusting-v1): adjusting=include|exclude|only
// on the Profit and Loss, Balance Sheet (with its retained-earnings and
// net-income rows), Trial Balance, General Ledger, Transaction List and
// Journal Entry Report, accrual and cash basis. An AJE (txn_type 'aje') is
// adjusting without being marked. The route refuses an unknown value.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'express-async-errors';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import { tenants, users, sessions, companies, accounts, auditLog, transactions, journalLines, userTenantAccess, userPermissions } from '../db/schema/index.js';
import * as authService from './auth.service.js';
import * as ledger from './ledger.service.js';
import * as reportSvc from './report.service.js';
import { reportsRouter } from '../routes/reports.routes.js';
import { errorHandler } from '../middleware/error-handler.js';

let tenantId = '', userId = '', token = '', companyId = '', bankId = '', expId = '', reId = '';

async function cleanDb() {
  if (!tenantId) return;
  await db.delete(journalLines).where(eq(journalLines.tenantId, tenantId));
  await db.delete(transactions).where(eq(transactions.tenantId, tenantId));
  await db.delete(auditLog).where(eq(auditLog.tenantId, tenantId));
  await db.delete(accounts).where(eq(accounts.tenantId, tenantId));
  await db.delete(companies).where(eq(companies.tenantId, tenantId));
  const staff = await db.select({ id: users.id }).from(users).where(eq(users.tenantId, tenantId));
  if (staff.length) await db.delete(sessions).where(inArray(sessions.userId, staff.map((u) => u.id)));
  await db.delete(userPermissions).where(eq(userPermissions.tenantId, tenantId));
  await db.delete(userTenantAccess).where(eq(userTenantAccess.tenantId, tenantId));
  await db.delete(users).where(eq(users.tenantId, tenantId));
  await db.delete(tenants).where(eq(tenants.id, tenantId));
  tenantId = '';
}

async function post(date: string, amount: string, opts: { isAdjusting?: boolean; txnType?: 'journal_entry' | 'aje' } = {}) {
  await ledger.postTransaction(tenantId, {
    txnType: opts.txnType ?? 'journal_entry', txnDate: date, isAdjusting: opts.isAdjusting,
    lines: [{ accountId: expId, debit: amount, credit: '0' }, { accountId: bankId, debit: '0', credit: amount }],
  }, userId, companyId);
}

let server: Server | null = null;
let port = 0;

function get(pathname: string): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port, path: pathname, headers: { Authorization: `Bearer ${token}` } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode ?? 0, json: raw ? JSON.parse(raw) : null });
      });
    }).on('error', reject);
  });
}

beforeEach(async () => {
  await cleanDb();
  const reg = await authService.register({
    email: `adj-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`,
    password: 'password123', displayName: 'Adj', companyName: 'Adj Co',
  });
  tenantId = reg.user.tenantId; userId = reg.user.id; token = reg.tokens.accessToken;
  companyId = (await db.select().from(companies).where(eq(companies.tenantId, tenantId)).limit(1))[0]!.id;
  bankId = (await db.query.accounts.findFirst({ where: and(eq(accounts.tenantId, tenantId), eq(accounts.detailType, 'bank')) }))!.id;
  expId = (await db.select().from(accounts).where(and(eq(accounts.tenantId, tenantId), eq(accounts.accountType, 'expense'))).limit(1))[0]!.id;
  reId = (await db.query.accounts.findFirst({ where: and(eq(accounts.tenantId, tenantId), eq(accounts.systemTag, 'retained_earnings')) }))!.id;

  await post('2025-12-31', '10.0000', { isAdjusting: true }); // prior year, adjusting
  await post('2026-03-10', '100.0000');                       // regular
  await post('2026-03-31', '25.5000', { isAdjusting: true }); // adjusting JE
  await post('2026-03-31', '4.2500', { txnType: 'aje' });     // AJE: adjusting by type

  const app = express();
  app.use(express.json());
  app.use('/api/v1/reports', reportsRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => { port = (server!.address() as AddressInfo).port; resolve(); });
  });
});

afterEach(async () => {
  if (server) { await new Promise<void>((r) => server!.close(() => r())); server = null; }
  await cleanDb();
});

// Negation without -0 (toBe uses Object.is).
const neg = (n: number) => (n === 0 ? 0 : -n);

const MODES = [
  // [lens, current-year expense, prior-year expense, GL expense lines in 2026]
  ['include', 129.75, 10, 3],
  ['exclude', 100, 0, 1],
  ['only', 29.75, 10, 2],
] as const;

describe('adjusting lens (U-60)', () => {
  it('AJEs are adjusting entries', async () => {
    const aje = await db.select().from(transactions).where(and(eq(transactions.tenantId, tenantId), eq(transactions.txnType, 'aje')));
    expect(aje[0]!.isAdjusting).toBe(true);
  });

  for (const basis of ['accrual', 'cash'] as const) {
    for (const [adjusting, current, prior, glLines] of MODES) {
      it(`${basis} basis, adjusting=${adjusting}`, async () => {
        const pl = await reportSvc.buildProfitAndLoss(tenantId, '2026-01-01', '2026-12-31', basis, companyId, null, null, { adjusting });
        expect(pl.totalExpenses).toBe(current);

        const bs = await reportSvc.buildBalanceSheet(tenantId, '2026-06-30', basis, companyId, null, null, { adjusting });
        expect(bs.assets.find((a) => a.accountId === bankId)?.balance ?? 0).toBe(neg(current + prior));
        expect(bs.equity.find((e) => e.name === 'Net Income (Current Year)')?.balance ?? 0).toBe(neg(current));
        expect(bs.equity.find((e) => e.accountId === reId)?.balance ?? 0).toBe(neg(prior));
        expect(bs.totalAssets).toBe(bs.totalLiabilitiesAndEquity);

        const tb = await reportSvc.buildTrialBalance(tenantId, '2026-01-01', '2026-06-30', companyId, null, basis, { adjusting });
        expect(tb.totalDebits).toBe(tb.totalCredits);
        expect(tb.data.find((r: any) => r.id === expId)?.debit ?? 0).toBe(current);

        const gl = await reportSvc.buildGeneralLedger(tenantId, '2026-01-01', '2026-06-30', companyId, null, basis, null, { adjusting });
        const expSection = gl.accounts.find((a) => a.id === expId);
        expect(expSection?.lines.length ?? 0).toBe(glLines);
        expect(gl.accounts.find((a) => a.id === bankId)?.beginningBalance ?? 0).toBe(neg(prior));

        const list = await reportSvc.buildTransactionList(tenantId, { startDate: '2026-01-01', endDate: '2026-06-30', basis, adjusting }, companyId);
        expect(list.data.filter((r: any) => r.account_name !== undefined).length).toBe(glLines * 2);
      });
    }
  }

  it('the report routes take ?adjusting= and refuse an unknown value', async () => {
    const pl = await get('/api/v1/reports/profit-loss?start_date=2026-01-01&end_date=2026-12-31&adjusting=exclude');
    expect(pl.status).toBe(200);
    expect(pl.json.totalExpenses).toBe(100);
    const bs = await get('/api/v1/reports/balance-sheet?as_of_date=2026-06-30&adjusting=only');
    expect(bs.json.assets.find((a: any) => a.accountId === bankId).balance).toBe(-39.75);
    const tb = await get('/api/v1/reports/trial-balance?start_date=2026-01-01&end_date=2026-06-30&adjusting=exclude');
    expect(tb.json.data.find((r: any) => r.id === expId).debit).toBe(100);
    const gl = await get('/api/v1/reports/general-ledger?start_date=2026-01-01&end_date=2026-06-30&adjusting=only');
    expect(gl.json.accounts.find((a: any) => a.id === expId).lines).toHaveLength(2);
    const txl = await get('/api/v1/reports/transaction-list?start_date=2026-01-01&end_date=2026-06-30&adjusting=exclude');
    expect(txl.json.data).toHaveLength(2);
    const jer = await get('/api/v1/reports/journal-entry-report?start_date=2026-01-01&end_date=2026-06-30&adjusting=only');
    expect(jer.json.data).toHaveLength(2); // the AJE is not a journal_entry
    const deflt = await get('/api/v1/reports/profit-loss?start_date=2026-01-01&end_date=2026-12-31');
    expect(deflt.json.totalExpenses).toBe(129.75);
    expect((await get('/api/v1/reports/profit-loss?adjusting=sometimes')).status).toBe(400);
  });
});
