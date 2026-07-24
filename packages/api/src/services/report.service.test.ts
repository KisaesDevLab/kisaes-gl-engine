// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
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

// Tenant-scoped cleanup — unscoped deletes would nuke concurrently
// running suites' rows on the shared test DB. Only touch our tenant.
async function cleanDb() {
  if (!tenantId) return;
  await db.delete(transactionTags).where(eq(transactionTags.tenantId, tenantId));
  await db.delete(tags).where(eq(tags.tenantId, tenantId));
  await db.delete(journalLines).where(eq(journalLines.tenantId, tenantId));
  await db.delete(transactions).where(eq(transactions.tenantId, tenantId));
  await db.delete(auditLog).where(eq(auditLog.tenantId, tenantId));
  await db.delete(contacts).where(eq(contacts.tenantId, tenantId));
  await db.delete(accounts).where(eq(accounts.tenantId, tenantId));
  await db.delete(companies).where(eq(companies.tenantId, tenantId));
  // sessions has no tenant_id — scope through this tenant's users.
  await db.delete(sessions).where(
    inArray(sessions.userId, db.select({ id: users.id }).from(users).where(eq(users.tenantId, tenantId))),
  );
  await db.delete(users).where(eq(users.tenantId, tenantId));
  await db.delete(tenants).where(eq(tenants.id, tenantId));
  tenantId = '';
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

describe('Report Service — check-image payee fallback (STATEMENT_CHECK_PAYEE_V1)', () => {
  beforeEach(async () => {
    await cleanDb();
    tenantId = await createTenant('checkpayee-test');
  });
  afterEach(async () => {
    await cleanDb();
  });

  it('expenses-by-vendor falls back to payee_name_on_check, and totals are unchanged', async () => {
    const cash = await mkAccount('Cash', 'asset', '1000');
    const exp = await mkAccount('Repairs', 'expense', '6200');

    // A statement-imported check: payee read off the image, no linked contact.
    const checkTxn = await post('CHECK 1051', [{ id: exp.id, amount: '250.00' }], [{ id: cash.id, amount: '250.00' }]);
    await db.update(transactions)
      .set({ payeeNameOnCheck: 'ACME Plumbing LLC', checkNumber: 1051 })
      .where(eq(transactions.id, checkTxn.id));

    // A plain uncategorized expense (no contact, no payee).
    await post('Misc', [{ id: exp.id, amount: '40.00' }], [{ id: cash.id, amount: '40.00' }]);

    const rep = await reportService.buildExpenseByVendor(tenantId, PERIOD_START, PERIOD_END);
    const rows = rep.data as Array<{ vendor_name: string; total: string }>;
    const byName = Object.fromEntries(rows.map((r) => [r.vendor_name, Number(r.total)]));

    // Fallback: the check rolls up under the read payee, not "Uncategorized".
    expect(byName['ACME Plumbing LLC']).toBe(250);
    expect(byName['Uncategorized']).toBe(40);
    // Cent-parity: the grand total equals the posted expense total ($290),
    // i.e. the label/grouping change moved nothing between buckets.
    const grand = rows.reduce((s, r) => s + Number(r.total), 0);
    expect(grand).toBe(290);
  });

  it('a contact still wins over the check-image payee', async () => {
    const cash = await mkAccount('Cash', 'asset', '1000');
    const exp = await mkAccount('Repairs', 'expense', '6200');
    const [vendor] = await db.insert(contacts).values({
      tenantId, displayName: 'Acme Plumbing', contactType: 'vendor',
    }).returning();

    const checkTxn = await post('CHECK 1052', [{ id: exp.id, amount: '99.00' }], [{ id: cash.id, amount: '99.00' }]);
    await db.update(transactions)
      .set({ contactId: vendor!.id, payeeNameOnCheck: 'STALE NAME', checkNumber: 1052 })
      .where(eq(transactions.id, checkTxn.id));

    const rep = await reportService.buildExpenseByVendor(tenantId, PERIOD_START, PERIOD_END);
    const rows = rep.data as Array<{ vendor_name: string; total: string }>;
    const byName = Object.fromEntries(rows.map((r) => [r.vendor_name, Number(r.total)]));
    expect(byName['Acme Plumbing']).toBe(99);
    expect(byName['STALE NAME']).toBeUndefined();
  });
});

describe('Report Service — wash/clearing account nets out of expense reports', () => {
  beforeEach(async () => {
    await cleanDb();
    tenantId = await createTenant('clearing-test');
  });
  afterEach(async () => {
    await cleanDb();
  });

  // A "Payroll Clearing" expense account funded and then reclassed to
  // Salaries nets to zero. It must NOT appear as its own expense (that
  // double-counts payroll, once as clearing + once as salaries) on either
  // the by-vendor or by-category report — matching the P&L, which nets
  // debit − credit and drops zero-net accounts.
  async function seedPayrollWash() {
    const cash = await mkAccount('Cash', 'asset', '1000');
    const clearing = await mkAccount('Payroll Clearing', 'expense', '6799');
    const salaries = await mkAccount('Salaries', 'expense', '6811');
    // Fund the clearing account (debit clearing, credit cash).
    await post('Fund payroll', [{ id: clearing.id, amount: '1000.00' }], [{ id: cash.id, amount: '1000.00' }]);
    // Reclass out of clearing into salaries (debit salaries, credit clearing).
    await post('Reclass payroll', [{ id: salaries.id, amount: '1000.00' }], [{ id: clearing.id, amount: '1000.00' }]);
    return { clearing, salaries };
  }

  it('excludes the net-zero clearing account from expenses-by-vendor (summary + detail)', async () => {
    await seedPayrollWash();

    const rep = await reportService.buildExpenseByVendor(tenantId, PERIOD_START, PERIOD_END, null, null, true);
    const rows = rep.data as Array<{ vendor_name: string; total: string }>;
    // Only salaries remains; the whole vendor group totals $1,000, not $2,000.
    const grand = rows.reduce((s, r) => s + Number(r.total), 0);
    expect(grand).toBe(1000);

    const groups = (rep as { groups: Array<{ vendorName: string; total: number; accounts: Array<{ name: string }> }> }).groups;
    const uncategorized = groups.find((g) => g.vendorName === 'Uncategorized')!;
    const acctNames = uncategorized.accounts.map((a) => a.name);
    expect(acctNames).toContain('Salaries');
    expect(acctNames).not.toContain('Payroll Clearing');
    expect(uncategorized.total).toBe(1000);
  });

  it('excludes the net-zero clearing account from expenses-by-category (summary + detail)', async () => {
    await seedPayrollWash();

    const rep = await reportService.buildExpenseByCategory(tenantId, PERIOD_START, PERIOD_END, null, null, null, true);
    const rows = rep.data as Array<{ category: string; total: string }>;
    const cats = rows.map((r) => r.category);
    expect(cats).toContain('Salaries');
    expect(cats).not.toContain('Payroll Clearing');

    // Detail grandTotal reflects only the real expense.
    expect((rep as { grandTotal: number }).grandTotal).toBe(1000);
    const sections = (rep as { groups: Array<{ name: string }> }).groups.map((g) => g.name);
    expect(sections).not.toContain('Payroll Clearing');
  });
});
