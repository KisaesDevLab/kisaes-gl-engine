// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Comparative P&L $/% change favorability: for cost accounts, spending MORE
// than the prior period is an UNFAVORABLE (negative) change and spending less
// is favorable (positive) — the opposite of revenue. Revenue and net income
// stay raw. The section changes still sum to the net-income change.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  tenants, users, sessions, companies, accounts, auditLog, transactions, journalLines,
} from '../db/schema/index.js';
import * as authService from './auth.service.js';
import * as accountsService from './accounts.service.js';
import * as ledger from './ledger.service.js';
import * as comparison from './report-comparison.service.js';

let tenantId = '', userId = '', bankId = '', revId = '', expId = '', exp2Id = '';

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
    lines: [
      { accountId: debit, debit: amount, credit: '0' },
      { accountId: credit, debit: '0', credit: amount },
    ],
  });
}

async function setup() {
  const { user } = await authService.register({
    email: `fav-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`,
    password: 'password123', displayName: 'Fav', companyName: 'Fav Co',
  });
  tenantId = user.tenantId; userId = user.id;
  const bank = await db.query.accounts.findFirst({ where: and(eq(accounts.tenantId, tenantId), eq(accounts.detailType, 'bank')) });
  bankId = bank!.id;
  revId = (await accountsService.create(tenantId, { name: 'Sales', accountType: 'revenue', accountNumber: '4000' })).id;
  expId = (await accountsService.create(tenantId, { name: 'Rent', accountType: 'expense', accountNumber: '6000' })).id;
  exp2Id = (await accountsService.create(tenantId, { name: 'Supplies', accountType: 'expense', accountNumber: '6100' })).id;

  // Prior year (2025): revenue 1000, Rent 500, Supplies 300.
  await post('2025-03-15', bankId, revId, '1000');
  await post('2025-03-15', expId, bankId, '500');
  await post('2025-03-15', exp2Id, bankId, '300');
  // Current year (2026): revenue 1200 (+200), Rent 600 (+100 spend), Supplies 200 (-100 spend).
  await post('2026-03-15', bankId, revId, '1200');
  await post('2026-03-15', expId, bankId, '600');
  await post('2026-03-15', exp2Id, bankId, '200');
}

beforeEach(async () => { await cleanDb(); await setup(); });
afterEach(async () => { await cleanDb(); });

describe('comparative P&L favorability sign', () => {
  it('flips cost changes so more spending is negative, less spending positive', async () => {
    const cpl = await comparison.buildComparativePL(
      tenantId, '2026-01-01', '2026-06-30', 'accrual', 'previous_year', 6, 'month', null);
    const row = (name: string) => cpl.rows.find((r) => r.account === name)!;

    // Revenue up $200 → raw positive.
    expect(row('Sales').values[2]).toBeCloseTo(200, 4);
    expect(row('Sales').values[3]).toBeCloseTo(20, 4); // +20%

    // Rent up $100 (spent more) → UNFAVORABLE negative.
    expect(row('Rent').values[2]).toBeCloseTo(-100, 4);
    expect(row('Rent').values[3]).toBeCloseTo(-20, 4); // -20%

    // Supplies down $100 (spent less) → FAVORABLE positive.
    expect(row('Supplies').values[2]).toBeCloseTo(100, 4);
    expect(row('Supplies').values[3]).toBeCloseTo(100 / 300 * 100, 4);
  });

  it('total expenses flip; revenue and net income stay raw and stay consistent', async () => {
    const cpl = await comparison.buildComparativePL(
      tenantId, '2026-01-01', '2026-06-30', 'accrual', 'previous_year', 6, 'month', null);

    // Total expenses: 800 (600+200) vs prior 800 (500+300) → net $0 change.
    expect(cpl.totalExpenses[2]).toBeCloseTo(0, 4);
    // Revenue raw: +200.
    expect(cpl.totalRevenue[2]).toBeCloseTo(200, 4);
    // Net income: (1200-800) − (1000-800) = 400 − 200 = +200, raw favorable.
    expect(cpl.netIncome[2]).toBeCloseTo(200, 4);
    // Consistency: revenue change + expense change == net income change.
    expect((cpl.totalRevenue[2] ?? 0) + (cpl.totalExpenses[2] ?? 0)).toBeCloseTo(cpl.netIncome[2] ?? 0, 4);
  });
});
