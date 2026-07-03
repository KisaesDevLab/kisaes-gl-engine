// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.
//
// Covers the two COA admin features:
//   1. seedFromTemplate({ systemOnly }) seeds ONLY the required system
//      accounts (skips the rest of the business-type template).
//   2. deleteChartOfAccounts removes all accounts, but only when the
//      tenant has zero transactions.

import { describe, it, expect, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { tenants, accounts, transactions } from '../db/schema/index.js';
import { seedFromTemplate } from './accounts.service.js';
import { deleteChartOfAccounts } from './admin.service.js';

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
  it('deletes all accounts when the tenant has no transactions', async () => {
    const id = await newTenant();
    await seedFromTemplate(id, 'default');
    const result = await deleteChartOfAccounts(id, undefined);
    expect(result.accountsDeleted).toBeGreaterThan(0);
    const rows = await db.select().from(accounts).where(eq(accounts.tenantId, id));
    expect(rows.length).toBe(0);
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
});
