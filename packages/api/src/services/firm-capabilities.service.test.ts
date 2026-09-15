// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Firm member access rights — resolver + editor service.
//   tenant-level: union across firms that ACTIVELY manage the tenant, only
//                 when the member has ACTIVE user_tenant_access on it
//   admin-level:  union across active memberships + per-capability scope
//   editor:       readonly ineligible, null clears, role change resets

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import { tenants, users, firms, firmUsers, tenantFirmAssignments, userTenantAccess } from '../db/schema/index.js';
import * as svc from './firm-capabilities.service.js';
import * as firmUsersService from './firm-users.service.js';

const sfx = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

let home = '', tA = '', tB = '', tC = '', tD = '', tE = '';
let staffId = '', adminId = '';
let firm1 = '', firm2 = '';
let staffFu1 = '', adminFu2 = '';

async function seedTenant(name: string) {
  const [t] = await db.insert(tenants).values({ name, slug: `fc-${name.toLowerCase()}-${sfx()}` }).returning();
  return t!.id;
}
async function seedUser(role: string) {
  const [u] = await db.insert(users).values({
    tenantId: home, email: `fc-${sfx()}@example.com`, passwordHash: 'x'.repeat(60), role, displayName: role,
  }).returning();
  return u!.id;
}

async function cleanDb() {
  const uids = [staffId, adminId].filter(Boolean);
  if (uids.length) await db.delete(userTenantAccess).where(inArray(userTenantAccess.userId, uids));
  const fids = [firm1, firm2].filter(Boolean);
  if (fids.length) {
    await db.delete(tenantFirmAssignments).where(inArray(tenantFirmAssignments.firmId, fids));
    await db.delete(firmUsers).where(inArray(firmUsers.firmId, fids));
    await db.delete(firms).where(inArray(firms.id, fids));
  }
  if (uids.length) await db.delete(users).where(inArray(users.id, uids));
  const tids = [home, tA, tB, tC, tD, tE].filter(Boolean);
  if (tids.length) await db.delete(tenants).where(inArray(tenants.id, tids));
  home = tA = tB = tC = tD = tE = staffId = adminId = firm1 = firm2 = staffFu1 = adminFu2 = '';
}

beforeEach(async () => {
  await cleanDb();
  home = await seedTenant('Home');
  tA = await seedTenant('A'); tB = await seedTenant('B'); tC = await seedTenant('C'); tD = await seedTenant('D'); tE = await seedTenant('E');
  staffId = await seedUser('accountant');
  adminId = await seedUser('accountant');
  const [f1] = await db.insert(firms).values({ name: 'Firm One', slug: `firm-one-${sfx()}` }).returning();
  const [f2] = await db.insert(firms).values({ name: 'Firm Two', slug: `firm-two-${sfx()}` }).returning();
  firm1 = f1!.id; firm2 = f2!.id;
  // A tenant has at most ONE active managing firm (partial unique index):
  // firm 1 manages A and B (C was detached); firm 2 manages E; D is unmanaged.
  await db.insert(tenantFirmAssignments).values([
    { firmId: firm1, tenantId: tA, isActive: true },
    { firmId: firm1, tenantId: tB, isActive: true },
    { firmId: firm1, tenantId: tC, isActive: false },
    { firmId: firm2, tenantId: tE, isActive: true },
  ]);
  // Staff: firm_staff in firm 1 with an explicit single grant.
  const [fu1] = await db.insert(firmUsers).values({
    firmId: firm1, userId: staffId, firmRole: 'firm_staff', capabilities: { team_management: true },
  }).returning();
  staffFu1 = fu1!.id;
  // Same staffer is a firm_admin in firm 2 with NULL (role defaults = all).
  const [fu2] = await db.insert(firmUsers).values({ firmId: firm2, userId: staffId, firmRole: 'firm_admin' }).returning();
  adminFu2 = fu2!.id;
  // Access: A (active), B (revoked), C (active but detached), D (active,
  // unmanaged), E (active, managed by firm 2).
  await db.insert(userTenantAccess).values([
    { userId: staffId, tenantId: tA, role: 'accountant', isActive: true },
    { userId: staffId, tenantId: tB, role: 'accountant', isActive: false },
    { userId: staffId, tenantId: tC, role: 'accountant', isActive: true },
    { userId: staffId, tenantId: tD, role: 'owner', isActive: true },
    { userId: staffId, tenantId: tE, role: 'accountant', isActive: true },
  ]);
});
afterEach(cleanDb);

describe('getTenantCapabilitiesForUser', () => {
  it('resolves per managing firm: explicit set on A, admin defaults on E', async () => {
    const a = await svc.getTenantCapabilitiesForUser(staffId, tA);
    expect(a.team_management).toBe(true);      // firm 1 explicit
    expect(a.check_signatures).toBe(false);    // firm 1 grants nothing else
    const e = await svc.getTenantCapabilitiesForUser(staffId, tE);
    expect(e.check_signatures).toBe(true);     // firm 2 firm_admin, NULL = all
    expect(e.admin_tenant_ops).toBe(true);
  });
  it('is nothing without ACTIVE user_tenant_access, even on a managed tenant', async () => {
    const caps = await svc.getTenantCapabilitiesForUser(staffId, tB);
    expect(Object.values(caps).some(Boolean)).toBe(false);
  });
  it('is nothing on a detached or unmanaged tenant', async () => {
    expect(Object.values(await svc.getTenantCapabilitiesForUser(staffId, tC)).some(Boolean)).toBe(false);
    expect(Object.values(await svc.getTenantCapabilitiesForUser(staffId, tD)).some(Boolean)).toBe(false);
  });
  it('an inactive membership or an inactive firm contributes nothing', async () => {
    await db.update(firmUsers).set({ isActive: false }).where(eq(firmUsers.id, adminFu2));
    expect(Object.values(await svc.getTenantCapabilitiesForUser(staffId, tE)).some(Boolean)).toBe(false);
    expect((await svc.getTenantCapabilitiesForUser(staffId, tA)).team_management).toBe(true);
    await db.update(firms).set({ isActive: false }).where(eq(firms.id, firm1));
    expect((await svc.getTenantCapabilitiesForUser(staffId, tA)).team_management).toBe(false);
  });
  it('firm_readonly never resolves anything, whatever is stored', async () => {
    await db.update(firmUsers).set({ firmRole: 'firm_readonly', capabilities: { team_management: true } })
      .where(eq(firmUsers.id, staffFu1));
    const caps = await svc.getTenantCapabilitiesForUser(staffId, tA);
    expect(caps.team_management).toBe(false);
  });
});

describe('admin-level', () => {
  it('getAdminCapabilitiesForUser unions memberships without a tenant condition', async () => {
    const caps = await svc.getAdminCapabilitiesForUser(staffId);
    expect(caps.admin_tenant_ops).toBe(true);
    expect(svc.hasAnyAdminCapability(caps)).toBe(true);
    // A user with no memberships has nothing.
    expect(svc.hasAnyAdminCapability(await svc.getAdminCapabilitiesForUser(adminId))).toBe(false);
  });
  it('getAdminScope returns only firms holding the capability and their ACTIVE tenants', async () => {
    // Only firm 2 (admin defaults) grants admin_tenant_ops → tenants: E only.
    const scope = await svc.getAdminScope(staffId, 'admin_tenant_ops');
    expect(scope.firmIds).toEqual([firm2]);
    expect(scope.tenantIds).toEqual([tE]);
    // team_management is held in both firms → A, B, E (C is detached).
    const tm = await svc.getAdminScope(staffId, 'team_management');
    expect(new Set(tm.firmIds)).toEqual(new Set([firm1, firm2]));
    expect(new Set(tm.tenantIds)).toEqual(new Set([tA, tB, tE]));
    // Nothing → empty.
    expect(await svc.getAdminScope(adminId, 'admin_tenant_ops')).toEqual({ firmIds: [], tenantIds: [] });
  });
  it('getForMe combines both views', async () => {
    const me = await svc.getForMe(staffId, tB);
    expect(me.tenant.team_management).toBe(false);
    expect(me.admin.admin_user_support).toBe(true);
  });
});

describe('editor', () => {
  it('getForMember reports stored vs effective', async () => {
    const v = await svc.getForMember(firm1, staffFu1);
    expect(v.capabilitiesCustomized).toBe(true);
    expect(v.stored).toEqual({ team_management: true });
    const v2 = await svc.getForMember(firm2, adminFu2);
    expect(v2.capabilitiesCustomized).toBe(false);
    expect(v2.stored).toBeNull();
    expect(v2.capabilities.admin_user_support).toBe(true);
  });
  it('404s a membership id from another firm', async () => {
    await expect(svc.getForMember(firm2, staffFu1)).rejects.toMatchObject({ statusCode: 404 });
  });
  it('setForMember stores a normalized set, null clears, readonly is refused', async () => {
    const r = await svc.setForMember(firm2, adminFu2, { capabilities: { check_signatures: true } }, adminId);
    expect(r.before.capabilities.admin_tenant_ops).toBe(true);
    expect(r.after.capabilities.admin_tenant_ops).toBe(false);
    expect(r.after.capabilities.check_signatures).toBe(true);
    expect(r.after.capabilitiesCustomized).toBe(true);
    const row = await db.query.firmUsers.findFirst({ where: eq(firmUsers.id, adminFu2) });
    expect(row!.capabilitiesUpdatedByUserId).toBe(adminId);

    const cleared = await svc.setForMember(firm2, adminFu2, { capabilities: null }, adminId);
    expect(cleared.after.capabilitiesCustomized).toBe(false);
    expect(cleared.after.capabilities.admin_tenant_ops).toBe(true);

    await db.update(firmUsers).set({ firmRole: 'firm_readonly' }).where(eq(firmUsers.id, staffFu1));
    await expect(svc.setForMember(firm1, staffFu1, { capabilities: { team_management: true } }, adminId))
      .rejects.toMatchObject({ code: 'FIRM_ROLE_INELIGIBLE' });
  });
  it('updateMembership with a role change resets the stored set to NULL', async () => {
    const after = await firmUsersService.updateMembership(firm1, staffFu1, { firmRole: 'firm_admin' });
    expect(after.capabilitiesCustomized).toBe(false);
    expect(after.capabilities.admin_user_support).toBe(true);
    // isActive-only patches leave the stored set alone.
    await db.update(firmUsers).set({ capabilities: { team_management: true } }).where(eq(firmUsers.id, staffFu1));
    const again = await firmUsersService.updateMembership(firm1, staffFu1, { isActive: true });
    expect(again.capabilitiesCustomized).toBe(true);
  });
  it('listForFirm carries capabilities on every row', async () => {
    const rows = await firmUsersService.listForFirm(firm1);
    const me = rows.find((r) => r.id === staffFu1)!;
    expect(me.capabilities.team_management).toBe(true);
    expect(me.capabilitiesCustomized).toBe(true);
  });
});
