// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// items list(): the whitelisted server-side sort and the two boolean
// filters the Products & Services table sends.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { tenants, accounts, items, auditLog } from '../db/schema/index.js';
import * as itemsService from './items.service.js';

let tenantId = '';
let incomeAccountId = '';

async function cleanDb() {
  if (!tenantId) return;
  await db.delete(auditLog).where(eq(auditLog.tenantId, tenantId));
  await db.delete(items).where(eq(items.tenantId, tenantId));
  await db.delete(accounts).where(eq(accounts.tenantId, tenantId));
  await db.delete(tenants).where(eq(tenants.id, tenantId));
  tenantId = '';
}

beforeEach(async () => {
  await cleanDb();
  const [t] = await db.insert(tenants).values({ name: 'Items Sort', slug: 'items-sort-' + Date.now() }).returning();
  tenantId = t!.id;
  const [inc] = await db.insert(accounts).values({ tenantId, name: 'Sales', accountType: 'revenue' }).returning();
  incomeAccountId = inc!.id;
  const mk = (name: string, unitPrice: string | null, isTaxable: boolean, isActive = true) =>
    db.insert(items).values({ tenantId, name, unitPrice, incomeAccountId, isTaxable, isActive });
  await mk('Widget', '9.00', true);
  await mk('anvil', '100.00', false);
  await mk('Bolt', null, true, false);
  await mk('crate', '25.50', true);
});
afterEach(async () => { await cleanDb(); });

const names = async (f: Parameters<typeof itemsService.list>[1]) => (await itemsService.list(tenantId, f)).data.map((i) => i.name);

// The test cluster's default collation orders bytes, so uppercase names sort
// before lowercase ones: Bolt, Widget, anvil, crate.
describe('items list — sort and filters', () => {
  it('defaults to name order', async () => {
    expect(await names({})).toEqual(['Bolt', 'Widget', 'anvil', 'crate']);
  });
  it('sorts price numerically with unpriced last, both directions', async () => {
    expect(await names({ sortBy: 'price', sortDir: 'asc' })).toEqual(['Widget', 'crate', 'anvil', 'Bolt']);
    expect(await names({ sortBy: 'price', sortDir: 'desc' })).toEqual(['anvil', 'crate', 'Widget', 'Bolt']);
  });
  it('sorts by taxable and status, name as tiebreak', async () => {
    expect(await names({ sortBy: 'taxable', sortDir: 'asc' })).toEqual(['anvil', 'Bolt', 'Widget', 'crate']);
    expect(await names({ sortBy: 'status', sortDir: 'asc' })).toEqual(['Bolt', 'Widget', 'anvil', 'crate']);
  });
  it('filters by isTaxable and isActive', async () => {
    expect(await names({ isTaxable: false })).toEqual(['anvil']);
    expect(await names({ isActive: false })).toEqual(['Bolt']);
    expect(await names({ isTaxable: true, isActive: true })).toEqual(['Widget', 'crate']);
  });
});
