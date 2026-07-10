// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// Year-end balance & carry-forward parity tests. These pin the fixes from
// the GL review:
//   - P&L uses SIGNED normal-balance amounts (abnormal balances reduce
//     their section instead of inflating net income via Math.abs)
//   - BS liability/equity totals are signed (contra equity like Owner
//     Withdraw reduces equity) and the sheet balances: A = L + E
//   - Posted entries to the Retained Earnings system account are
//     INCLUDED in equity (closing entries no longer unbalance the BS)
//   - TB debits == credits across a fiscal-year boundary, including with
//     abnormal balances and posted closing entries

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

async function cleanDb() {
  await db.delete(transactionTags);
  await db.delete(tags);
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

async function mkAccount(name: string, accountType: string, accountNumber: string) {
  return accountsService.create(tenantId, { name, accountNumber, accountType: accountType as any });
}

async function mkSystemRE() {
  const [re] = await db.insert(accounts).values({
    tenantId, accountNumber: '30120', name: 'Retained Earnings',
    accountType: 'equity', detailType: 'retained_earnings',
    isSystem: true, systemTag: 'retained_earnings',
  }).returning();
  return re!;
}

async function post(memo: string, debits: Array<{ id: string; amount: string }>, credits: Array<{ id: string; amount: string }>, date: string) {
  const lines = [
    ...debits.map((d) => ({ accountId: d.id, debit: d.amount, credit: '0' })),
    ...credits.map((c) => ({ accountId: c.id, debit: '0', credit: c.amount })),
  ];
  return ledger.postTransaction(tenantId, { txnType: 'journal_entry', txnDate: date, memo, lines });
}

beforeEach(async () => {
  await cleanDb();
  const [tenant] = await db.insert(tenants).values({ name: 'YE Test', slug: `ye-${Date.now()}` }).returning();
  tenantId = tenant!.id;
});

afterEach(async () => {
  await cleanDb();
});

describe('P&L signed amounts', () => {
  it('abnormal revenue balance reduces revenue instead of inflating it', async () => {
    const cash = await mkAccount('Cash', 'asset', '1000');
    const sales = await mkAccount('Sales', 'revenue', '4000');
    const refunds = await mkAccount('Refunds & Allowances', 'revenue', '4900');

    await post('Sale', [{ id: cash.id, amount: '100.00' }], [{ id: sales.id, amount: '100.00' }], '2026-03-01');
    await post('Refund', [{ id: refunds.id, amount: '30.00' }], [{ id: cash.id, amount: '30.00' }], '2026-03-15');

    const pl = await reportService.buildProfitAndLoss(tenantId, '2026-01-01', '2026-12-31');
    // Was 130 under Math.abs; correct is 100 − 30 = 70.
    expect(pl.totalRevenue).toBe(70);
    expect(pl.netIncome).toBe(70);
    const refundEntry = pl.revenue.find((e) => e.name.startsWith('Refunds'));
    expect(refundEntry?.amount).toBe(-30);
  });
});

describe('Balance Sheet identity (A = L + E)', () => {
  it('balances with contra equity (owner draws)', async () => {
    const cash = await mkAccount('Cash', 'asset', '1000');
    const sales = await mkAccount('Sales', 'revenue', '4000');
    const draw = await mkAccount('Owner Withdraw', 'equity', '30170');

    await post('Income', [{ id: cash.id, amount: '20000.00' }], [{ id: sales.id, amount: '20000.00' }], '2026-02-01');
    await post('Draw', [{ id: draw.id, amount: '10000.00' }], [{ id: cash.id, amount: '10000.00' }], '2026-05-01');

    const bs = await reportService.buildBalanceSheet(tenantId, '2026-06-30');
    expect(bs.totalAssets).toBeCloseTo(10000, 2);
    // Equity: net income 20,000 + Owner Withdraw −10,000 (signed contra)
    expect(bs.totalEquity).toBeCloseTo(10000, 2);
    expect(bs.totalAssets).toBeCloseTo(bs.totalLiabilities + bs.totalEquity, 2);
    const drawRow = bs.equity.find((e: any) => e.name === 'Owner Withdraw');
    expect(drawRow?.balance).toBeCloseTo(-10000, 2);
  });

  it('balances with abnormal-balance accounts feeding retained earnings across years', async () => {
    const cash = await mkAccount('Cash', 'asset', '1000');
    const sales = await mkAccount('Sales', 'revenue', '4000');
    const refunds = await mkAccount('Refunds', 'revenue', '4900');

    // Prior year: 100 sales, 30 refunds → prior net income 70
    await post('Sale', [{ id: cash.id, amount: '100.00' }], [{ id: sales.id, amount: '100.00' }], '2025-06-01');
    await post('Refund', [{ id: refunds.id, amount: '30.00' }], [{ id: cash.id, amount: '30.00' }], '2025-07-01');

    const bs = await reportService.buildBalanceSheet(tenantId, '2026-06-30');
    expect(bs.totalAssets).toBeCloseTo(70, 2);
    expect(bs.totalEquity).toBeCloseTo(70, 2);
    const re = bs.equity.find((e: any) => e.name === 'Retained Earnings (Prior Years)');
    expect(re?.balance).toBeCloseTo(70, 2);
  });

  it('keeps posted closing entries to Retained Earnings on the sheet', async () => {
    const cash = await mkAccount('Cash', 'asset', '1000');
    const sales = await mkAccount('Sales', 'revenue', '4000');
    const re = await mkSystemRE();

    // Prior year income, then a textbook closing entry into system RE.
    await post('Income', [{ id: cash.id, amount: '50000.00' }], [{ id: sales.id, amount: '50000.00' }], '2025-08-01');
    await post('Closing entry', [{ id: sales.id, amount: '50000.00' }], [{ id: re.id, amount: '50000.00' }], '2025-12-31');

    const bs = await reportService.buildBalanceSheet(tenantId, '2026-06-30');
    // Sales netted to zero by the closing entry → dynamic RE row is 0;
    // the POSTED RE balance must carry the 50k (was silently dropped).
    expect(bs.totalAssets).toBeCloseTo(50000, 2);
    expect(bs.totalEquity).toBeCloseTo(50000, 2);
    expect(bs.totalAssets).toBeCloseTo(bs.totalLiabilities + bs.totalEquity, 2);
    const reRow = bs.equity.find((e: any) => e.accountId === re.id);
    expect(reRow?.balance).toBeCloseTo(50000, 2);
  });

  it('returns totalLiabilitiesAndEquity = totalLiabilities + totalEquity (closing entry + contra equity)', async () => {
    const cash = await mkAccount('Cash', 'asset', '1000');
    const sales = await mkAccount('Sales', 'revenue', '4000');
    const loan = await mkAccount('Bank Loan', 'liability', '25000');
    const draw = await mkAccount('Owner Withdraw', 'equity', '30170');
    const re = await mkSystemRE();

    // Prior-year income closed into system RE, a loan, and a contra-equity draw.
    await post('Income', [{ id: cash.id, amount: '50000.00' }], [{ id: sales.id, amount: '50000.00' }], '2025-08-01');
    await post('Closing entry', [{ id: sales.id, amount: '50000.00' }], [{ id: re.id, amount: '50000.00' }], '2025-12-31');
    await post('Loan received', [{ id: cash.id, amount: '8000.00' }], [{ id: loan.id, amount: '8000.00' }], '2026-02-01');
    await post('Draw', [{ id: draw.id, amount: '10000.00' }], [{ id: cash.id, amount: '10000.00' }], '2026-05-01');

    const bs = await reportService.buildBalanceSheet(tenantId, '2026-06-30');
    expect(bs.totalLiabilitiesAndEquity).toBeDefined();
    expect(bs.totalLiabilitiesAndEquity).toBeCloseTo(bs.totalLiabilities + bs.totalEquity, 4);
    // And the sheet balances: A = L + E = 50k + 8k − 10k = 48k.
    expect(bs.totalLiabilitiesAndEquity).toBeCloseTo(48000, 2);
    expect(bs.totalAssets).toBeCloseTo(bs.totalLiabilitiesAndEquity, 2);
  });

  it('comparative BS carries a totalLiabilitiesAndEquity row', async () => {
    const cash = await mkAccount('Cash', 'asset', '1000');
    const sales = await mkAccount('Sales', 'revenue', '4000');
    await post('Income', [{ id: cash.id, amount: '1000.00' }], [{ id: sales.id, amount: '1000.00' }], '2026-01-15');

    const comparisonService = await import('./report-comparison.service.js');
    const cbs = await comparisonService.buildComparativeBS(tenantId, '2026-06-30', 'accrual', 'previous_year');
    expect(Array.isArray(cbs.totalLiabilitiesAndEquity)).toBe(true);
    // Column 0 = current as-of: 1,000 of equity (net income), no liabilities.
    expect(cbs.totalLiabilitiesAndEquity[0]).toBeCloseTo(1000, 2);
    // Grand total must equal Total Assets column-for-column (books balance).
    expect(cbs.totalLiabilitiesAndEquity[0]).toBeCloseTo(cbs.totalAssets[0] as number, 2);
    expect(cbs.totalLiabilitiesAndEquity[1]).toBeCloseTo(cbs.totalAssets[1] as number, 2);
  });
});

describe('Trial Balance across fiscal-year boundary', () => {
  it('debits equal credits with abnormal balances and a posted closing entry', async () => {
    const cash = await mkAccount('Cash', 'asset', '1000');
    const sales = await mkAccount('Sales', 'revenue', '4000');
    const refunds = await mkAccount('Refunds', 'revenue', '4900');
    const re = await mkSystemRE();

    await post('Sale', [{ id: cash.id, amount: '100.00' }], [{ id: sales.id, amount: '100.00' }], '2025-06-01');
    await post('Refund', [{ id: refunds.id, amount: '30.00' }], [{ id: cash.id, amount: '30.00' }], '2025-07-01');
    // Partial closing entry (20) so BOTH the posted RE row and the virtual
    // prior-years row coexist on the TB.
    await post('Partial close', [{ id: sales.id, amount: '20.00' }], [{ id: re.id, amount: '20.00' }], '2025-12-31');

    const tb = await reportService.buildTrialBalance(tenantId, '2026-01-01', '2026-06-30');
    expect(tb.totalDebits).toBeCloseTo(tb.totalCredits, 2);
    // Virtual prior-years RE row = prior net income NOT yet closed: 100−30−20 = 50
    // (netted `credit` column — proper TB format shows one side per row)
    const virtual = tb.data.find((r: any) => r.name === 'Retained Earnings (Prior Years)');
    expect(virtual?.credit).toBeCloseTo(50, 2);
    expect(virtual?.debit).toBeCloseTo(0, 2);
    // Posted RE account row carries the closed 20
    const posted = tb.data.find((r: any) => r.id === re.id);
    expect(posted?.credit).toBeCloseTo(20, 2);
    expect(posted?.debit).toBeCloseTo(0, 2);
  });
});
