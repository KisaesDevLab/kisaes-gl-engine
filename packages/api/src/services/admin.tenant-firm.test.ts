// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Admin firm surface: setTenantFirm (reassign soft-detaches, unassign,
// same-firm no-op, inactive firm refused, audited), getTenantDetail().firm,
// listTenants firm columns, listFirmsWithCounts, and the appliance-firm
// guards on firms.update.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { APPLIANCE_FIRM_SLUG } from '@kis-books/shared';
import { db } from '../db/index.js';
import { tenants, users, firms, firmUsers, tenantFirmAssignments, userTenantAccess, auditLog } from '../db/schema/index.js';
import * as admin from './admin.service.js';
import * as firmsService from './firms.service.js';
import * as provisioning from './firm-provisioning.service.js';

const sfx = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
let clientId = '', homeId = '', adminUserId = '', firmAId = '', firmBId = '', deadFirmId = '';

async function cleanDb() {
  if (adminUserId) await db.delete(userTenantAccess).where(eq(userTenantAccess.userId, adminUserId));
  const fids = [firmAId, firmBId, deadFirmId].filter(Boolean);
  if (clientId) await db.delete(tenantFirmAssignments).where(eq(tenantFirmAssignments.tenantId, clientId));
  if (fids.length) {
    await db.delete(tenantFirmAssignments).where(inArray(tenantFirmAssignments.firmId, fids));
    await db.delete(firmUsers).where(inArray(firmUsers.firmId, fids));
    await db.delete(firms).where(inArray(firms.id, fids));
  }
  const tids = [clientId, homeId].filter(Boolean);
  if (tids.length) {
    await db.delete(auditLog).where(inArray(auditLog.tenantId, tids));
    await db.delete(users).where(inArray(users.tenantId, tids));
    await db.delete(tenants).where(inArray(tenants.id, tids));
  }
  clientId = homeId = adminUserId = firmAId = firmBId = deadFirmId = '';
}

beforeEach(async () => {
  await cleanDb();
  const [h] = await db.insert(tenants).values({ name: 'ATF Home', slug: `atf-home-${sfx()}` }).returning();
  homeId = h!.id;
  const [c] = await db.insert(tenants).values({ name: 'ATF Client', slug: `atf-client-${sfx()}` }).returning();
  clientId = c!.id;
  const [u] = await db.insert(users).values({ tenantId: homeId, email: `atf-${sfx()}@example.com`, passwordHash: 'x'.repeat(60), role: 'owner', displayName: 'SA', isSuperAdmin: true }).returning();
  adminUserId = u!.id;
  const [a] = await db.insert(firms).values({ name: 'ATF Firm A', slug: `atf-a-${sfx()}` }).returning();
  firmAId = a!.id;
  const [b] = await db.insert(firms).values({ name: 'ATF Firm B', slug: `atf-b-${sfx()}` }).returning();
  firmBId = b!.id;
  const [d] = await db.insert(firms).values({ name: 'ATF Dead', slug: `atf-dead-${sfx()}`, isActive: false }).returning();
  deadFirmId = d!.id;
  // A firm_admin on B so reassign exercises auto-access.
  await db.insert(firmUsers).values({ firmId: firmBId, userId: adminUserId, firmRole: 'firm_admin' });
});
afterEach(cleanDb);

describe('admin.setTenantFirm', () => {
  it('assign → reassign (soft-detach + history) → unassign, audited; same firm is a no-op', async () => {
    let state = await admin.setTenantFirm(clientId, firmAId, adminUserId);
    expect(state.current?.firmName).toBe('ATF Firm A');
    expect(state.history).toHaveLength(0);

    state = await admin.setTenantFirm(clientId, firmAId, adminUserId); // no-op
    expect((await db.select().from(tenantFirmAssignments).where(eq(tenantFirmAssignments.tenantId, clientId))).length).toBe(1);

    state = await admin.setTenantFirm(clientId, firmBId, adminUserId);
    expect(state.current?.firmName).toBe('ATF Firm B');
    expect(state.current?.assignedByEmail).toContain('atf-');
    expect(state.history.map((h) => h.firmName)).toEqual(['ATF Firm A']);
    // firm_admin auto-access on B fired.
    expect(await db.query.userTenantAccess.findFirst({ where: and(eq(userTenantAccess.userId, adminUserId), eq(userTenantAccess.tenantId, clientId)) }))
      .toMatchObject({ role: 'accountant', isActive: true });

    state = await admin.setTenantFirm(clientId, null, adminUserId);
    expect(state.current).toBeNull();
    expect(state.history).toHaveLength(2);
    // Unassign revokes nothing.
    expect((await db.query.userTenantAccess.findFirst({ where: and(eq(userTenantAccess.userId, adminUserId), eq(userTenantAccess.tenantId, clientId)) }))?.isActive).toBe(true);
    // Clearing an unassigned tenant is a no-op.
    expect((await admin.setTenantFirm(clientId, null, adminUserId)).current).toBeNull();

    const audits = await db.select().from(auditLog).where(and(eq(auditLog.tenantId, clientId), eq(auditLog.entityType, 'tenant_firm_assignment')));
    expect(audits.map((a) => a.action).sort()).toEqual(['create', 'delete', 'update']);
  });

  it('refuses an inactive firm and an unknown tenant', async () => {
    await expect(admin.setTenantFirm(clientId, deadFirmId, adminUserId)).rejects.toMatchObject({ code: 'FIRM_INACTIVE' });
    await expect(admin.setTenantFirm('00000000-0000-0000-0000-000000000000', firmAId, adminUserId)).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('admin firm reads', () => {
  it('getTenantDetail().firm and listTenants firm columns', async () => {
    await admin.setTenantFirm(clientId, firmAId, adminUserId);
    const detail = await admin.getTenantDetail(clientId);
    expect(detail.firm.current?.firmId).toBe(firmAId);
    const list = await admin.listTenants({ search: 'ATF Client' });
    const row = list.tenants.find((t) => t.id === clientId);
    expect(row).toMatchObject({ firmId: firmAId, firmName: 'ATF Firm A' });
    const home = (await admin.listTenants({ search: 'ATF Home' })).tenants.find((t) => t.id === homeId);
    expect(home).toMatchObject({ firmId: null, firmName: null });
  });

  it('listFirmsWithCounts counts only active members/assignments and pages', async () => {
    await admin.setTenantFirm(clientId, firmBId, adminUserId);
    await db.insert(firmUsers).values({ firmId: firmBId, userId: '00000000-0000-0000-0000-000000000001', firmRole: 'firm_staff', isActive: false });
    const res = await admin.listFirmsWithCounts({ search: 'ATF' });
    const b = res.firms.find((f) => f.id === firmBId);
    expect(b).toMatchObject({ memberCount: 1, tenantCount: 1, isActive: true });
    const dead = res.firms.find((f) => f.id === deadFirmId);
    expect(dead?.isActive).toBe(false);
    expect(res.total).toBe(3);
    const page = await admin.listFirmsWithCounts({ search: 'ATF', limit: 1, offset: 1 });
    expect(page.firms).toHaveLength(1);
    expect(page.total).toBe(3);
  });
});

describe('firms.update appliance guards', () => {
  it('refuses a slug change and deactivation of the appliance firm; rename is fine', async () => {
    const appliance = await provisioning.ensureApplianceFirm(adminUserId);
    await expect(firmsService.update(appliance.id, { slug: 'something-else' })).rejects.toMatchObject({ code: 'APPLIANCE_FIRM_SLUG_LOCKED' });
    await expect(firmsService.update(appliance.id, { isActive: false })).rejects.toMatchObject({ code: 'APPLIANCE_FIRM_REQUIRED' });
    const renamed = await firmsService.update(appliance.id, { name: 'Renamed Practice', slug: APPLIANCE_FIRM_SLUG });
    expect(renamed.name).toBe('Renamed Practice');
    await firmsService.update(appliance.id, { name: 'Default Practice' });
    // Ordinary firms can still be deactivated.
    expect((await firmsService.update(firmAId, { isActive: false })).isActive).toBe(false);
  });
});
