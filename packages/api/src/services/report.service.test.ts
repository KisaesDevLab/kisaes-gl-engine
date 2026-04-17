// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { db } from '../db/index.js';
import {
  tenants, users, sessions, accounts, companies, auditLog, contacts,
  transactions, journalLines, tags, transactionTags,
} from '../db/schema/index.js';
import * as ledger from './ledger.service.js';
import * as accountsService from './accounts.service.js';
import * as reportService from './report.service.js';
import * as tenantReportSettings from './tenant-report-settings.service.js';

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

async function createTenant(slug: string): Promise<string> {
  const [tenant] = await db.insert(tenants).values({
    name: 'Report Test',
    slug: `${slug}-${Date.now()}`,
  }).returning();
  return tenant!.id;
}

async function mkAccount(name: string, accountType: string, accountNumber: string) {
  return accountsService.create(tenantId, {
    name, accountNumber,
    accountType: accountType as any,
  });
}

async function post(memo: string, debits: Array<{ id: string; amount: string }>, credits: Array<{ id: string; amount: string }>, date = '2026-04-01') {
  const lines = [
    ...debits.map((d) => ({ accountId: d.id, debit: d.amount, credit: '0' })),
    ...credits.map((c) => ({ accountId: c.id, debit: '0', credit: c.amount })),
  ];
  return ledger.postTransaction(tenantId, {
    txnType: 'journal_entry',
    txnDate: date,
    memo,
    lines,
  });
}

const PERIOD_START = '2026-01-01';
const PERIOD_END = '2026-12-31';

describe('Report Service — Extended P&L', () => {
  beforeEach(async () => {
    await cleanDb();
    tenantId = await createTenant('pl-test');
  });

  afterEach(async () => {
    await cleanDb();
  });

  it('freelancer shape (revenue + expense only) renders classic two-section P&L', async () => {
    const cash = await mkAccount('Cash', 'asset', '1000');
    const rev = await mkAccount('Consulting Revenue', 'revenue', '4000');
    const exp = await mkAccount('Office Supplies', 'expense', '6100');

    await post('Invoice collected', [{ id: cash.id, amount: '1000.00' }], [{ id: rev.id, amount: '1000.00' }]);
    await post('Bought paper',      [{ id: exp.id, amount: '150.00' }],  [{ id: cash.id, amount: '150.00' }]);

    const pl = await reportService.buildProfitAndLoss(tenantId, PERIOD_START, PERIOD_END);

    expect(pl.totalRevenue).toBe(1000);
    expect(pl.totalExpenses).toBe(150);
    expect(pl.totalCogs).toBe(0);
    expect(pl.cogs.length).toBe(0);
    expect(pl.otherRevenue.length).toBe(0);
    expect(pl.otherExpenses.length).toBe(0);
    expect(pl.grossProfit).toBeNull();
    expect(pl.operatingIncome).toBeNull();
    expect(pl.netIncome).toBe(850);
  });

  it('retail shape with COGS produces Gross Profit and Operating Income subtotals', async () => {
    const cash = await mkAccount('Cash', 'asset', '1000');
    const rev = await mkAccount('Product Sales', 'revenue', '4000');
    const cogs = await mkAccount('Cost of Goods Sold', 'cogs', '5000');
    const exp = await mkAccount('Rent', 'expense', '6000');

    await post('Sale',      [{ id: cash.id, amount: '1000.00' }], [{ id: rev.id, amount: '1000.00' }]);
    await post('Inventory', [{ id: cogs.id, amount: '400.00' }],  [{ id: cash.id, amount: '400.00' }]);
    await post('Rent',      [{ id: exp.id, amount: '200.00' }],   [{ id: cash.id, amount: '200.00' }]);

    const pl = await reportService.buildProfitAndLoss(tenantId, PERIOD_START, PERIOD_END);

    expect(pl.totalRevenue).toBe(1000);
    expect(pl.totalCogs).toBe(400);
    expect(pl.totalExpenses).toBe(200);
    expect(pl.grossProfit).toBe(600);       // 1000 - 400
    expect(pl.operatingIncome).toBe(400);   // 600 - 200
    expect(pl.netIncome).toBe(400);         // no Other; equals Operating Income
  });

  it('other-revenue + other-expense without COGS produces Operating Income but no Gross Profit', async () => {
    const cash = await mkAccount('Cash', 'asset', '1000');
    const rev = await mkAccount('Service Revenue', 'revenue', '4000');
    const exp = await mkAccount('Rent', 'expense', '6000');
    const oRev = await mkAccount('Interest Income', 'other_revenue', '4800');
    const oExp = await mkAccount('Interest Expense', 'other_expense', '8100');

    await post('Service',          [{ id: cash.id, amount: '1000.00' }], [{ id: rev.id, amount: '1000.00' }]);
    await post('Rent',             [{ id: exp.id, amount: '300.00' }],   [{ id: cash.id, amount: '300.00' }]);
    await post('Bank interest in', [{ id: cash.id, amount: '50.00' }],   [{ id: oRev.id, amount: '50.00' }]);
    await post('Loan interest',    [{ id: oExp.id, amount: '20.00' }],   [{ id: cash.id, amount: '20.00' }]);

    const pl = await reportService.buildProfitAndLoss(tenantId, PERIOD_START, PERIOD_END);

    expect(pl.totalRevenue).toBe(1000);
    expect(pl.totalExpenses).toBe(300);
    expect(pl.totalOtherRevenue).toBe(50);
    expect(pl.totalOtherExpenses).toBe(20);
    expect(pl.grossProfit).toBeNull();       // no COGS
    expect(pl.operatingIncome).toBe(700);    // 1000 - 300
    expect(pl.netIncome).toBe(730);          // 700 + 50 - 20
  });

  it('custom tenant P&L labels flow through buildProfitAndLoss', async () => {
    const cash = await mkAccount('Cash', 'asset', '1000');
    const rev = await mkAccount('Sales', 'revenue', '4000');
    const cogs = await mkAccount('COGS', 'cogs', '5000');
    await post('Sale', [{ id: cash.id, amount: '500.00' }], [{ id: rev.id, amount: '500.00' }]);
    await post('Cost', [{ id: cogs.id, amount: '200.00' }], [{ id: cash.id, amount: '200.00' }]);

    await tenantReportSettings.updateSettings(tenantId, {
      plLabels: { revenue: 'Income', cogs: 'Cost of Sales', grossProfit: 'Gross Margin', netIncome: 'Bottom Line' },
    });

    const pl = await reportService.buildProfitAndLoss(tenantId, PERIOD_START, PERIOD_END);
    expect(pl.labels.revenue).toBe('Income');
    expect(pl.labels.cogs).toBe('Cost of Sales');
    expect(pl.labels.grossProfit).toBe('Gross Margin');
    expect(pl.labels.netIncome).toBe('Bottom Line');
    // Unchanged defaults still come through
    expect(pl.labels.expenses).toBe('Expenses');
  });

  it('General Ledger reports COGS and other_expense accounts as debit-normal', async () => {
    const cash = await mkAccount('Cash', 'asset', '1000');
    const rev = await mkAccount('Sales', 'revenue', '4000');
    const cogs = await mkAccount('COGS', 'cogs', '5000');
    const oExp = await mkAccount('Interest Expense', 'other_expense', '8100');
    const oRev = await mkAccount('Interest Income', 'other_revenue', '4800');
    await post('Sale', [{ id: cash.id, amount: '100.00' }], [{ id: rev.id, amount: '100.00' }]);
    await post('Buy inv', [{ id: cogs.id, amount: '40.00' }], [{ id: cash.id, amount: '40.00' }]);
    await post('Loan int', [{ id: oExp.id, amount: '5.00' }], [{ id: cash.id, amount: '5.00' }]);
    await post('Bank int', [{ id: cash.id, amount: '1.00' }], [{ id: oRev.id, amount: '1.00' }]);

    const gl: any = await reportService.buildGeneralLedger(tenantId, PERIOD_START, PERIOD_END);
    const byId = new Map(gl.accounts.map((a: any) => [a.id, a]));
    expect((byId.get(cogs.id) as any).normalBalance).toBe('debit');
    expect((byId.get(oExp.id) as any).normalBalance).toBe('debit');
    expect((byId.get(oRev.id) as any).normalBalance).toBe('credit');
    expect((byId.get(rev.id) as any).normalBalance).toBe('credit');
    // Ending balances should show positive for COGS debit-normal (40 debited)
    expect((byId.get(cogs.id) as any).endingBalance).toBe(40);
    expect((byId.get(oExp.id) as any).endingBalance).toBe(5);
    expect((byId.get(oRev.id) as any).endingBalance).toBe(1);
  });

  it('Balance Sheet retained-earnings math still balances after the extended P&L rebuild', async () => {
    await accountsService.seedFromTemplate(tenantId, 'default');
    const all = await accountsService.list(tenantId, { limit: 200, offset: 0 });
    const cash = all.data.find((a) => a.systemTag === 'cash_on_hand')!;
    const rev = await mkAccount('Revenue', 'revenue', '4001');
    const exp = await mkAccount('Expense', 'expense', '6001');

    // Prior fiscal year activity
    await post('Old sale', [{ id: cash.id, amount: '500.00' }], [{ id: rev.id, amount: '500.00' }], '2025-06-01');
    await post('Old cost', [{ id: exp.id, amount: '200.00' }], [{ id: cash.id, amount: '200.00' }], '2025-06-02');
    // Current year activity
    await post('New sale', [{ id: cash.id, amount: '1000.00' }], [{ id: rev.id, amount: '1000.00' }], '2026-03-01');

    const bs = await reportService.buildBalanceSheet(tenantId, '2026-12-31');
    // A = L + E must hold
    expect(Math.abs(bs.totalAssets - bs.totalLiabilitiesAndEquity)).toBeLessThan(0.0001);
  });
});
