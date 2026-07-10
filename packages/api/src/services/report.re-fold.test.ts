// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Balance-sheet Retained Earnings fold: when a system RE account is designated
// (systemTag='retained_earnings'), the accumulated prior-year net income folds
// INTO that account's single line (posted balance + prior income), QBO-style,
// instead of a separate "Retained Earnings (Prior Years)" calculated row.
// "Net Income (Current Year)" stays separate. Without a designated RE account
// the separate calculated row returns (legacy behavior), so the sheet balances.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { tenants, users, sessions, companies, accounts, auditLog, transactions, journalLines } from '../db/schema/index.js';
import * as authService from './auth.service.js';
import * as ledger from './ledger.service.js';
import * as reportSvc from './report.service.js';

let tenantId = '', userId = '', bankId = '', revId = '', reId = '';

async function cleanDb() {
  if (!tenantId) return;
  await db.delete(journalLines).where(eq(journalLines.tenantId, tenantId));
  await db.delete(transactions).where(eq(transactions.tenantId, tenantId));
  await db.delete(auditLog).where(eq(auditLog.tenantId, tenantId));
  await db.delete(accounts).where(eq(accounts.tenantId, tenantId));
  await db.delete(companies).where(eq(companies.tenantId, tenantId));
  await db.delete(sessions).where(eq(sessions.userId, userId));
  await db.delete(users).where(eq(users.tenantId, tenantId));
  await db.delete(tenants).where(eq(tenants.id, tenantId));
  tenantId = '';
}

async function post(date: string, debit: string, credit: string, amount: string) {
  await ledger.postTransaction(tenantId, {
    txnType: 'journal_entry', txnDate: date,
    lines: [{ accountId: debit, debit: amount, credit: '0' }, { accountId: credit, debit: '0', credit: amount }],
  });
}

async function setup() {
  const { user } = await authService.register({
    email: `refold-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`,
    password: 'password123', displayName: 'Fold', companyName: 'Fold Co',
  });
  tenantId = user.tenantId; userId = user.id;
  bankId = (await db.query.accounts.findFirst({ where: and(eq(accounts.tenantId, tenantId), eq(accounts.detailType, 'bank')) }))!.id;
  revId = (await db.select().from(accounts).where(and(eq(accounts.tenantId, tenantId), eq(accounts.accountType, 'revenue'))).limit(1))[0]!.id;
  reId = (await db.query.accounts.findFirst({ where: and(eq(accounts.tenantId, tenantId), eq(accounts.systemTag, 'retained_earnings')) }))!.id;

  await post('2025-06-01', reId, bankId, '200');   // direct debit to RE → posted -200
  await post('2025-06-01', bankId, revId, '1000');  // prior-year net income 1000
  await post('2026-06-01', bankId, revId, '500');   // current-year net income 500
}

beforeEach(async () => { await cleanDb(); await setup(); });
afterEach(async () => { await cleanDb(); });

const equityByName = (bs: { equity: Array<{ name: string; balance: number }> }) =>
  new Map(bs.equity.map((e) => [e.name, e.balance]));

describe('balance sheet Retained Earnings fold', () => {
  it('folds prior-years RE into the designated account; no separate calculated row', async () => {
    const bs = await reportSvc.buildBalanceSheet(tenantId, '2026-12-31', 'accrual', null) as {
      equity: Array<{ accountId: string | null; name: string; balance: number }>; totalEquity: number;
    };
    const byName = equityByName(bs);
    // No separate prior-years row.
    expect([...byName.keys()]).not.toContain('Retained Earnings (Prior Years)');
    // The RE account line = posted (-200) + prior income (1000) = 800.
    const re = bs.equity.find((e) => e.accountId === reId)!;
    expect(re.balance).toBeCloseTo(800, 2);
    // Current-year net income stays a separate line.
    expect(byName.get('Net Income (Current Year)')).toBeCloseTo(500, 2);
    // Sheet still balances: total equity = 800 + 500 = 1300.
    expect(bs.totalEquity).toBeCloseTo(1300, 2);
  });

  it('without a designated RE account, the separate calculated row returns', async () => {
    await db.update(accounts).set({ systemTag: null }).where(eq(accounts.id, reId));
    const bs = await reportSvc.buildBalanceSheet(tenantId, '2026-12-31', 'accrual', null) as {
      equity: Array<{ name: string; balance: number }>; totalEquity: number;
    };
    const byName = equityByName(bs);
    expect(byName.get('Retained Earnings (Prior Years)')).toBeCloseTo(1000, 2);
    expect(byName.get('Net Income (Current Year)')).toBeCloseTo(500, 2);
    expect(bs.totalEquity).toBeCloseTo(1300, 2); // total unchanged either way
  });
});
