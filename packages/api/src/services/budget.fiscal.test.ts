// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// Fiscal-year budget alignment: create() anchors fiscal_year_start to
// the COMPANY's fiscal start month (was always Jan 1), and
// buildBudgetVsActual prorates the budget to the requested window (was
// the full 12 months regardless — the dashboard compared one month of
// actuals to a whole year of budget).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  tenants, users, sessions, accounts, companies, auditLog, contacts,
  transactions, journalLines, tags, transactionTags, budgets, budgetLines,
} from '../db/schema/index.js';
import * as budgetService from './budget.service.js';

let tenantId: string;

// Tenant-SCOPED cleanup — unscoped deletes nuke concurrently-running
// suites' data and die on their FKs. Only ever touch our own tenant.
async function cleanDb() {
  if (!tenantId) return;
  // budget_lines has no tenant_id — scope through this tenant's budgets.
  await db.delete(budgetLines).where(
    inArray(budgetLines.budgetId, db.select({ id: budgets.id }).from(budgets).where(eq(budgets.tenantId, tenantId))),
  );
  await db.delete(budgets).where(eq(budgets.tenantId, tenantId));
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

beforeEach(async () => {
  await cleanDb();
  const [t] = await db.insert(tenants).values({ name: 'Bud', slug: `bud-${Date.now()}` }).returning();
  tenantId = t!.id;
});

afterEach(async () => {
  await cleanDb();
});

describe('budget fiscal alignment', () => {
  it('create() derives fiscal_year_start from the company fiscal month', async () => {
    await db.insert(companies).values({
      tenantId, businessName: 'JulyCo', entityType: 'sole_prop', setupComplete: true,
      fiscalYearStartMonth: 7,
    });
    const budget = await budgetService.create(tenantId, { name: 'FY2026', fiscalYear: 2026 });
    expect(String((budget as any).fiscalYearStart).slice(0, 10)).toBe('2026-07-01');
  });

  it('buildBudgetVsActual prorates the budget to the requested window', async () => {
    await db.insert(companies).values({
      tenantId, businessName: 'JanCo', entityType: 'sole_prop', setupComplete: true,
      fiscalYearStartMonth: 1,
    });
    const [rev] = await db.insert(accounts).values({ tenantId, name: 'Sales', accountNumber: '4000', accountType: 'revenue' }).returning();
    const budget = await budgetService.create(tenantId, { name: 'FY2026', fiscalYear: 2026 });
    // 1,000/month budget
    await budgetService.updateLines(tenantId, budget!.id, [{
      accountId: rev!.id,
      month1: '1000', month2: '1000', month3: '1000', month4: '1000', month5: '1000', month6: '1000',
      month7: '1000', month8: '1000', month9: '1000', month10: '1000', month11: '1000', month12: '1000',
    }]);

    // One-month window → budget must be 1,000 (was 12,000 pre-fix).
    const march = await budgetService.buildBudgetVsActual(tenantId, budget!.id, '2026-03-01', '2026-03-31');
    expect(march.totalRevenueBudget).toBeCloseTo(1000, 2);

    // Three-month YTD window → 3,000.
    const q1 = await budgetService.buildBudgetVsActual(tenantId, budget!.id, '2026-01-01', '2026-03-31');
    expect(q1.totalRevenueBudget).toBeCloseTo(3000, 2);

    // Full-year window → all 12 months.
    const fy = await budgetService.buildBudgetVsActual(tenantId, budget!.id, '2026-01-01', '2026-12-31');
    expect(fy.totalRevenueBudget).toBeCloseTo(12000, 2);
  });
});
