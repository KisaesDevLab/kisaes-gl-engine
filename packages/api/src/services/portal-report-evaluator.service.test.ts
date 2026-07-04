// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

// Review-fix coverage for the runtime KPI evaluator:
//   - C1: balance-sheet metrics (cash/AR/AP/…) must observe ONLY posted,
//     in-window, company-scoped journal lines. The old LEFT JOIN put the
//     transaction filters in the ON clause, which filtered nothing.
//   - H1: prior-month / prior-year windows clamp the day-of-month
//     instead of overflowing into the next month (Mar 31 → Feb 28).
//   - M4: formatKpiValue never emits "NaN" for any format token.
//   - M6: ap_days / inventory_days share one COGS→opex denominator rule.
//   - M3: evaluateAst rejects absurdly deep formula ASTs instead of
//     blowing the stack.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { db } from '../db/index.js';
import {
  tenants, users, sessions, accounts, companies, auditLog, contacts,
  transactions, journalLines,
} from '../db/schema/index.js';
import * as ledger from './ledger.service.js';
import {
  gatherMetrics,
  priorMonthWindow,
  priorYearWindow,
  formatKpiValue,
  daysDenominator,
  computeStockKpis,
  evaluateAst,
  type AstNode,
  type EvalContext,
} from './portal-report-evaluator.service.js';

let tenantId: string;

async function cleanDb() {
  await db.delete(journalLines);
  await db.delete(transactions);
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
  lines: Array<{ accountId: string; debit: string; credit: string }>,
  date: string,
  companyId?: string,
) {
  return ledger.postTransaction(tenantId, { txnType: 'journal_entry', txnDate: date, memo, lines }, undefined, companyId);
}

// Insert a transaction with an explicit status ('draft'/'void') —
// the ledger service only posts, so we seed these directly.
async function insertWithStatus(
  status: string,
  lines: Array<{ accountId: string; debit: string; credit: string }>,
  date: string,
  companyId?: string,
) {
  const [txn] = await db.insert(transactions).values({
    tenantId,
    companyId: companyId ?? null,
    txnType: 'journal_entry',
    txnDate: date,
    status,
    memo: `${status} txn`,
  }).returning();
  for (const [i, line] of lines.entries()) {
    await db.insert(journalLines).values({
      tenantId,
      companyId: companyId ?? null,
      transactionId: txn!.id,
      accountId: line.accountId,
      debit: line.debit,
      credit: line.credit,
      lineOrder: i,
    });
  }
}

beforeEach(async () => {
  await cleanDb();
  const [t] = await db.insert(tenants).values({ name: 'Evaluator', slug: `evaluator-${Date.now()}` }).returning();
  tenantId = t!.id;
});

afterEach(async () => {
  await cleanDb();
});

describe('C1 — balance metrics filter by status / as-of date / company', () => {
  it('asset balances count only posted, in-window, same-company lines', async () => {
    const [co1] = await db.insert(companies).values({ tenantId, businessName: 'Co One' }).returning();
    const [co2] = await db.insert(companies).values({ tenantId, businessName: 'Co Two' }).returning();
    const cash = await mk('Checking', 'asset', '1000', 'bank');
    const rev = await mk('Sales', 'revenue', '4000', 'service');

    // 1. Posted, in-period, co1 — the ONLY line that should count.
    await post('in-period sale', [
      { accountId: cash.id, debit: '1000', credit: '0' },
      { accountId: rev.id, debit: '0', credit: '1000' },
    ], '2026-05-01', co1!.id);
    // 2. Posted but AFTER the as-of date.
    await post('future sale', [
      { accountId: cash.id, debit: '500', credit: '0' },
      { accountId: rev.id, debit: '0', credit: '500' },
    ], '2026-07-15', co1!.id);
    // 3. Draft (never counts).
    await insertWithStatus('draft', [
      { accountId: cash.id, debit: '999', credit: '0' },
      { accountId: rev.id, debit: '0', credit: '999' },
    ], '2026-05-02', co1!.id);
    // 4. Other company's books.
    await post('co2 sale', [
      { accountId: cash.id, debit: '777', credit: '0' },
      { accountId: rev.id, debit: '0', credit: '777' },
    ], '2026-05-03', co2!.id);

    const m = await gatherMetrics(tenantId, co1!.id, '2026-04-01', '2026-06-30');
    expect(m.cash).toBeCloseTo(1000, 2);
    expect(m.bankBalance).toBeCloseTo(1000, 2);
    expect(m.currentAssets).toBeCloseTo(1000, 2);
  });

  it('liability balances apply the same filters', async () => {
    const [co1] = await db.insert(companies).values({ tenantId, businessName: 'Co One' }).returning();
    const [co2] = await db.insert(companies).values({ tenantId, businessName: 'Co Two' }).returning();
    const ap = await mk('Accounts Payable', 'liability', '2000', 'accounts_payable');
    const exp = await mk('Supplies', 'expense', '6000', 'supplies');

    // Posted in-window (counts):
    await post('in-period bill', [
      { accountId: exp.id, debit: '200', credit: '0' },
      { accountId: ap.id, debit: '0', credit: '200' },
    ], '2026-05-10', co1!.id);
    // Posted but future-dated:
    await post('future bill', [
      { accountId: exp.id, debit: '400', credit: '0' },
      { accountId: ap.id, debit: '0', credit: '400' },
    ], '2026-08-01', co1!.id);
    // Draft:
    await insertWithStatus('draft', [
      { accountId: exp.id, debit: '300', credit: '0' },
      { accountId: ap.id, debit: '0', credit: '300' },
    ], '2026-05-11', co1!.id);
    // Other company:
    await post('co2 bill', [
      { accountId: exp.id, debit: '50', credit: '0' },
      { accountId: ap.id, debit: '0', credit: '50' },
    ], '2026-05-12', co2!.id);

    const m = await gatherMetrics(tenantId, co1!.id, '2026-04-01', '2026-06-30');
    expect(m.accountsPayable).toBeCloseTo(200, 2);
    expect(m.currentLiabilities).toBeCloseTo(200, 2);
  });

  it('null companyId consolidates across companies (posted + in-window only)', async () => {
    const [co1] = await db.insert(companies).values({ tenantId, businessName: 'Co One' }).returning();
    const [co2] = await db.insert(companies).values({ tenantId, businessName: 'Co Two' }).returning();
    const cash = await mk('Checking', 'asset', '1000', 'bank');
    const rev = await mk('Sales', 'revenue', '4000', 'service');

    await post('co1 sale', [
      { accountId: cash.id, debit: '1000', credit: '0' },
      { accountId: rev.id, debit: '0', credit: '1000' },
    ], '2026-05-01', co1!.id);
    await post('co2 sale', [
      { accountId: cash.id, debit: '777', credit: '0' },
      { accountId: rev.id, debit: '0', credit: '777' },
    ], '2026-05-03', co2!.id);
    await post('future sale', [
      { accountId: cash.id, debit: '500', credit: '0' },
      { accountId: rev.id, debit: '0', credit: '500' },
    ], '2026-07-15', co1!.id);
    await insertWithStatus('draft', [
      { accountId: cash.id, debit: '999', credit: '0' },
      { accountId: rev.id, debit: '0', credit: '999' },
    ], '2026-05-02', co1!.id);

    const m = await gatherMetrics(tenantId, null, '2026-04-01', '2026-06-30');
    expect(m.cash).toBeCloseTo(1777, 2);
  });
});

describe('H1 — prior-period windows clamp the day-of-month', () => {
  it('prior month of a 31st clamps to the shorter month end', () => {
    expect(priorMonthWindow('2026-03-01', '2026-03-31')).toEqual({
      start: '2026-02-01',
      end: '2026-02-28', // 2026 is not a leap year
    });
    expect(priorMonthWindow('2026-07-01', '2026-07-31')).toEqual({
      start: '2026-06-01',
      end: '2026-06-30',
    });
  });

  it('prior month across a leap-year February', () => {
    expect(priorMonthWindow('2024-03-01', '2024-03-31').end).toBe('2024-02-29');
  });

  it('prior year of Feb 29 clamps to Feb 28', () => {
    expect(priorYearWindow('2024-02-01', '2024-02-29')).toEqual({
      start: '2023-02-01',
      end: '2023-02-28',
    });
  });

  it('plain mid-month dates shift without adjustment', () => {
    expect(priorMonthWindow('2026-05-10', '2026-05-15')).toEqual({
      start: '2026-04-10',
      end: '2026-04-15',
    });
    expect(priorYearWindow('2026-05-10', '2026-05-15')).toEqual({
      start: '2025-05-10',
      end: '2025-05-15',
    });
  });

  it('prior month crosses a year boundary', () => {
    expect(priorMonthWindow('2026-01-01', '2026-01-31')).toEqual({
      start: '2025-12-01',
      end: '2025-12-31',
    });
  });
});

describe('M4 — formatKpiValue guards non-finite values', () => {
  it('returns em dash for NaN/Infinity in every format including unknown', () => {
    for (const format of ['currency', 'percent', 'ratio', 'days'] as const) {
      expect(formatKpiValue(Number.NaN, format)).toBe('—');
      expect(formatKpiValue(Number.POSITIVE_INFINITY, format)).toBe('—');
    }
    // Unknown format token falls to the default branch — must not print "NaN".
    expect(formatKpiValue(Number.NaN, 'weird' as 'ratio')).toBe('—');
    expect(formatKpiValue(1.234, 'weird' as 'ratio')).toBe('1.23');
  });
});

const baseMetrics = {
  revenue: 9000,
  cogs: 0,
  grossProfit: 9000,
  operatingExpense: 3000,
  netIncome: 6000,
  operatingIncome: 6000,
  cash: 5000,
  bankBalance: 5000,
  accountsReceivable: 900,
  accountsPayable: 300,
  inventory: 150,
  currentAssets: 6050,
  currentLiabilities: 300,
  periodDays: 30,
};

describe('M6 — days-KPI denominator fallback is a single shared rule', () => {
  it('daysDenominator prefers cogs, falls back to operating expense', () => {
    expect(daysDenominator(500, 3000)).toBe(500);
    expect(daysDenominator(0, 3000)).toBe(3000);
    expect(daysDenominator(0, 0)).toBe(0);
  });

  it('ap_days and inventory_days both use the opex fallback when cogs is 0', () => {
    const out = computeStockKpis({ ...baseMetrics }, ['ap_days', 'inventory_days']);
    // 300 / 3000 * 30 = 3 d; 150 / 3000 * 30 = 1.5 → 2 d (rounded)
    expect(out['ap_days']).toBe('3 d');
    expect(out['inventory_days']).toBe('2 d');
  });

  it('both switch to cogs when the period has any', () => {
    const out = computeStockKpis({ ...baseMetrics, cogs: 600 }, ['ap_days', 'inventory_days']);
    // 300 / 600 * 30 = 15 d; 150 / 600 * 30 = 7.5 → 8 d
    expect(out['ap_days']).toBe('15 d');
    expect(out['inventory_days']).toBe('8 d');
  });

  it('zero cogs AND zero opex yields em dash, never NaN text', () => {
    const out = computeStockKpis(
      { ...baseMetrics, operatingExpense: 0 },
      ['ap_days', 'inventory_days'],
    );
    expect(out['ap_days']).toBe('—');
    expect(out['inventory_days']).toBe('—');
  });
});

describe('M3 — evaluateAst depth guard', () => {
  const ctx: EvalContext = {
    current: { ...baseMetrics },
    resolvedKpis: {},
  };

  function nest(depth: number): AstNode {
    let node: AstNode = { kind: 'literal', value: 1 };
    for (let i = 0; i < depth; i++) {
      node = { kind: 'op', op: '+', left: node, right: { kind: 'literal', value: 0 } };
    }
    return node;
  }

  it('evaluates reasonably deep formulas', () => {
    expect(evaluateAst(nest(20), ctx)).toBe(1);
  });

  it('throws a clear error beyond the ceiling instead of blowing the stack', () => {
    expect(() => evaluateAst(nest(64), ctx)).toThrow(/nested too deeply/i);
  });
});
