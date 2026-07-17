// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { APPLIANCE_FIRM_SLUG } from '@kis-books/shared';
import { db } from '../db/index.js';
import {
  tenants,
  users,
  firms,
  firmUsers,
  tenantFirmAssignments,
} from '../db/schema/index.js';
import * as provisioning from './firm-provisioning.service.js';
import * as firmUsersService from './firm-users.service.js';
import * as tenantFirmAssignmentService from './tenant-firm-assignment.service.js';

// Appliance-firm auto-provisioning coverage. The singleton firm is
// keyed by a fixed reserved slug, so cleanup must remove it by slug
// (plus its memberships/assignments) to keep tests independent.

let tenantId = '';
let userId = '';

async function cleanup() {
  const firm = await db.query.firms.findFirst({ where: eq(firms.slug, APPLIANCE_FIRM_SLUG) });
  if (firm) {
    await db.delete(tenantFirmAssignments).where(eq(tenantFirmAssignments.firmId, firm.id));
    await db.delete(firmUsers).where(eq(firmUsers.firmId, firm.id));
    await db.delete(firms).where(eq(firms.id, firm.id));
  }
  if (userId) await db.delete(users).where(eq(users.id, userId));
  if (tenantId) await db.delete(tenants).where(eq(tenants.id, tenantId));
  tenantId = '';
  userId = '';
}

beforeEach(async () => {
  await cleanup();
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const [t] = await db.insert(tenants).values({ name: 'Prov Tenant', slug: `prov-${suffix}` }).returning();
  tenantId = t!.id;
  const [u] = await db
    .insert(users)
    .values({ tenantId, email: `prov-${suffix}@example.com`, passwordHash: 'x', displayName: 'Prov Owner', role: 'owner' })
    .returning();
  userId = u!.id;
});

afterEach(async () => {
  await cleanup();
});

describe('firm-provisioning.ensureApplianceFirm', () => {
  it('creates the singleton appliance firm with the reserved slug', async () => {
    const firm = await provisioning.ensureApplianceFirm(userId);
    expect(firm.slug).toBe(APPLIANCE_FIRM_SLUG);
    expect(firm.superAdminManaged).toBe(true);
  });

  it('is idempotent — repeated calls return the same firm row', async () => {
    const a = await provisioning.ensureApplianceFirm(userId);
    const b = await provisioning.ensureApplianceFirm(userId);
    expect(b.id).toBe(a.id);
    const rows = await db.select().from(firms).where(eq(firms.slug, APPLIANCE_FIRM_SLUG));
    expect(rows).toHaveLength(1);
  });
});

describe('firm-provisioning.joinApplianceFirm', () => {
  it('assigns the tenant and makes the owner a firm_admin so firmRole resolves', async () => {
    await provisioning.joinApplianceFirm(tenantId, userId);

    const assignment = await tenantFirmAssignmentService.getActiveForTenant(tenantId);
    expect(assignment).not.toBeNull();

    const role = await firmUsersService.getRoleForUser(assignment!.firmId, userId);
    expect(role).toBe('firm_admin');
  });

  it('is idempotent — re-running yields one active assignment and one membership', async () => {
    await provisioning.joinApplianceFirm(tenantId, userId);
    await provisioning.joinApplianceFirm(tenantId, userId);

    const firm = await db.query.firms.findFirst({ where: eq(firms.slug, APPLIANCE_FIRM_SLUG) });
    const activeAssignments = await db
      .select()
      .from(tenantFirmAssignments)
      .where(and(eq(tenantFirmAssignments.tenantId, tenantId), eq(tenantFirmAssignments.isActive, true)));
    expect(activeAssignments).toHaveLength(1);

    const memberships = await db
      .select()
      .from(firmUsers)
      .where(and(eq(firmUsers.firmId, firm!.id), eq(firmUsers.userId, userId)));
    expect(memberships).toHaveLength(1);
  });
});

describe('firm-provisioning.assignTenantToApplianceFirm', () => {
  it('assigns the tenant WITHOUT making the user a firm member', async () => {
    await provisioning.assignTenantToApplianceFirm(tenantId, userId);

    const assignment = await tenantFirmAssignmentService.getActiveForTenant(tenantId);
    expect(assignment).not.toBeNull();

    // The actor must NOT become a member — membership is what exposes
    // the staff-only Practice/Firm surfaces to self-signup clients.
    const role = await firmUsersService.getRoleForUser(assignment!.firmId, userId);
    expect(role).toBeNull();
  });

  it('is idempotent and never reassigns an existing assignment', async () => {
    await provisioning.assignTenantToApplianceFirm(tenantId, userId);
    await provisioning.assignTenantToApplianceFirm(tenantId, userId);

    const activeAssignments = await db
      .select()
      .from(tenantFirmAssignments)
      .where(and(eq(tenantFirmAssignments.tenantId, tenantId), eq(tenantFirmAssignments.isActive, true)));
    expect(activeAssignments).toHaveLength(1);
  });
});
