// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { tenants, companies, auditLog, tbGroupings } from '../../db/schema/index.js';
import * as svc from './groupings.service.js';

let tenantId = '';
let companyId = '';

async function cleanup() {
  if (!tenantId) return;
  await db.delete(tbGroupings).where(eq(tbGroupings.tenantId, tenantId));
  await db.delete(auditLog).where(eq(auditLog.tenantId, tenantId));
  await db.delete(companies).where(eq(companies.tenantId, tenantId));
  await db.delete(tenants).where(eq(tenants.id, tenantId));
  tenantId = '';
}

beforeEach(async () => {
  await cleanup();
  const [t] = await db.insert(tenants).values({ name: 'LS Order', slug: `ls-order-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` }).returning();
  tenantId = t!.id;
  const [c] = await db.insert(companies).values({ tenantId, businessName: 'LS Order Co' }).returning();
  companyId = c!.id;
});
afterEach(cleanup);

describe('reorderGroupings', () => {
  it('re-sequences leadsheets so the list comes back in the new order', async () => {
    const a = await svc.createGrouping(tenantId, companyId, { name: 'Cash', leadsheetCode: 'A', sortOrder: 0 });
    const b = await svc.createGrouping(tenantId, companyId, { name: 'AR', leadsheetCode: 'B', sortOrder: 10 });
    const c = await svc.createGrouping(tenantId, companyId, { name: 'Equity', leadsheetCode: 'J', sortOrder: 20 });

    const res = await svc.reorderGroupings(tenantId, companyId, [c.id, a.id, b.id]);
    expect(res.groupings.map((g) => g.name)).toEqual(['Equity', 'Cash', 'AR']);
    expect((await svc.listGroupings(tenantId, companyId)).groupings.map((g) => g.sortOrder)).toEqual([0, 10, 20]);
  });

  it('rejects a list that omits, repeats, or invents a leadsheet', async () => {
    const a = await svc.createGrouping(tenantId, companyId, { name: 'Cash', sortOrder: 0 });
    const b = await svc.createGrouping(tenantId, companyId, { name: 'AR', sortOrder: 10 });
    await expect(svc.reorderGroupings(tenantId, companyId, [a.id])).rejects.toThrow('refresh');
    await expect(svc.reorderGroupings(tenantId, companyId, [a.id, a.id])).rejects.toThrow('refresh');
    await expect(svc.reorderGroupings(tenantId, companyId, [a.id, '00000000-0000-0000-0000-000000000000'])).rejects.toThrow('refresh');
    // Order unchanged after the rejected attempts.
    expect((await svc.listGroupings(tenantId, companyId)).groupings.map((g) => g.id)).toEqual([a.id, b.id]);
  });
});
