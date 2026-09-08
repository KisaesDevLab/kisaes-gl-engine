// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// firm_admin auto-access.
//
// Rule: every ACTIVE firm_admin of a firm automatically holds `accountant`
// access (a user_tenant_access row) on every tenant ACTIVELY assigned to
// that firm — the appliance firm included. firm_staff / firm_readonly stay
// explicit-grant (Firm → Staff → Tenant access).
//
// Semantics are deliberately insert-only:
//   - no row for (user, tenant)            → insert role=accountant, audited
//   - ANY existing row (active or inactive,
//     any role)                            → untouched. An owner is never
//                                            downgraded; a row a firm admin
//                                            deliberately revoked in the
//                                            access matrix stays revoked.
//   - demotion / firm unassign             → nothing is revoked.
//
// Triggers (callers): tenant-firm-assignment.assignTenant (every assignment
// path), firm-users invite / updateMembership / ensureMembership when the
// resulting membership is an active firm_admin. Migration 0169 backfilled
// existing data with identical semantics.
//
// This module imports no other firm service so both of them can import it
// without a cycle.

import { and, eq } from 'drizzle-orm';
import { db, type DbOrTx } from '../db/index.js';
import { firmUsers, tenantFirmAssignments, userTenantAccess } from '../db/schema/index.js';
import { auditLog } from '../middleware/audit.js';

export type AccessGrantSource = 'firm_admin_auto' | 'firm_invite_accept';

export async function ensureAccountantAccess(
  userId: string,
  tenantId: string,
  ctx: { firmId: string; actorUserId?: string; source: AccessGrantSource },
  executor?: DbOrTx,
): Promise<'granted' | 'skipped'> {
  const exec = executor ?? db;
  const [existing] = await exec
    .select({ id: userTenantAccess.id })
    .from(userTenantAccess)
    .where(and(eq(userTenantAccess.userId, userId), eq(userTenantAccess.tenantId, tenantId)))
    .limit(1);
  if (existing) return 'skipped';

  // uta_user_tenant_idx (user_id, tenant_id) is UNIQUE — a concurrent
  // insert loses the race silently, which is the same "skipped" outcome.
  const inserted = await exec
    .insert(userTenantAccess)
    .values({ userId, tenantId, role: 'accountant', isActive: true })
    .onConflictDoNothing()
    .returning({ id: userTenantAccess.id });
  if (inserted.length === 0) return 'skipped';

  await auditLog(
    tenantId,
    'create',
    'user_access',
    userId,
    null,
    { role: 'accountant', source: ctx.source, firmId: ctx.firmId },
    ctx.actorUserId,
    exec,
  );
  return 'granted';
}

// All active firm_admins of `firmId` → access on `tenantId`.
export async function syncFirmAdminAccessForTenant(
  firmId: string,
  tenantId: string,
  actorUserId?: string,
  executor?: DbOrTx,
): Promise<number> {
  const exec = executor ?? db;
  const admins = await exec
    .select({ userId: firmUsers.userId })
    .from(firmUsers)
    .where(and(
      eq(firmUsers.firmId, firmId),
      eq(firmUsers.firmRole, 'firm_admin'),
      eq(firmUsers.isActive, true),
    ));
  let granted = 0;
  for (const a of admins) {
    if (await ensureAccountantAccess(a.userId, tenantId, { firmId, actorUserId, source: 'firm_admin_auto' }, exec) === 'granted') {
      granted += 1;
    }
  }
  return granted;
}

// One (now-)firm_admin → access on every tenant the firm actively manages.
export async function syncFirmAdminAccessForUser(
  firmId: string,
  userId: string,
  actorUserId?: string,
  executor?: DbOrTx,
): Promise<number> {
  const exec = executor ?? db;
  const assignments = await exec
    .select({ tenantId: tenantFirmAssignments.tenantId })
    .from(tenantFirmAssignments)
    .where(and(eq(tenantFirmAssignments.firmId, firmId), eq(tenantFirmAssignments.isActive, true)));
  let granted = 0;
  for (const a of assignments) {
    if (await ensureAccountantAccess(userId, a.tenantId, { firmId, actorUserId, source: 'firm_admin_auto' }, exec) === 'granted') {
      granted += 1;
    }
  }
  return granted;
}

// Both dimensions for a firm — ops / tests / repair.
export async function syncFirmAdminAccess(firmId: string, actorUserId?: string): Promise<number> {
  const assignments = await db
    .select({ tenantId: tenantFirmAssignments.tenantId })
    .from(tenantFirmAssignments)
    .where(and(eq(tenantFirmAssignments.firmId, firmId), eq(tenantFirmAssignments.isActive, true)));
  let granted = 0;
  for (const a of assignments) {
    granted += await syncFirmAdminAccessForTenant(firmId, a.tenantId, actorUserId);
  }
  return granted;
}
