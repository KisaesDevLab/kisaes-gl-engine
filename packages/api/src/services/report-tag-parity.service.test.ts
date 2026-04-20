// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.
//
// ADR 0XX §5 / build plan Phase 9 — report parity test.
//
// Split-level tags must not change the total of any report when the
// tag filter is absent. A mixed dataset (uniform, mixed, and untagged
// transactions) is posted, then every tag-aware report runs twice:
// once with no filter, once with a specific tag. The sum of per-tag
// runs plus the untagged delta must equal the unfiltered total to
// the cent for every section. Any drift means the tag JOIN changed
// aggregation semantics — the highest-risk correctness regression
// in the split-level tags migration.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { db } from '../db/index.js';
import {
  tenants, users, sessions, accounts, companies, auditLog, contacts,
  transactions, journalLines, tags, transactionTags,
} from '../db/schema/index.js';
import * as ledger from './ledger.service.js';
import * as accountsService from './accounts.service.js';
import * as reportService from './report.service.js';

let tenantId: string;
let tagA: string;
let tagB: string;

async function cleanDb() {
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

async function createTenant(slug: string): Promise<string> {
  const [tenant] = await db.insert(tenants).values({
    name: 'Report Parity',
    slug: `${slug}-${Date.now()}`,
  }).returning();
  return tenant!.id;
}

async function mkTag(name: string): Promise<string> {
  const [row] = await db.insert(tags).values({ tenantId, name }).returning();
  return row!.id;
}

async function mkAccount(name: string, accountType: string, accountNumber: string) {
  return accountsService.create(tenantId, { name, accountNumber, accountType: accountType as any });
}

interface LineInput {
  id: string;
  amount: string;
  side: 'debit' | 'credit';
  tagId?: string | null;
}

async function postWithLineTags(memo: string, lines: LineInput[], date = '2026-04-01') {
  return ledger.postTransaction(tenantId, {
    txnType: 'journal_entry',
    txnDate: date,
    memo,
    lines: lines.map((l) => ({
      accountId: l.id,
      debit: l.side === 'debit' ? l.amount : '0',
      credit: l.side === 'credit' ? l.amount : '0',
      tagId: l.tagId ?? null,
    })),
  });
}

// Shape: one tagged-A txn, one tagged-B txn, one mixed-tag txn, one
// untagged txn. Totals exist at multiple scales so rounding drift in
// any aggregation shows up as a sub-dollar delta.
async function seedFixture() {
  const cash = await mkAccount('Cash', 'asset', '1000');
  const rev = await mkAccount('Revenue', 'revenue', '4000');
  const exp = await mkAccount('Expense', 'expense', '6000');

  // Uniform tag A — 1000 revenue.
  await postWithLineTags('Revenue A', [
    { id: cash.id, amount: '1000.00', side: 'debit', tagId: tagA },
    { id: rev.id, amount: '1000.00', side: 'credit', tagId: tagA },
  ]);

  // Uniform tag B — 500 revenue.
  await postWithLineTags('Revenue B', [
    { id: cash.id, amount: '500.00', side: 'debit', tagId: tagB },
    { id: rev.id, amount: '500.00', side: 'credit', tagId: tagB },
  ]);

  // Mixed-tag txn: 300 revenue (tag A) + 200 expense (tag B).
  await postWithLineTags('Mixed tags', [
    { id: cash.id, amount: '100.00', side: 'debit', tagId: null },
    { id: rev.id, amount: '300.00', side: 'credit', tagId: tagA },
    { id: exp.id, amount: '200.00', side: 'debit', tagId: tagB },
  ]);

  // Untagged txn: 50 expense.
  await postWithLineTags('Untagged', [
    { id: exp.id, amount: '50.00', side: 'debit', tagId: null },
    { id: cash.id, amount: '50.00', side: 'credit', tagId: null },
  ]);

  return { cash, rev, exp };
}

const PERIOD_START = '2026-01-01';
const PERIOD_END = '2026-12-31';

describe('Report parity — split-level tag filter does not distort totals', () => {
  beforeEach(async () => {
    await cleanDb();
    tenantId = await createTenant('parity');
    tagA = await mkTag('Project A');
    tagB = await mkTag('Project B');
  });

  afterEach(async () => {
    await cleanDb();
  });

  it('P&L: unfiltered total equals sum of per-tag + untagged-only runs', async () => {
    await seedFixture();

    const all = await reportService.buildProfitAndLoss(tenantId, PERIOD_START, PERIOD_END);
    const onlyA = await reportService.buildProfitAndLoss(tenantId, PERIOD_START, PERIOD_END, 'accrual', null, tagA);
    const onlyB = await reportService.buildProfitAndLoss(tenantId, PERIOD_START, PERIOD_END, 'accrual', null, tagB);

    // Revenue: A = 1000 + 300 = 1300, B = 500, untagged = 0. Sum = 1800.
    expect(all.totalRevenue).toBe(1800);
    expect(onlyA.totalRevenue).toBe(1300);
    expect(onlyB.totalRevenue).toBe(500);

    // Expenses: A = 0, B = 200, untagged = 50. Sum = 250.
    expect(all.totalExpenses).toBe(250);
    expect(onlyA.totalExpenses).toBe(0);
    expect(onlyB.totalExpenses).toBe(200);

    // Net income: all = 1800 - 250 = 1550. Per-tag: A = 1300, B = 300.
    expect(all.netIncome).toBe(1550);
    expect(onlyA.netIncome).toBe(1300);
    expect(onlyB.netIncome).toBe(300);

    // Parity: summing per-tag revenue + the untagged remainder reproduces the total.
    const untaggedRevenue = all.totalRevenue - onlyA.totalRevenue - onlyB.totalRevenue;
    const untaggedExpenses = all.totalExpenses - onlyA.totalExpenses - onlyB.totalExpenses;
    expect(untaggedRevenue).toBe(0);
    expect(untaggedExpenses).toBe(50);
  });

  it('General Ledger: tag-filtered line sums match the P&L filter', async () => {
    const { rev, exp } = await seedFixture();

    const glA = await reportService.buildGeneralLedger(tenantId, PERIOD_START, PERIOD_END, null, tagA);
    const glB = await reportService.buildGeneralLedger(tenantId, PERIOD_START, PERIOD_END, null, tagB);

    const revAcctA = glA.accounts.find((a: any) => a.id === rev.id);
    const revAcctB = glB.accounts.find((a: any) => a.id === rev.id);
    // Revenue is credit-normal, so ending balance reads as the positive
    // amount we credited. Tag A received 1000 + 300 = 1300.
    expect(revAcctA?.endingBalance).toBe(1300);
    expect(revAcctB?.endingBalance).toBe(500);

    const expAcctA = glA.accounts.find((a: any) => a.id === exp.id);
    const expAcctB = glB.accounts.find((a: any) => a.id === exp.id);
    expect(expAcctA).toBeUndefined(); // tag A never touched the expense account
    expect(expAcctB?.endingBalance).toBe(200);
  });

  it('Expenses-by-Category: tag filter narrows without distorting untagged totals', async () => {
    await seedFixture();

    const all = await reportService.buildExpenseByCategory(tenantId, PERIOD_START, PERIOD_END);
    const onlyB = await reportService.buildExpenseByCategory(tenantId, PERIOD_START, PERIOD_END, null, tagB);

    const allExpense = (all.data as any[]).find((r) => r.category === 'Expense');
    const bExpense = (onlyB.data as any[]).find((r) => r.category === 'Expense');
    expect(Number(allExpense?.total ?? 0)).toBe(250);
    expect(Number(bExpense?.total ?? 0)).toBe(200);
  });

  it('Trial Balance: tag filter keeps debits = credits invariant', async () => {
    await seedFixture();

    const tb = await reportService.buildTrialBalance(tenantId, PERIOD_START, PERIOD_END, null, tagA);
    // Every tenant's trial balance must tie out to the penny regardless
    // of whether a filter is applied — this is a fundamental accounting
    // identity, not a parity nicety.
    expect(tb.totalDebits).toBe(tb.totalCredits);
  });
});
