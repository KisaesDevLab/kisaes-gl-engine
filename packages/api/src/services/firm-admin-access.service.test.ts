// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// firm_admin auto-access: active firm_admins automatically hold accountant
// access on every tenant the firm actively manages. Insert-only — existing
// rows (any role / state) are never touched, and nothing is revoked.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  tenants, users, firms, firmUsers, tenantFirmAssignments, userTenantAccess, auditLog,
} from '../db/schema/index.js';
import * as firmUsersService from './firm-users.service.js';
import * as assignmentService from './tenant-firm-assignment.service.js';

const suffix = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

let homeTenantId = '';
let firmId = '';
let adminUserId = '';
let staffUserId = '';
let clientAId = '';
let clientBId = '';

async function seedTenant(name: string): Promise<string> {
  const [t] = await db.insert(tenants).values({ name, slug: `${name.toLowerCase().replace(/\s+/g, '-')}-${suffix()}` }).returning();
  return t!.id;
}
async function seedUser(role: string, isSuperAdmin = false): Promise<string> {
  const [u] = await db.insert(users).values({
    tenantId: homeTenantId, email: `u-${suffix()}@example.com`, passwordHash: 'x'.repeat(60), role, displayName: role, isSuperAdmin,
  }).returning();
  return u!.id;
}
async function accessRow(userId: string, tenantId: string) {
  return db.query.userTenantAccess.findFirst({
    where: and(eq(userTenantAccess.userId, userId), eq(userTenantAccess.tenantId, tenantId)),
  });
}

async function cleanDb() {
  const uids = [adminUserId, staffUserId].filter(Boolean);
  if (uids.length) await db.delete(userTenantAccess).where(inArray(userTenantAccess.userId, uids));
  if (firmId) {
    await db.delete(tenantFirmAssignments).where(eq(tenantFirmAssignments.firmId, firmId));
    await db.delete(firmUsers).where(eq(firmUsers.firmId, firmId));
    await db.delete(firms).where(eq(firms.id, firmId));
  }
  const tIds = [homeTenantId, clientAId, clientBId].filter(Boolean);
  if (tIds.length) {
    await db.delete(auditLog).where(inArray(auditLog.tenantId, tIds));
    await db.delete(users).where(inArray(users.tenantId, tIds));
    await db.delete(tenants).where(inArray(tenants.id, tIds));
  }
  homeTenantId = firmId = adminUserId = staffUserId = clientAId = clientBId = '';
}

beforeEach(async () => {
  await cleanDb();
  homeTenantId = await seedTenant('AutoAccess Home');
  adminUserId = await seedUser('accountant');
  staffUserId = await seedUser('accountant');
  const [f] = await db.insert(firms).values({ name: 'AutoAccess Firm', slug: `autoaccess-${suffix()}` }).returning();
  firmId = f!.id;
  await db.insert(firmUsers).values([
    { firmId, userId: adminUserId, firmRole: 'firm_admin' },
    { firmId, userId: staffUserId, firmRole: 'firm_staff' },
  ]);
  clientAId = await seedTenant('AutoAccess Client A');
  clientBId = await seedTenant('AutoAccess Client B');
});
afterEach(cleanDb);

describe('firm_admin auto-access — on tenant assignment', () => {
  it('grants accountant access to active firm_admins, not firm_staff, and audits the grant', async () => {
    await assignmentService.assignTenant(firmId, { tenantId: clientAId, force: false }, adminUserId);
    expect(await accessRow(adminUserId, clientAId)).toMatchObject({ role: 'accountant', isActive: true });
    expect(await accessRow(staffUserId, clientAId)).toBeUndefined();

    const audits = await db.select().from(auditLog)
      .where(and(eq(auditLog.tenantId, clientAId), eq(auditLog.entityType, 'user_access')));
    expect(audits).toHaveLength(1);
    const after = audits[0]!.afterData;
    expect(typeof after === 'string' ? JSON.parse(after) : after).toMatchObject({ role: 'accountant', source: 'firm_admin_auto', firmId });
  });

  it('is idempotent on re-assign and self-heals a missing grant', async () => {
    await assignmentService.assignTenant(firmId, { tenantId: clientAId, force: false }, adminUserId);
    await db.delete(userTenantAccess).where(and(eq(userTenantAccess.userId, adminUserId), eq(userTenantAccess.tenantId, clientAId)));
    await assignmentService.assignTenant(firmId, { tenantId: clientAId, force: false }, adminUserId);
    expect(await accessRow(adminUserId, clientAId)).toMatchObject({ role: 'accountant', isActive: true });
  });

  it('never touches an existing row — owner stays owner, revoked stays revoked', async () => {
    await db.insert(userTenantAccess).values([
      { userId: adminUserId, tenantId: clientAId, role: 'owner', isActive: true },
      { userId: adminUserId, tenantId: clientBId, role: 'bookkeeper', isActive: false },
    ]);
    await assignmentService.assignTenant(firmId, { tenantId: clientAId, force: false }, adminUserId);
    await assignmentService.assignTenant(firmId, { tenantId: clientBId, force: false }, adminUserId);
    expect(await accessRow(adminUserId, clientAId)).toMatchObject({ role: 'owner', isActive: true });
    expect(await accessRow(adminUserId, clientBId)).toMatchObject({ role: 'bookkeeper', isActive: false });
  });

  it('skips inactive firm_admin memberships and revokes nothing on unassign', async () => {
    await db.update(firmUsers).set({ isActive: false }).where(and(eq(firmUsers.firmId, firmId), eq(firmUsers.userId, adminUserId)));
    await assignmentService.assignTenant(firmId, { tenantId: clientAId, force: false }, adminUserId);
    expect(await accessRow(adminUserId, clientAId)).toBeUndefined();

    await db.update(firmUsers).set({ isActive: true }).where(and(eq(firmUsers.firmId, firmId), eq(firmUsers.userId, adminUserId)));
    await assignmentService.assignTenant(firmId, { tenantId: clientAId, force: false }, adminUserId);
    expect(await accessRow(adminUserId, clientAId)).toMatchObject({ isActive: true });
    await assignmentService.unassignTenant(firmId, clientAId);
    expect(await accessRow(adminUserId, clientAId)).toMatchObject({ isActive: true });
  });
});

describe('firm_admin auto-access — on membership changes', () => {
  beforeEach(async () => {
    await db.insert(tenantFirmAssignments).values([
      { firmId, tenantId: clientAId, isActive: true },
      { firmId, tenantId: clientBId, isActive: true },
    ]);
  });

  it('promoting firm_staff → firm_admin grants access across the firm\'s tenants; demotion revokes nothing', async () => {
    const membership = await db.query.firmUsers.findFirst({ where: and(eq(firmUsers.firmId, firmId), eq(firmUsers.userId, staffUserId)) });
    await firmUsersService.updateMembership(firmId, membership!.id, { firmRole: 'firm_admin' });
    expect(await accessRow(staffUserId, clientAId)).toMatchObject({ role: 'accountant', isActive: true });
    expect(await accessRow(staffUserId, clientBId)).toMatchObject({ role: 'accountant', isActive: true });

    await firmUsersService.updateMembership(firmId, membership!.id, { firmRole: 'firm_staff' });
    expect(await accessRow(staffUserId, clientAId)).toMatchObject({ isActive: true });
  });

  it('inviting a user as firm_admin grants access; as firm_staff does not', async () => {
    const newAdmin = await seedUser('accountant');
    const newStaff = await seedUser('accountant');
    try {
      await firmUsersService.invite(firmId, { userId: newAdmin, firmRole: 'firm_admin' });
      await firmUsersService.invite(firmId, { userId: newStaff, firmRole: 'firm_staff' });
      expect(await accessRow(newAdmin, clientAId)).toMatchObject({ role: 'accountant' });
      expect(await accessRow(newStaff, clientAId)).toBeUndefined();
    } finally {
      await db.delete(userTenantAccess).where(inArray(userTenantAccess.userId, [newAdmin, newStaff]));
    }
  });

  it('ensureMembership self-heals an existing active firm_admin', async () => {
    await db.delete(userTenantAccess).where(eq(userTenantAccess.userId, adminUserId));
    await firmUsersService.ensureMembership(firmId, adminUserId, 'firm_staff'); // existing role is NOT downgraded
    const m = await db.query.firmUsers.findFirst({ where: and(eq(firmUsers.firmId, firmId), eq(firmUsers.userId, adminUserId)) });
    expect(m!.firmRole).toBe('firm_admin');
    expect(await accessRow(adminUserId, clientAId)).toMatchObject({ role: 'accountant' });
  });
});
