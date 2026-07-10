// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// Covers the two COA admin features:
//   1. seedFromTemplate({ systemOnly }) seeds ONLY the required system
//      accounts (skips the rest of the business-type template).
//   2. deleteChartOfAccounts removes only NON-system accounts (rule #25
//      protects system accounts), and only when the tenant has zero
//      transactions.
//   3. delete + applyCoaTemplate re-seeds without duplicating the preserved
//      system accounts.

import { describe, it, expect, afterEach } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { tenants, accounts, transactions } from '../db/schema/index.js';
import { seedFromTemplate } from './accounts.service.js';
import { deleteChartOfAccounts, applyCoaTemplate } from './admin.service.js';

let tenantId = '';

async function newTenant() {
  const [t] = await db.insert(tenants).values({ name: 'CoaT', slug: 'coat-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6) }).returning();
  tenantId = t!.id;
  return tenantId;
}

afterEach(async () => {
  if (tenantId) {
    await db.delete(transactions).where(eq(transactions.tenantId, tenantId)).catch(() => {});
    await db.delete(accounts).where(eq(accounts.tenantId, tenantId)).catch(() => {});
    await db.delete(tenants).where(eq(tenants.id, tenantId)).catch(() => {});
    tenantId = '';
  }
});

describe('seedFromTemplate systemOnly', () => {
  it('seeds only the required system accounts', async () => {
    const id = await newTenant();
    await seedFromTemplate(id, 'default', undefined, { systemOnly: true });
    const rows = await db.select().from(accounts).where(eq(accounts.tenantId, id));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((a) => a.isSystem === true)).toBe(true);
    // The canonical required system tags must all be present.
    const tags = new Set(rows.map((a) => a.systemTag));
    for (const t of ['accounts_receivable', 'accounts_payable', 'payments_clearing', 'sales_tax_payable', 'opening_balances', 'retained_earnings']) {
      expect(tags.has(t)).toBe(true);
    }
  });

  it('full seed includes non-system accounts', async () => {
    const id = await newTenant();
    await seedFromTemplate(id, 'default');
    const rows = await db.select().from(accounts).where(eq(accounts.tenantId, id));
    expect(rows.some((a) => a.isSystem === false)).toBe(true);
  });
});

describe('deleteChartOfAccounts', () => {
  it('deletes non-system accounts but preserves system accounts', async () => {
    const id = await newTenant();
    await seedFromTemplate(id, 'default');
    const before = await db.select().from(accounts).where(eq(accounts.tenantId, id));
    const systemBefore = before.filter((a) => a.isSystem === true).length;
    const nonSystemBefore = before.filter((a) => a.isSystem !== true).length;
    expect(systemBefore).toBeGreaterThan(0);
    expect(nonSystemBefore).toBeGreaterThan(0);

    const result = await deleteChartOfAccounts(id, undefined);
    expect(result.accountsDeleted).toBe(nonSystemBefore);
    expect(result.systemAccountsKept).toBe(systemBefore);

    const after = await db.select().from(accounts).where(eq(accounts.tenantId, id));
    // Only system accounts remain, and every one of them survived.
    expect(after.length).toBe(systemBefore);
    expect(after.every((a) => a.isSystem === true)).toBe(true);
  });

  it('refuses when the tenant has transactions', async () => {
    const id = await newTenant();
    await seedFromTemplate(id, 'default');
    await db.insert(transactions).values({ tenantId: id, txnType: 'expense', txnDate: '2026-01-01' });
    await expect(deleteChartOfAccounts(id, undefined)).rejects.toThrow(/transaction/i);
    // accounts untouched
    const rows = await db.select().from(accounts).where(eq(accounts.tenantId, id));
    expect(rows.length).toBeGreaterThan(0);
  });

  it('delete + applyCoaTemplate re-seeds without duplicating system accounts', async () => {
    const id = await newTenant();
    await seedFromTemplate(id, 'default');
    await deleteChartOfAccounts(id, undefined);

    // System accounts remain; the swap must succeed (guard counts only
    // non-system) and must NOT create a second copy of any system account.
    await applyCoaTemplate(id, 'default', undefined);

    const after = await db.select().from(accounts).where(eq(accounts.tenantId, id));
    const systemRows = after.filter((a) => a.isSystem === true);
    // Exactly one system account per systemTag — no duplicates.
    const tags = systemRows.map((a) => a.systemTag);
    expect(new Set(tags).size).toBe(tags.length);
    // And no duplicate account numbers across the whole re-seeded chart.
    const numbers = after.map((a) => a.accountNumber).filter(Boolean);
    expect(new Set(numbers).size).toBe(numbers.length);
    expect(after.some((a) => a.isSystem !== true)).toBe(true);
  });

  it('is idempotent on the non-system count — a second delete removes nothing', async () => {
    const id = await newTenant();
    await seedFromTemplate(id, 'default');
    await deleteChartOfAccounts(id, undefined);
    const second = await deleteChartOfAccounts(id, undefined);
    expect(second.accountsDeleted).toBe(0);
    // Guard: never accidentally delete a system account.
    const sys = await db.select().from(accounts)
      .where(and(eq(accounts.tenantId, id), eq(accounts.isSystem, true)));
    expect(sys.length).toBeGreaterThan(0);
  });
});
