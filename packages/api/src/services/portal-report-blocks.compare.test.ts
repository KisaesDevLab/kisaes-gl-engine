// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Report-embed comparison: a profit_loss / balance_sheet block with
// compare='previous_year' | 'previous_period' resolves prior-period figures
// alongside the current ones so the renderer can add Prior / Change columns.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { tenants, users, sessions, companies, accounts, auditLog, transactions, journalLines } from '../db/schema/index.js';
import * as authService from './auth.service.js';
import * as ledger from './ledger.service.js';
import { resolveBlock } from './portal-report-blocks.service.js';

let tenantId = '', userId = '', bankId = '', revId = '', expId = '';

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
    email: `cmp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`,
    password: 'password123', displayName: 'Cmp', companyName: 'Cmp Co',
  });
  tenantId = user.tenantId; userId = user.id;
  bankId = (await db.query.accounts.findFirst({ where: and(eq(accounts.tenantId, tenantId), eq(accounts.detailType, 'bank')) }))!.id;
  revId = (await db.select().from(accounts).where(and(eq(accounts.tenantId, tenantId), eq(accounts.accountType, 'revenue'))).limit(1))[0]!.id;
  expId = (await db.select().from(accounts).where(and(eq(accounts.tenantId, tenantId), eq(accounts.accountType, 'expense'))).limit(1))[0]!.id;
  // Prior year (2025): revenue 1000, expense 400. Current (2026): revenue 1200, expense 500.
  await post('2025-06-01', bankId, revId, '1000');
  await post('2025-06-01', expId, bankId, '400');
  await post('2026-06-01', bankId, revId, '1200');
  await post('2026-06-01', expId, bankId, '500');
}

beforeEach(async () => { await cleanDb(); await setup(); });
afterEach(async () => { await cleanDb(); });

const args = { tenantId: '', companyId: null as string | null, startDate: '2026-01-01', endDate: '2026-12-31' };

describe('report embed comparison', () => {
  it('profit_loss compare=previous_year attaches prior figures', async () => {
    const p = await resolveBlock({ type: 'report', key: 'profit_loss', compare: 'previous_year' }, { ...args, tenantId });
    expect(p.type).toBe('profit_loss');
    const d = p.data as { revenue: number; netIncome: number; prior?: { revenue: number; netIncome: number }; compareLabel?: string };
    expect(d.revenue).toBeCloseTo(1200, 2);
    expect(d.prior?.revenue).toBeCloseTo(1000, 2);
    expect(d.netIncome).toBeCloseTo(700, 2);       // 1200 - 500
    expect(d.prior?.netIncome).toBeCloseTo(600, 2); // 1000 - 400
    expect(d.compareLabel).toBe('Prior year');
  });

  it('no compare → no prior figures (unchanged shape)', async () => {
    const p = await resolveBlock({ type: 'report', key: 'profit_loss' }, { ...args, tenantId });
    const d = p.data as { prior?: unknown };
    expect(d.prior).toBeUndefined();
  });

  it('balance_sheet compare=previous_year attaches prior figures', async () => {
    const p = await resolveBlock({ type: 'report', key: 'balance_sheet', compare: 'previous_year' }, { ...args, tenantId });
    const d = p.data as { assets: number; prior?: { assets: number }; compareLabel?: string };
    // Cumulative BS: 2026 has both years' bank activity; 2025 as-of has only prior year's.
    expect(d.prior).toBeDefined();
    expect(d.compareLabel).toBe('Prior year');
    expect(d.assets).not.toBeCloseTo(d.prior!.assets, 2);
  });

  it('bank_balances compare=previous_year attaches per-account prior balances', async () => {
    const p = await resolveBlock({ type: 'report', key: 'bank_balances', compare: 'previous_year' }, { ...args, tenantId });
    expect(p.type).toBe('bank_balances');
    const d = p.data as {
      accounts: Array<{ balance: number; priorBalance?: number }>;
      totalBalance: number;
      prior?: { asOfDate: string; totalBalance: number };
      compareLabel?: string;
    };
    // Cumulative: 2026-12-31 = 1000-400+1200-500 = 1300; 2025-12-31 = 600.
    expect(d.totalBalance).toBeCloseTo(1300, 2);
    expect(d.prior?.totalBalance).toBeCloseTo(600, 2);
    expect(d.prior?.asOfDate).toBe('2025-12-31');
    expect(d.compareLabel).toBe('Prior year');
    const bank = d.accounts.find((a) => a.balance !== 0)!;
    expect(bank.priorBalance).toBeCloseTo(600, 2);
  });

  it('bank_balances compare=previous_period uses the day before the period start', async () => {
    const p = await resolveBlock({ type: 'report', key: 'bank_balances', compare: 'previous_period' }, { ...args, tenantId });
    const d = p.data as { prior?: { asOfDate: string; totalBalance: number }; compareLabel?: string };
    expect(d.prior?.asOfDate).toBe('2025-12-31');
    expect(d.prior?.totalBalance).toBeCloseTo(600, 2);
    expect(d.compareLabel).toBe('Prior period');
  });

  it('bank_balances data block honors compare too', async () => {
    const p = await resolveBlock({ type: 'block', name: 'bank_balances', compare: 'previous_year' }, { ...args, tenantId });
    const d = p.data as { prior?: { totalBalance: number } };
    expect(d.prior?.totalBalance).toBeCloseTo(600, 2);
  });

  it('bank_balances without compare keeps the unchanged shape', async () => {
    const p = await resolveBlock({ type: 'report', key: 'bank_balances' }, { ...args, tenantId });
    const d = p.data as { prior?: unknown; accounts: Array<{ priorBalance?: number }> };
    expect(d.prior).toBeUndefined();
    expect(d.accounts.every((a) => a.priorBalance === undefined)).toBe(true);
  });
});
