// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// COGS / other_revenue / other_expense are P&L types (the engine folds
// everything that isn't asset/liability/equity). These held a book
// income of "revenue − expense only" out of M-1 and dropped whole
// sections from the Tax-Basis P&L and default groupings.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db, pool } from '../../db/index.js';
import {
  accounts, companies, companyTaxProfiles, journalLines, tenants, transactions,
} from '../../db/schema/index.js';
import { buildM1 } from './m1.service.js';
import { buildTbTaxBasisPl } from './tb-reports.service.js';
import { seedDefaultGroupings, listGroupings } from './groupings.service.js';

let tenantId: string;
let companyId: string;
const A: Record<string, string> = {};

beforeAll(async () => {
  const [t] = await db.insert(tenants).values({ name: 'tb-pl-types', slug: `tb-plt-${Date.now()}` }).returning();
  tenantId = t!.id;
  const [c] = await db.insert(companies).values({ tenantId, businessName: 'PL Types Co', fiscalYearStartMonth: 1 }).returning();
  companyId = c!.id;
  await db.insert(companyTaxProfiles).values({ tenantId, companyId, returnForm: '1120S' });
  const mk = async (num: string, name: string, type: string) => {
    const [a] = await db.insert(accounts).values({ tenantId, companyId, accountNumber: num, name, accountType: type }).returning();
    A[name] = a!.id;
  };
  await mk('1000', 'Cash', 'asset');
  await mk('4000', 'Sales', 'revenue');
  await mk('5000', 'Materials', 'cogs');
  await mk('6000', 'Rent', 'expense');
  await mk('7000', 'Interest Income', 'other_revenue');
  await mk('8000', 'Interest Expense', 'other_expense');

  const [txn] = await db.insert(transactions).values({
    tenantId, companyId, txnType: 'journal_entry', txnDate: '2026-03-15', status: 'posted', basis: 'both',
  }).returning();
  // Revenue 1000cr + Other income 50cr; COGS 300dr, Rent 100dr,
  // Interest exp 20dr; Cash nets the rest → book income 630.
  await db.insert(journalLines).values([
    { tenantId, transactionId: txn!.id, accountId: A['Cash']!, debit: '630', credit: '0', lineOrder: 0 },
    { tenantId, transactionId: txn!.id, accountId: A['Materials']!, debit: '300', credit: '0', lineOrder: 1 },
    { tenantId, transactionId: txn!.id, accountId: A['Rent']!, debit: '100', credit: '0', lineOrder: 2 },
    { tenantId, transactionId: txn!.id, accountId: A['Interest Expense']!, debit: '20', credit: '0', lineOrder: 3 },
    { tenantId, transactionId: txn!.id, accountId: A['Sales']!, debit: '0', credit: '1000', lineOrder: 4 },
    { tenantId, transactionId: txn!.id, accountId: A['Interest Income']!, debit: '0', credit: '50', lineOrder: 5 },
  ]);
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM tb_grouping_accounts WHERE tenant_id = ${tenantId}`);
  await db.execute(sql`DELETE FROM tb_groupings WHERE tenant_id = ${tenantId}`);
  await db.delete(companyTaxProfiles).where(eq(companyTaxProfiles.tenantId, tenantId));
  await db.delete(journalLines).where(eq(journalLines.tenantId, tenantId));
  await db.delete(transactions).where(eq(transactions.tenantId, tenantId));
  await db.execute(sql`DELETE FROM gl_version_stamps WHERE tenant_id = ${tenantId}`);
  await db.delete(accounts).where(eq(accounts.tenantId, tenantId));
  await db.delete(companies).where(eq(companies.tenantId, tenantId));
  await db.delete(tenants).where(eq(tenants.id, tenantId));
  await pool.end();
});

describe('COGS / other income / other expense as P&L types', () => {
  it('M-1 book income includes all five P&L sections', async () => {
    const m1 = await buildM1(tenantId, companyId, { taxYear: 2026, basis: 'accrual' });
    // 1000 − 300 − 100 + 50 − 20 = 630 (not the 900 the old
    // revenue−expense-only rule produced).
    expect(m1.bookIncome).toBe(630);
    expect(m1.taxIncome).toBe(630);
    expect(m1.reconciles).toBe(true);
  });

  it('Tax-Basis P&L renders COGS and Other sections and nets to 630', async () => {
    const pl = await buildTbTaxBasisPl(tenantId, companyId, '2026-12-31', 'accrual', null);
    const sections = pl.data.filter((r) => r['account_number'] === '---').map((r) => r['name']);
    expect(sections).toEqual(['Revenue', 'Cost of Goods Sold', 'Expenses', 'Other Income', 'Other Expenses']);
    const net = pl.data.find((r) => r['name'] === 'NET INCOME/(LOSS)')!;
    expect(Number(net['book'])).toBeCloseTo(630, 2);
    // Other Income shows credit-positive.
    const otherInc = pl.data.find((r) => r['name'] === 'Interest Income')!;
    expect(Number(otherInc['book'])).toBeCloseTo(50, 2);
  });

  it('default groupings place cogs/other types on their own leadsheets', async () => {
    await seedDefaultGroupings(tenantId, companyId);
    const { groupings } = await listGroupings(tenantId, companyId);
    const byName = new Map(groupings.map((g: { name: string; accountIds: string[] }) => [g.name, g.accountIds]));
    expect(byName.get('Cost of Goods Sold')).toContain(A['Materials']);
    expect(byName.get('Other Income')).toContain(A['Interest Income']);
    expect(byName.get('Other Expenses')).toContain(A['Interest Expense']);
  });
});
