// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// deleteCompany: an additional company can be removed only when it has no
// activity, a tenant must keep at least one company, and deletion is
// tenant-scoped.

import { describe, it, expect, afterEach } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { tenants, companies, transactions } from '../db/schema/index.js';
import { createCompanyForTenant, createAdditionalCompany, deleteCompany } from './company.service.js';

let tenantId = '';

async function newTenant() {
  const [t] = await db.insert(tenants).values({
    name: 'CoDel', slug: 'codel-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
  }).returning();
  tenantId = t!.id;
  return tenantId;
}

afterEach(async () => {
  if (tenantId) {
    await db.delete(transactions).where(eq(transactions.tenantId, tenantId)).catch(() => {});
    await db.delete(companies).where(eq(companies.tenantId, tenantId)).catch(() => {});
    await db.delete(tenants).where(eq(tenants.id, tenantId)).catch(() => {});
    tenantId = '';
  }
});

describe('deleteCompany', () => {
  it('deletes an additional company with no activity', async () => {
    const id = await newTenant();
    await createCompanyForTenant(id, 'Primary Co');
    const extra = await createAdditionalCompany(id, { businessName: 'Extra Co' });

    const result = await deleteCompany(id, extra!.id);
    expect(result.deleted).toBe(true);

    const remaining = await db.select().from(companies).where(eq(companies.tenantId, id));
    expect(remaining.length).toBe(1);
    expect(remaining[0]!.businessName).toBe('Primary Co');
  });

  it('refuses to delete the only company', async () => {
    const id = await newTenant();
    const only = await createCompanyForTenant(id, 'Solo Co');
    await expect(deleteCompany(id, only!.id)).rejects.toThrow(/at least one company/i);
    const remaining = await db.select().from(companies).where(eq(companies.tenantId, id));
    expect(remaining.length).toBe(1);
  });

  it('refuses to delete a company that has transactions', async () => {
    const id = await newTenant();
    await createCompanyForTenant(id, 'Primary Co');
    const extra = await createAdditionalCompany(id, { businessName: 'Busy Co' });
    await db.insert(transactions).values({
      tenantId: id, companyId: extra!.id, txnType: 'expense', txnDate: '2026-01-01',
    });

    await expect(deleteCompany(id, extra!.id)).rejects.toThrow(/transaction/i);
    const still = await db.select().from(companies)
      .where(and(eq(companies.tenantId, id), eq(companies.id, extra!.id)));
    expect(still.length).toBe(1);
  });

  it('is tenant-scoped — another tenant cannot delete this company', async () => {
    const id = await newTenant();
    await createCompanyForTenant(id, 'Primary Co');
    const extra = await createAdditionalCompany(id, { businessName: 'Extra Co' });

    const [other] = await db.insert(tenants).values({
      name: 'Other', slug: 'other-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
    }).returning();
    await expect(deleteCompany(other!.id, extra!.id)).rejects.toThrow(/not found/i);
    await db.delete(tenants).where(eq(tenants.id, other!.id)).catch(() => {});

    // Still present under the real tenant.
    const still = await db.select().from(companies).where(eq(companies.id, extra!.id));
    expect(still.length).toBe(1);
  });
});
