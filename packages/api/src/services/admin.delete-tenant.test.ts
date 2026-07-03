// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.
//
// Regression: deleteTenant's dynamic "delete every table with a
// tenant_id column" sweep must target BASE TABLES only. A tenant_id-
// bearing VIEW (e.g. conditional_rule_stats, aggregate w/ GROUP BY)
// used to get matched, and `DELETE FROM <view>` fails with 55000
// ("cannot delete from view"), 500-ing the whole delete.

import { describe, it, expect, afterEach } from 'vitest';
import bcrypt from 'bcrypt';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { tenants, users, userTenantAccess, companies, permissionTemplates, userPermissions } from '../db/schema/index.js';
import { deleteTenant } from './admin.service.js';

let doomed = '';
let fallback = '';

afterEach(async () => {
  for (const id of [doomed, fallback]) {
    if (!id) continue;
    await db.delete(userPermissions).where(eq(userPermissions.tenantId, id)).catch(() => {});
    await db.delete(permissionTemplates).where(eq(permissionTemplates.tenantId, id)).catch(() => {});
    await db.delete(companies).where(eq(companies.tenantId, id)).catch(() => {});
    await db.delete(userTenantAccess).where(eq(userTenantAccess.tenantId, id)).catch(() => {});
    await db.delete(users).where(eq(users.tenantId, id)).catch(() => {});
    await db.delete(tenants).where(eq(tenants.id, id)).catch(() => {});
  }
  doomed = ''; fallback = '';
});

describe('deleteTenant', () => {
  it('deletes a disabled tenant without choking on tenant_id views', async () => {
    const [a] = await db.insert(tenants).values({ name: 'Del', slug: 'del-' + Date.now() }).returning();
    const [b] = await db.insert(tenants).values({ name: 'Keep', slug: 'keep-' + Date.now() }).returning();
    doomed = a!.id; fallback = b!.id;
    const pw = await bcrypt.hash('x', 12);
    const [u] = await db.insert(users).values({ tenantId: doomed, email: `u-${Date.now()}@ex.com`, passwordHash: pw, displayName: 'U', role: 'owner', isActive: false }).returning();
    await db.insert(userTenantAccess).values({ userId: u!.id, tenantId: doomed, role: 'owner', isActive: false });
    await db.insert(userTenantAccess).values({ userId: u!.id, tenantId: fallback, role: 'owner', isActive: true });
    await db.insert(companies).values({ tenantId: doomed, businessName: 'Co', entityType: 'sole_prop', setupComplete: true });

    const result = await deleteTenant(doomed, u!.id);
    expect(result.deleted).toBe(true);
    const gone = await db.query.tenants.findFirst({ where: eq(tenants.id, doomed) });
    expect(gone).toBeUndefined();
    doomed = ''; // already deleted; skip cleanup
  });
});
