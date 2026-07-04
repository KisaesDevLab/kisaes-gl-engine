// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

// Report-builder block resolver coverage for the Phase 16.6 additions:
//   - revenue_trend_12m / expense_trend_12m — 12 monthly buckets ending
//     with the month of periodEnd, signed like the P&L
//   - cash_balance_trend — cumulative month-end bank balance, seeded by
//     the opening balance before the 12-month window
//   - report embeds: cash_flow, trial_balance, bank_balances
//   - basis config on the P&L / Balance Sheet embeds (accrual vs cash)

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { db } from '../db/index.js';
import {
  tenants, users, sessions, accounts, companies, auditLog, contacts,
  transactions, journalLines, tags, transactionTags, budgets, budgetLines,
} from '../db/schema/index.js';
import type { TxnType } from '@kis-books/shared';
import * as ledger from './ledger.service.js';
import * as budgetSvc from './budget.service.js';
import {
  resolveBlock,
  type TrendPoint,
  type CfSummary,
  type TbSummary,
  type BankBalancesSummary,
  type BudgetVsActualSummary,
  type TagSegmentRow,
  type TopRow,
  type BsSummary,
  type SalesTaxSummary,
} from './portal-report-blocks.service.js';

let tenantId: string;

async function cleanDb() {
  await db.delete(budgetLines);
  await db.delete(budgets);
  await db.delete(transactionTags);
  await db.delete(journalLines);
  await db.delete(transactions);
  await db.delete(tags);
  await db.delete(auditLog);
  await db.delete(contacts);
  await db.delete(accounts);
  await db.delete(companies);
  await db.delete(sessions);
  await db.delete(users);
  await db.delete(tenants);
}

async function mk(name: string, accountType: string, accountNumber: string, detailType: string | null) {
  const [a] = await db.insert(accounts).values({ tenantId, name, accountNumber, accountType, detailType }).returning();
  return a!;
}

async function post(
  memo: string,
  lines: Array<{ accountId: string; debit: string; credit: string; tagId?: string }>,
  date: string,
  txnType: TxnType = 'journal_entry',
  companyId?: string,
) {
  return ledger.postTransaction(tenantId, { txnType, txnDate: date, memo, lines }, undefined, companyId);
}

// Resolver args for a Q2-2026 report (periodEnd mid-June — the trend
// window is then Jul 2025 … Jun 2026, whole months).
const args = () => ({
  tenantId,
  companyId: null,
  startDate: '2026-04-01',
  endDate: '2026-06-15',
});

beforeEach(async () => {
  await cleanDb();
  const [t] = await db.insert(tenants).values({ name: 'Blocks', slug: `blocks-${Date.now()}` }).returning();
  tenantId = t!.id;
});

afterEach(async () => {
  await cleanDb();
});

describe('trend charts', () => {
  it('revenue_trend_12m buckets posted revenue by calendar month over the trailing 12 months', async () => {
    const cash = await mk('Checking', 'asset', '1000', 'bank');
    const rev = await mk('Sales', 'revenue', '4000', 'service');

    // Inside the window (Jul 2025 … Jun 2026):
    await post('jan sale', [
      { accountId: cash.id, debit: '1000', credit: '0' },
      { accountId: rev.id, debit: '0', credit: '1000' },
    ], '2026-01-10');
    await post('jan sale 2', [
      { accountId: cash.id, debit: '250', credit: '0' },
      { accountId: rev.id, debit: '0', credit: '250' },
    ], '2026-01-25');
    await post('jun sale (after periodEnd, same month)', [
      { accountId: cash.id, debit: '400', credit: '0' },
      { accountId: rev.id, debit: '0', credit: '400' },
    ], '2026-06-20');
    // Outside the window — 13 months before periodEnd:
    await post('old sale', [
      { accountId: cash.id, debit: '9999', credit: '0' },
      { accountId: rev.id, debit: '0', credit: '9999' },
    ], '2025-05-01');

    const payload = await resolveBlock({ type: 'chart', name: 'revenue_trend_12m' }, args());
    expect(payload.error).toBeUndefined();
    expect(payload.type).toBe('revenue_trend_12m');
    const points = payload.data as TrendPoint[];
    expect(points).toHaveLength(12);
    expect(points[0]!.month).toBe('2025-07');
    expect(points[11]!.month).toBe('2026-06');
    const byMonth = new Map(points.map((p) => [p.month, p.amount]));
    expect(byMonth.get('2026-01')).toBeCloseTo(1250, 2);
    expect(byMonth.get('2026-06')).toBeCloseTo(400, 2); // whole end month
    expect(byMonth.get('2025-08')).toBe(0); // empty month present as 0
    // The 2025-05 sale is outside the window entirely.
    expect(points.some((p) => p.amount > 5000)).toBe(false);
  });

  it('expense_trend_12m sums expense + cogs (debit − credit) per month', async () => {
    const cash = await mk('Checking', 'asset', '1000', 'bank');
    const rent = await mk('Rent', 'expense', '6000', 'rent');
    const cogs = await mk('Materials', 'cogs', '5000', 'supplies_materials_cogs');

    await post('rent', [
      { accountId: rent.id, debit: '800', credit: '0' },
      { accountId: cash.id, debit: '0', credit: '800' },
    ], '2026-03-05');
    await post('materials', [
      { accountId: cogs.id, debit: '200', credit: '0' },
      { accountId: cash.id, debit: '0', credit: '200' },
    ], '2026-03-20');

    const payload = await resolveBlock({ type: 'chart', name: 'expense_trend_12m' }, args());
    const points = payload.data as TrendPoint[];
    const byMonth = new Map(points.map((p) => [p.month, p.amount]));
    expect(byMonth.get('2026-03')).toBeCloseTo(1000, 2);
    expect(byMonth.get('2026-02')).toBe(0);
  });

  it('cash_balance_trend is cumulative month-end bank balance including pre-window opening balance', async () => {
    const cash = await mk('Checking', 'asset', '1000', 'bank');
    const savings = await mk('Savings', 'asset', '1010', 'savings');
    const rev = await mk('Sales', 'revenue', '4000', 'service');
    const rent = await mk('Rent', 'expense', '6000', 'rent');
    await mk('Equipment', 'asset', '1500', 'fixed_asset'); // non-bank: ignored

    // Opening balance long before the window:
    await post('opening', [
      { accountId: cash.id, debit: '5000', credit: '0' },
      { accountId: rev.id, debit: '0', credit: '5000' },
    ], '2024-01-15');
    // +1000 into savings in Jan 2026:
    await post('jan deposit', [
      { accountId: savings.id, debit: '1000', credit: '0' },
      { accountId: rev.id, debit: '0', credit: '1000' },
    ], '2026-01-10');
    // −300 out of checking in Mar 2026:
    await post('mar rent', [
      { accountId: rent.id, debit: '300', credit: '0' },
      { accountId: cash.id, debit: '0', credit: '300' },
    ], '2026-03-08');

    const payload = await resolveBlock({ type: 'chart', name: 'cash_balance_trend' }, args());
    expect(payload.error).toBeUndefined();
    const points = payload.data as TrendPoint[];
    expect(points).toHaveLength(12);
    const byMonth = new Map(points.map((p) => [p.month, p.amount]));
    expect(byMonth.get('2025-07')).toBeCloseTo(5000, 2); // opening carried in
    expect(byMonth.get('2025-12')).toBeCloseTo(5000, 2);
    expect(byMonth.get('2026-01')).toBeCloseTo(6000, 2);
    expect(byMonth.get('2026-02')).toBeCloseTo(6000, 2);
    expect(byMonth.get('2026-03')).toBeCloseTo(5700, 2);
    expect(byMonth.get('2026-06')).toBeCloseTo(5700, 2);
  });

  it('company scoping narrows the trend to the requested company', async () => {
    const [co1] = await db.insert(companies).values({ tenantId, businessName: 'Co One' }).returning();
    const [co2] = await db.insert(companies).values({ tenantId, businessName: 'Co Two' }).returning();
    const cash = await mk('Checking', 'asset', '1000', 'bank');
    const rev = await mk('Sales', 'revenue', '4000', 'service');

    await post('co1 sale', [
      { accountId: cash.id, debit: '100', credit: '0' },
      { accountId: rev.id, debit: '0', credit: '100' },
    ], '2026-05-01', 'journal_entry', co1!.id);
    await post('co2 sale', [
      { accountId: cash.id, debit: '77', credit: '0' },
      { accountId: rev.id, debit: '0', credit: '77' },
    ], '2026-05-01', 'journal_entry', co2!.id);

    const payload = await resolveBlock(
      { type: 'chart', name: 'revenue_trend_12m' },
      { ...args(), companyId: co1!.id },
    );
    const byMonth = new Map((payload.data as TrendPoint[]).map((p) => [p.month, p.amount]));
    expect(byMonth.get('2026-05')).toBeCloseTo(100, 2);
  });
});

describe('report embeds', () => {
  it('cash_flow embed returns section totals + net change', async () => {
    // NB: buildCashFlowStatement's cash-account set uses the specific
    // detail types ('checking', 'savings', …), not the umbrella 'bank'.
    const cash = await mk('Checking', 'asset', '1000', 'checking');
    const rev = await mk('Sales', 'revenue', '4000', 'service');
    const truck = await mk('Vehicles', 'asset', '10600', 'fixed_asset');

    await post('sale', [
      { accountId: cash.id, debit: '10000', credit: '0' },
      { accountId: rev.id, debit: '0', credit: '10000' },
    ], '2026-05-01');
    await post('truck', [
      { accountId: truck.id, debit: '6000', credit: '0' },
      { accountId: cash.id, debit: '0', credit: '6000' },
    ], '2026-05-02');

    const payload = await resolveBlock({ type: 'report', key: 'cash_flow' }, args());
    expect(payload.error).toBeUndefined();
    expect(payload.type).toBe('cash_flow');
    const c = payload.data as CfSummary;
    expect(c.operating).toBeCloseTo(10000, 2);
    expect(c.investing).toBeCloseTo(-6000, 2);
    expect(c.financing).toBeCloseTo(0, 2);
    expect(c.netChange).toBeCloseTo(4000, 2);
  });

  it('trial_balance embed returns slim rows + tied totals', async () => {
    const cash = await mk('Checking', 'asset', '1000', 'bank');
    const rev = await mk('Sales', 'revenue', '4000', 'service');
    await post('sale', [
      { accountId: cash.id, debit: '1200', credit: '0' },
      { accountId: rev.id, debit: '0', credit: '1200' },
    ], '2026-05-01');

    const payload = await resolveBlock({ type: 'report', key: 'trial_balance' }, args());
    expect(payload.error).toBeUndefined();
    const t = payload.data as TbSummary;
    expect(t.rows.length).toBeGreaterThanOrEqual(2);
    const cashRow = t.rows.find((r) => r.account.includes('Checking'));
    expect(cashRow).toBeDefined();
    expect(cashRow!.debit).toBeCloseTo(1200, 2);
    expect(t.totalDebits).toBeCloseTo(t.totalCredits, 2);
    expect(t.truncated).toBe(false);
  });

  it('bank_balances resolves as both a report embed and a data block (as of periodEnd)', async () => {
    const cash = await mk('Checking', 'asset', '1000', 'bank');
    const rev = await mk('Sales', 'revenue', '4000', 'service');
    await post('sale', [
      { accountId: cash.id, debit: '2500', credit: '0' },
      { accountId: rev.id, debit: '0', credit: '2500' },
    ], '2026-05-01');
    // After periodEnd (2026-06-15) — excluded from the as-of balance:
    await post('late sale', [
      { accountId: cash.id, debit: '400', credit: '0' },
      { accountId: rev.id, debit: '0', credit: '400' },
    ], '2026-06-20');

    for (const block of [
      { type: 'report', key: 'bank_balances' },
      { type: 'block', name: 'bank_balances' },
    ]) {
      const payload = await resolveBlock(block, args());
      expect(payload.error).toBeUndefined();
      expect(payload.type).toBe('bank_balances');
      const b = payload.data as BankBalancesSummary;
      expect(b.asOfDate).toBe('2026-06-15');
      expect(b.accounts).toHaveLength(1);
      expect(b.accounts[0]!.name).toContain('Checking');
      expect(b.accounts[0]!.balance).toBeCloseTo(2500, 2);
      expect(b.totalBalance).toBeCloseTo(2500, 2);
    }
  });

  it('honors the basis config on the P&L and Balance Sheet embeds', async () => {
    const ar = await mk('Accounts Receivable', 'asset', '1100', 'accounts_receivable');
    const rev = await mk('Sales', 'revenue', '4000', 'service');

    // Unpaid invoice: revenue on accrual, invisible on cash basis.
    await post('invoice', [
      { accountId: ar.id, debit: '500', credit: '0' },
      { accountId: rev.id, debit: '0', credit: '500' },
    ], '2026-05-01', 'invoice');

    const accrualPl = await resolveBlock({ type: 'report', key: 'profit_loss' }, args());
    const cashPl = await resolveBlock({ type: 'report', key: 'profit_loss', basis: 'cash' }, args());
    expect((accrualPl.data as { revenue: number }).revenue).toBeCloseTo(500, 2);
    expect((cashPl.data as { revenue: number }).revenue).toBeCloseTo(0, 2);

    const accrualBs = await resolveBlock({ type: 'report', key: 'balance_sheet' }, args());
    const cashBs = await resolveBlock({ type: 'report', key: 'balance_sheet', basis: 'cash' }, args());
    expect((accrualBs.data as { assets: number }).assets).toBeCloseTo(500, 2);
    expect((cashBs.data as { assets: number }).assets).toBeCloseTo(0, 2);
  });

  it('ar_aging / ap_aging resolve as report embeds (dropdown options that predate their resolvers)', async () => {
    const ar = await mk('Accounts Receivable', 'asset', '1100', 'accounts_receivable');
    const rev = await mk('Sales', 'revenue', '4000', 'service');
    await post('invoice', [
      { accountId: ar.id, debit: '750', credit: '0' },
      { accountId: rev.id, debit: '0', credit: '750' },
    ], '2026-05-01', 'invoice');

    for (const key of ['ar_aging', 'ap_aging']) {
      const payload = await resolveBlock({ type: 'report', key }, args());
      expect(payload.error).toBeUndefined();
      expect(payload.type).toBe(key);
      expect(payload.data).toBeDefined();
    }
  });

  it('still reports unknown names as errors', async () => {
    const payload = await resolveBlock({ type: 'report', key: 'nonexistent_report' }, args());
    expect(payload.error).toMatch(/Unknown report embed/);
    const chart = await resolveBlock({ type: 'chart', name: 'nonexistent_chart' }, args());
    expect(chart.error).toMatch(/Unknown chart/);
  });
});

// ── Wave 2 additions ─────────────────────────────────────────────

describe('budget_vs_actual block (F1)', () => {
  it('returns per-line budget/actual/variance rows prorated to the period', async () => {
    const cash = await mk('Checking', 'asset', '1000', 'bank');
    const rev = await mk('Sales', 'revenue', '4000', 'service');

    // No companies rows → fiscalYearStart defaults to 2026-01-01, so
    // budget months 4/5/6 overlap the Apr-1 → Jun-15 report period.
    const budget = await budgetSvc.create(tenantId, { name: 'FY26 Plan', fiscalYear: 2026 });
    await budgetSvc.updateLines(tenantId, budget!.id, [
      { accountId: rev.id, month4: '1000', month5: '1000', month6: '1000' },
    ]);

    await post('may sale', [
      { accountId: cash.id, debit: '2500', credit: '0' },
      { accountId: rev.id, debit: '0', credit: '2500' },
    ], '2026-05-10');

    const payload = await resolveBlock(
      { type: 'block', name: 'budget_vs_actual', budgetId: budget!.id },
      args(),
    );
    expect(payload.error).toBeUndefined();
    expect(payload.type).toBe('budget_vs_actual');
    const d = payload.data as BudgetVsActualSummary;
    expect(d.budgetName).toBe('FY26 Plan');
    const row = d.rows.find((r) => r.account.includes('Sales'));
    expect(row).toBeDefined();
    expect(row!.budgeted).toBeCloseTo(3000, 2);
    expect(row!.actual).toBeCloseTo(2500, 2);
    expect(row!.variance).toBeCloseTo(-500, 2);
    expect(row!.variancePct).toBeCloseTo(-16.67, 1);
    expect(d.totals.budgeted).toBeCloseTo(3000, 2);
    expect(d.totals.actual).toBeCloseTo(2500, 2);
    expect(d.totals.variance).toBeCloseTo(-500, 2);
    expect(d.truncated).toBe(false);
  });

  it('returns an error payload when no budget is configured or the budget is missing', async () => {
    const missing = await resolveBlock({ type: 'block', name: 'budget_vs_actual' }, args());
    expect(missing.type).toBe('budget_vs_actual');
    expect(missing.error).toMatch(/No budget selected/i);

    const gone = await resolveBlock(
      { type: 'block', name: 'budget_vs_actual', budgetId: '00000000-0000-4000-8000-000000000000' },
      args(),
    );
    expect(gone.error).toMatch(/not found/i);
  });
});

describe('tag-segment block (F2)', () => {
  it('returns a per-tag P&L summary row for each selected tag', async () => {
    const cash = await mk('Checking', 'asset', '1000', 'bank');
    const rev = await mk('Sales', 'revenue', '4000', 'service');
    const rent = await mk('Rent', 'expense', '6000', 'rent');
    const [tagA] = await db.insert(tags).values({ tenantId, name: 'Location A' }).returning();
    const [tagB] = await db.insert(tags).values({ tenantId, name: 'Location B' }).returning();

    await post('a sale', [
      { accountId: cash.id, debit: '1000', credit: '0' },
      { accountId: rev.id, debit: '0', credit: '1000', tagId: tagA!.id },
    ], '2026-05-01');
    await post('b sale', [
      { accountId: cash.id, debit: '500', credit: '0' },
      { accountId: rev.id, debit: '0', credit: '500', tagId: tagB!.id },
    ], '2026-05-02');
    await post('b rent', [
      { accountId: rent.id, debit: '200', credit: '0', tagId: tagB!.id },
      { accountId: cash.id, debit: '0', credit: '200' },
    ], '2026-05-03');

    const payload = await resolveBlock(
      { type: 'tag-segment', tags: [tagA!.id, tagB!.id] },
      args(),
    );
    expect(payload.error).toBeUndefined();
    expect(payload.type).toBe('tag_segments');
    const rows = payload.data as TagSegmentRow[];
    expect(rows).toHaveLength(2);
    const a = rows.find((r) => r.tagName === 'Location A')!;
    const b = rows.find((r) => r.tagName === 'Location B')!;
    expect(a.revenue).toBeCloseTo(1000, 2);
    expect(a.expenses).toBeCloseTo(0, 2);
    expect(a.netIncome).toBeCloseTo(1000, 2);
    expect(b.revenue).toBeCloseTo(500, 2);
    expect(b.expenses).toBeCloseTo(200, 2);
    expect(b.netIncome).toBeCloseTo(300, 2);
  });

  it('errors when no tags are configured, and drops foreign/deleted tag ids', async () => {
    const empty = await resolveBlock({ type: 'tag-segment', tags: [] }, args());
    expect(empty.type).toBe('tag_segments');
    expect(empty.error).toMatch(/No tags selected/i);

    const gone = await resolveBlock(
      { type: 'tag-segment', tags: ['00000000-0000-4000-8000-000000000000'] },
      args(),
    );
    expect(gone.error).toMatch(/no longer exist/i);
  });
});

describe('net income + gross margin trends (F3)', () => {
  it('net_income_trend_12m buckets revenue minus costs per month', async () => {
    const cash = await mk('Checking', 'asset', '1000', 'bank');
    const rev = await mk('Sales', 'revenue', '4000', 'service');
    const rent = await mk('Rent', 'expense', '6000', 'rent');

    await post('jan sale', [
      { accountId: cash.id, debit: '1000', credit: '0' },
      { accountId: rev.id, debit: '0', credit: '1000' },
    ], '2026-01-10');
    await post('jan rent', [
      { accountId: rent.id, debit: '400', credit: '0' },
      { accountId: cash.id, debit: '0', credit: '400' },
    ], '2026-01-20');

    const payload = await resolveBlock({ type: 'chart', name: 'net_income_trend_12m' }, args());
    expect(payload.error).toBeUndefined();
    const points = payload.data as TrendPoint[];
    expect(points).toHaveLength(12);
    const byMonth = new Map(points.map((p) => [p.month, p.amount]));
    expect(byMonth.get('2026-01')).toBeCloseTo(600, 2);
    expect(byMonth.get('2026-02')).toBe(0);
  });

  it('gross_margin_trend_12m returns (rev − cogs)/rev as percent, 0 when a month has no revenue', async () => {
    const cash = await mk('Checking', 'asset', '1000', 'bank');
    const rev = await mk('Sales', 'revenue', '4000', 'service');
    const cogs = await mk('Materials', 'cogs', '5000', 'cost_of_goods_sold');
    const rent = await mk('Rent', 'expense', '6000', 'rent');

    await post('mar sale', [
      { accountId: cash.id, debit: '1000', credit: '0' },
      { accountId: rev.id, debit: '0', credit: '1000' },
    ], '2026-03-05');
    await post('mar materials', [
      { accountId: cogs.id, debit: '250', credit: '0' },
      { accountId: cash.id, debit: '0', credit: '250' },
    ], '2026-03-06');
    // Feb has expense only — margin must be 0, not NaN/-Inf.
    await post('feb rent', [
      { accountId: rent.id, debit: '100', credit: '0' },
      { accountId: cash.id, debit: '0', credit: '100' },
    ], '2026-02-10');

    const payload = await resolveBlock({ type: 'chart', name: 'gross_margin_trend_12m' }, args());
    expect(payload.error).toBeUndefined();
    const byMonth = new Map((payload.data as TrendPoint[]).map((p) => [p.month, p.amount]));
    expect(byMonth.get('2026-03')).toBeCloseTo(75.0, 1);
    expect(byMonth.get('2026-02')).toBe(0);
    expect(byMonth.get('2026-04')).toBe(0);
  });
});

describe('expense_by_category block (F4)', () => {
  it('returns top-N categories sorted by spend', async () => {
    const cash = await mk('Checking', 'asset', '1000', 'bank');
    const rent = await mk('Rent', 'expense', '6000', 'rent');
    const ads = await mk('Advertising', 'expense', '6100', 'advertising');
    const meals = await mk('Meals', 'expense', '6200', 'meals_entertainment');

    for (const [account, amount] of [
      [rent, '900'],
      [ads, '500'],
      [meals, '100'],
    ] as const) {
      await post(`spend ${account.name}`, [
        { accountId: account.id, debit: amount, credit: '0' },
        { accountId: cash.id, debit: '0', credit: amount },
      ], '2026-05-05');
    }

    const payload = await resolveBlock(
      { type: 'block', name: 'expense_by_category', topN: 2 },
      args(),
    );
    expect(payload.error).toBeUndefined();
    expect(payload.type).toBe('expense_by_category');
    const rows = payload.data as TopRow[];
    expect(rows).toHaveLength(2);
    expect(rows[0]!.name).toBe('Rent');
    expect(rows[0]!.amount).toBeCloseTo(900, 2);
    expect(rows[1]!.name).toBe('Advertising');
    expect(rows[1]!.amount).toBeCloseTo(500, 2);
  });
});

describe('sales_tax embed (F5)', () => {
  it('sums taxable sales and tax collected for the period', async () => {
    await db.insert(transactions).values({
      tenantId,
      txnType: 'invoice',
      txnDate: '2026-05-01',
      status: 'posted',
      subtotal: '100',
      taxAmount: '8.25',
      total: '108.25',
    });
    await db.insert(transactions).values({
      tenantId,
      txnType: 'cash_sale',
      txnDate: '2026-05-02',
      status: 'posted',
      subtotal: '50',
      taxAmount: '4',
      total: '54',
    });
    // Outside the period — excluded.
    await db.insert(transactions).values({
      tenantId,
      txnType: 'invoice',
      txnDate: '2026-07-01',
      status: 'posted',
      subtotal: '999',
      taxAmount: '99',
      total: '1098',
    });

    const payload = await resolveBlock({ type: 'report', key: 'sales_tax' }, args());
    expect(payload.error).toBeUndefined();
    expect(payload.type).toBe('sales_tax');
    const s = payload.data as SalesTaxSummary;
    expect(s.totalSales).toBeCloseTo(150, 2);
    expect(s.totalTax).toBeCloseTo(12.25, 2);
  });
});

describe('balance_sheet embed sections (F10)', () => {
  it('adds current/fixed/other asset and current/long-term liability subtotals', async () => {
    const cash = await mk('Checking', 'asset', '1000', 'bank');
    const truck = await mk('Vehicles', 'asset', '1500', 'fixed_asset');
    const deposits = await mk('Security Deposits', 'asset', '1800', 'other_asset');
    const ap = await mk('Accounts Payable', 'liability', '2000', 'accounts_payable');
    const loan = await mk('Bank Loan', 'liability', '2700', 'long_term_liability');
    const rev = await mk('Sales', 'revenue', '4000', 'service');
    const exp = await mk('Supplies', 'expense', '6000', 'office_supplies');

    await post('sale', [
      { accountId: cash.id, debit: '5000', credit: '0' },
      { accountId: rev.id, debit: '0', credit: '5000' },
    ], '2026-05-01');
    await post('buy truck with loan', [
      { accountId: truck.id, debit: '3000', credit: '0' },
      { accountId: loan.id, debit: '0', credit: '3000' },
    ], '2026-05-02');
    await post('deposit', [
      { accountId: deposits.id, debit: '400', credit: '0' },
      { accountId: cash.id, debit: '0', credit: '400' },
    ], '2026-05-03');
    await post('bill', [
      { accountId: exp.id, debit: '250', credit: '0' },
      { accountId: ap.id, debit: '0', credit: '250' },
    ], '2026-05-04');

    const payload = await resolveBlock({ type: 'report', key: 'balance_sheet' }, args());
    expect(payload.error).toBeUndefined();
    const b = payload.data as BsSummary;
    expect(b.sections).toBeDefined();
    const s = b.sections!;
    expect(s.currentAssets).toBeCloseTo(4600, 2); // 5000 − 400 in checking
    expect(s.fixedAssets).toBeCloseTo(3000, 2);
    expect(s.otherAssets).toBeCloseTo(400, 2);
    expect(s.currentLiabilities).toBeCloseTo(250, 2);
    expect(s.longTermLiabilities).toBeCloseTo(3000, 2);
    // Sections tie to the statement totals.
    expect(s.currentAssets + s.fixedAssets + s.otherAssets).toBeCloseTo(b.assets, 2);
    expect(s.currentLiabilities + s.longTermLiabilities).toBeCloseTo(b.liabilities, 2);
  });
});
