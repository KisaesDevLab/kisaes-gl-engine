// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

// Firm-staff per-tenant access: listTenantAccessForStaff / setTenantAccessForStaff.
// A firm admin grants a staffer user_tenant_access across the firm's MANAGED
// tenants only — the set is authoritative for the firm's tenants (grant/re-role/
// revoke) but must never touch the user's direct (non-firm) access, and must
// reject tenants the firm doesn't manage.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  tenants, users, firms, firmUsers, tenantFirmAssignments, userTenantAccess,
} from '../db/schema/index.js';
import * as firmUsersService from './firm-users.service.js';

const suffix = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

let homeTenantId = '';
let staffUserId = '';
let firmId = '';
let firmUserId = '';
let clientAId = '';
let clientBId = '';
let outsideTenantId = '';

async function seedTenant(name: string): Promise<string> {
  const [t] = await db.insert(tenants).values({ name, slug: `${name.toLowerCase().replace(/\s+/g, '-')}-${suffix()}` }).returning();
  return t!.id;
}

async function cleanDb() {
  if (staffUserId) await db.delete(userTenantAccess).where(eq(userTenantAccess.userId, staffUserId));
  if (firmId) {
    await db.delete(tenantFirmAssignments).where(eq(tenantFirmAssignments.firmId, firmId));
    await db.delete(firmUsers).where(eq(firmUsers.firmId, firmId));
    await db.delete(firms).where(eq(firms.id, firmId));
  }
  if (staffUserId) await db.delete(users).where(eq(users.id, staffUserId));
  const tIds = [homeTenantId, clientAId, clientBId, outsideTenantId].filter(Boolean);
  if (tIds.length) await db.delete(tenants).where(inArray(tenants.id, tIds));
  homeTenantId = staffUserId = firmId = firmUserId = clientAId = clientBId = outsideTenantId = '';
}

async function setup() {
  homeTenantId = await seedTenant('Access Home');
  const [u] = await db.insert(users).values({
    tenantId: homeTenantId,
    email: `staff-${suffix()}@example.com`,
    // Direct service calls never authenticate; a placeholder hash satisfies
    // the NOT NULL column without pulling in bcrypt.
    passwordHash: 'x'.repeat(60),
    role: 'accountant',
    displayName: 'Staffer',
  }).returning();
  staffUserId = u!.id;

  const [f] = await db.insert(firms).values({ name: 'Access Firm', slug: `access-firm-${suffix()}` }).returning();
  firmId = f!.id;
  const [fu] = await db.insert(firmUsers).values({ firmId, userId: staffUserId, firmRole: 'firm_staff' }).returning();
  firmUserId = fu!.id;

  clientAId = await seedTenant('Client A');
  clientBId = await seedTenant('Client B');
  await db.insert(tenantFirmAssignments).values([
    { firmId, tenantId: clientAId, isActive: true },
    { firmId, tenantId: clientBId, isActive: true },
  ]);

  // A tenant the firm does NOT manage, that the staffer already has direct
  // access to — must remain untouched by the firm-scoped setter.
  outsideTenantId = await seedTenant('Outside Co');
  await db.insert(userTenantAccess).values({ userId: staffUserId, tenantId: outsideTenantId, role: 'owner', isActive: true });
}

async function accessRow(tenantId: string) {
  return db.query.userTenantAccess.findFirst({
    where: and(eq(userTenantAccess.userId, staffUserId), eq(userTenantAccess.tenantId, tenantId)),
  });
}

beforeEach(async () => { await cleanDb(); await setup(); });
afterEach(async () => { await cleanDb(); });

describe('firm-staff tenant access', () => {
  it('lists only the firm\'s managed tenants, initially without access', async () => {
    const rows = await firmUsersService.listTenantAccessForStaff(firmId, firmUserId);
    expect(rows.map((r) => r.tenantName).sort()).toEqual(['Client A', 'Client B']);
    expect(rows.every((r) => r.hasAccess === false && r.role === null)).toBe(true);
    // The non-firm tenant is never surfaced here.
    expect(rows.some((r) => r.tenantId === outsideTenantId)).toBe(false);
  });

  it('grants access with per-tenant roles', async () => {
    const rows = await firmUsersService.setTenantAccessForStaff(firmId, firmUserId, {
      access: [{ tenantId: clientAId, role: 'accountant' }, { tenantId: clientBId, role: 'bookkeeper' }],
    });
    const byTenant = new Map(rows.map((r) => [r.tenantId, r]));
    expect(byTenant.get(clientAId)).toMatchObject({ hasAccess: true, role: 'accountant' });
    expect(byTenant.get(clientBId)).toMatchObject({ hasAccess: true, role: 'bookkeeper' });
    expect((await accessRow(clientAId))?.isActive).toBe(true);
    expect((await accessRow(clientBId))?.role).toBe('bookkeeper');
  });

  it('re-roles and revokes to match the desired set, leaving non-firm access untouched', async () => {
    await firmUsersService.setTenantAccessForStaff(firmId, firmUserId, {
      access: [{ tenantId: clientAId, role: 'accountant' }, { tenantId: clientBId, role: 'bookkeeper' }],
    });
    // Now keep only A (as readonly); B should be revoked.
    await firmUsersService.setTenantAccessForStaff(firmId, firmUserId, {
      access: [{ tenantId: clientAId, role: 'readonly' }],
    });

    expect(await accessRow(clientAId)).toMatchObject({ isActive: true, role: 'readonly' });
    expect((await accessRow(clientBId))?.isActive).toBe(false);
    // Direct access to the non-firm tenant is preserved.
    expect((await accessRow(outsideTenantId))?.isActive).toBe(true);
  });

  it('rejects a tenant the firm does not manage', async () => {
    await expect(
      firmUsersService.setTenantAccessForStaff(firmId, firmUserId, {
        access: [{ tenantId: outsideTenantId, role: 'accountant' }],
      }),
    ).rejects.toThrow(/not managed by this firm/i);
    // And nothing changed on the outside tenant.
    expect((await accessRow(outsideTenantId))?.role).toBe('owner');
  });
});
