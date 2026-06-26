// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import {
  APPLIANCE_FIRM_NAME,
  APPLIANCE_FIRM_SLUG,
  type Firm,
  type FirmRole,
} from '@kis-books/shared';
import * as firmsService from './firms.service.js';
import * as firmUsersService from './firm-users.service.js';
import * as tenantFirmAssignmentService from './tenant-firm-assignment.service.js';
import { AppError } from '../utils/errors.js';

// Appliance-firm auto-provisioning.
//
// The 3-tier conditional-rules UI (Mine / Firm / Global) only
// surfaces when `resolveFirmContext` returns a non-null firmRole,
// which requires (a) the tenant has an active firm assignment and
// (b) the user is an active firm_users member. On a self-hosted
// appliance we want this by default, so every tenant auto-joins a
// SINGLE appliance-wide firm and every tenant owner is a firm_admin
// of it. Global rules then span every tenant on the box.
//
// All functions here are idempotent and safe to call on every
// tenant-creation path and to re-run via the backfill script.

// Singleton getter/creator for the appliance firm, keyed by the
// reserved unique slug. Tolerates a create race (two registrations
// at once): on FIRM_SLUG_TAKEN it re-reads the winner's row.
export async function ensureApplianceFirm(createdByUserId: string): Promise<Firm> {
  const existing = await firmsService.getBySlug(APPLIANCE_FIRM_SLUG);
  if (existing) return existing;
  try {
    return await firmsService.create(
      {
        name: APPLIANCE_FIRM_NAME,
        slug: APPLIANCE_FIRM_SLUG,
        // Settings stay super-admin-managed so a tenant owner can't
        // rename/deactivate the shared appliance firm out from under
        // the other tenants; rule authoring is unaffected.
        superAdminManaged: true,
      },
      createdByUserId,
    );
  } catch (err) {
    if (err instanceof AppError && err.code === 'FIRM_SLUG_TAKEN') {
      const winner = await firmsService.getBySlug(APPLIANCE_FIRM_SLUG);
      if (winner) return winner;
    }
    throw err;
  }
}

// Ensure `tenantId` is managed by the appliance firm and that
// `ownerUserId` is a member (default firm_admin) so the tiered rules
// UI resolves for them. Idempotent:
//   - re-running for an already-managed tenant is a no-op for the
//     assignment (just guarantees the owner's membership);
//   - if the tenant is somehow already managed by a DIFFERENT firm
//     (pre-existing manual assignment), we leave that assignment in
//     place and instead make the owner a member of that firm — the
//     goal (firmRole resolves) is met either way, and we never
//     forcibly reassign someone's existing firm.
export async function joinApplianceFirm(
  tenantId: string,
  ownerUserId: string,
  firmRole: FirmRole = 'firm_admin',
): Promise<void> {
  const firm = await ensureApplianceFirm(ownerUserId);
  await firmUsersService.ensureMembership(firm.id, ownerUserId, firmRole);

  const existing = await tenantFirmAssignmentService.getActiveForTenant(tenantId);
  if (existing) {
    if (existing.firmId !== firm.id) {
      await firmUsersService.ensureMembership(existing.firmId, ownerUserId, firmRole);
    }
    return;
  }
  // assignTenant is itself idempotent for the same firm and races are
  // caught by the partial-unique index; force=false because in the
  // appliance model there is only one firm to belong to.
  await tenantFirmAssignmentService.assignTenant(
    firm.id,
    { tenantId, force: false },
    ownerUserId,
  );
}
