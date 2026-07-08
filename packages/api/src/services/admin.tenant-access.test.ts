// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

// Admin tenant-access management: grantTenantAccess (create/reactivate/no-op),
// listUserTenantAccess, listFirmUsers, and the firm listAssignableTenants
// picker source (scoped by role, excludes already-assigned).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  tenants, users, firms, firmUsers, tenantFirmAssignments, userTenantAccess, auditLog,
} from '../db/schema/index.js';
import * as admin from './admin.service.js';
import * as assignmentService from './tenant-firm-assignment.service.js';

const sfx = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

let t0 = '', t1 = '', t2 = '';
let staffUserId = '', callerUserId = '', firmId = '';

async function seedTenant(name: string): Promise<string> {
  const [t] = await db.insert(tenants).values({ name, slug: `${name.toLowerCase().replace(/\s+/g, '-')}-${sfx()}` }).returning();
  return t!.id;
}
async function seedUser(tenantId: string): Promise<string> {
  const [u] = await db.insert(users).values({
    tenantId, email: `u-${sfx()}@example.com`, passwordHash: 'x'.repeat(60), role: 'accountant', displayName: 'U',
  }).returning();
  return u!.id;
}

async function cleanDb() {
  const uids = [staffUserId, callerUserId].filter(Boolean);
  if (uids.length) await db.delete(userTenantAccess).where(inArray(userTenantAccess.userId, uids));
  if (firmId) {
    await db.delete(tenantFirmAssignments).where(eq(tenantFirmAssignments.firmId, firmId));
    await db.delete(firmUsers).where(eq(firmUsers.firmId, firmId));
    await db.delete(firms).where(eq(firms.id, firmId));
  }
  const tids = [t0, t1, t2].filter(Boolean);
  for (const tid of tids) await db.delete(auditLog).where(eq(auditLog.tenantId, tid));
  if (uids.length) await db.delete(users).where(inArray(users.id, uids));
  if (tids.length) await db.delete(tenants).where(inArray(tenants.id, tids));
  t0 = t1 = t2 = staffUserId = callerUserId = firmId = '';
}

async function setup() {
  t0 = await seedTenant('Home Co');
  t1 = await seedTenant('Client One');
  t2 = await seedTenant('Client Two');
  staffUserId = await seedUser(t0);
  callerUserId = await seedUser(t0);
  const [f] = await db.insert(firms).values({ name: 'Acc Firm', slug: `acc-firm-${sfx()}` }).returning();
  firmId = f!.id;
}

beforeEach(async () => { await cleanDb(); await setup(); });
afterEach(async () => { await cleanDb(); });

describe('admin grantTenantAccess', () => {
  it('creates a new access row, then is a no-op for the same role, then re-roles', async () => {
    const created = await admin.grantTenantAccess(staffUserId, t1, 'accountant');
    expect(created).toMatchObject({ granted: true, reactivated: false, role: 'accountant' });

    const noop = await admin.grantTenantAccess(staffUserId, t1, 'accountant');
    expect(noop).toMatchObject({ granted: false, alreadyActive: true });

    const reRole = await admin.grantTenantAccess(staffUserId, t1, 'readonly');
    expect(reRole).toMatchObject({ granted: true, reactivated: true, role: 'readonly' });

    const row = await db.query.userTenantAccess.findFirst({
      where: and(eq(userTenantAccess.userId, staffUserId), eq(userTenantAccess.tenantId, t1)),
    });
    expect(row).toMatchObject({ isActive: true, role: 'readonly' });
  });

  it('reactivates a revoked row', async () => {
    await admin.grantTenantAccess(staffUserId, t1, 'accountant');
    await admin.toggleTenantAccess(staffUserId, t1); // -> revoked
    expect((await db.query.userTenantAccess.findFirst({
      where: and(eq(userTenantAccess.userId, staffUserId), eq(userTenantAccess.tenantId, t1)),
    }))?.isActive).toBe(false);

    await admin.grantTenantAccess(staffUserId, t1, 'accountant');
    expect((await db.query.userTenantAccess.findFirst({
      where: and(eq(userTenantAccess.userId, staffUserId), eq(userTenantAccess.tenantId, t1)),
    }))?.isActive).toBe(true);
  });
});

describe('admin listUserTenantAccess', () => {
  it('returns every tenant the user has a row for, with role + active flag', async () => {
    await admin.grantTenantAccess(staffUserId, t1, 'accountant');
    await admin.grantTenantAccess(staffUserId, t2, 'bookkeeper');
    await admin.toggleTenantAccess(staffUserId, t2); // revoke t2

    const rows = await admin.listUserTenantAccess(staffUserId);
    const byId = new Map(rows.map((r) => [r.tenantId, r]));
    expect(byId.get(t1)).toMatchObject({ role: 'accountant', isActive: true });
    expect(byId.get(t2)).toMatchObject({ role: 'bookkeeper', isActive: false });
  });
});

describe('admin listFirmUsers', () => {
  it('lists active firm members with their firm names', async () => {
    await db.insert(firmUsers).values({ firmId, userId: staffUserId, firmRole: 'firm_staff' });
    const list = await admin.listFirmUsers();
    const me = list.find((u) => u.id === staffUserId);
    expect(me).toBeTruthy();
    expect(me!.firmNames).toContain('Acc Firm');
  });
});

describe('firm listAssignableTenants', () => {
  it('super-admin sees unassigned tenants and excludes ones already assigned', async () => {
    await db.insert(tenantFirmAssignments).values({ firmId, tenantId: t1, isActive: true });
    const list = await assignmentService.listAssignableTenants(firmId, callerUserId, true);
    const ids = list.map((t) => t.tenantId);
    expect(ids).toContain(t2);      // unassigned → offered
    expect(ids).not.toContain(t1);  // already assigned → excluded
  });

  it('non-super-admin only sees tenants they own/are accountant on', async () => {
    // caller is owner on t2 only.
    await db.insert(userTenantAccess).values({ userId: callerUserId, tenantId: t2, role: 'owner', isActive: true });
    const list = await assignmentService.listAssignableTenants(firmId, callerUserId, false);
    expect(list.map((t) => t.tenantId)).toEqual([t2]);
  });
});
