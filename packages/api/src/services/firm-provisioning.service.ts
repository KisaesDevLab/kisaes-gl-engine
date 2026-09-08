// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

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
// (b) the user is an active firm_users member. Every tenant is
// auto-ASSIGNED to a single appliance-wide firm so firm/global
// rules apply to it — but firm MEMBERSHIP is reserved for actual
// practice staff. A self-signup client must never become a member:
// the appliance firm spans every tenant on the box, so membership
// leaks the tenant list/staff roster, and firm_admin membership
// historically allowed granting oneself access to other tenants'
// books (see requireFirmAdmin's superAdminManaged lockdown).
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
// UI resolves for them. Only the first-run setup wizard calls this now
// (the first admin becomes firm_admin of the appliance firm); client
// creation assigns to the creator's own firm via resolveFirmForNewClient
// and never adds memberships as a side effect. Idempotent:
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

// Which firm manages a NEW client tenant created by `creatorUserId`
// (POST /auth/create-client, POST /admin/create-client). The creator's
// own firm — not the appliance firm — so a multi-firm box keeps each
// practice's clients with that practice:
//   - requestedFirmId given: a super admin may name any active firm; a
//     staffer must be an active member of it (404 hides non-member firms,
//     like resolveFirmFromPath).
//   - exactly one membership: use it.
//   - several: 422 FIRM_SELECTION_REQUIRED with the candidate list.
//   - none: super admin → appliance firm; anyone else → 403.
// Resolve BEFORE provisioning so a bad firmId never orphans a tenant.
export async function resolveFirmForNewClient(
  creatorUserId: string,
  isSuperAdmin: boolean,
  requestedFirmId?: string,
): Promise<Firm> {
  const memberships = await firmsService.listForUser(creatorUserId);
  if (requestedFirmId) {
    if (isSuperAdmin) {
      const firm = await firmsService.getById(requestedFirmId);
      if (!firm.isActive) throw AppError.badRequest('That firm is deactivated', 'FIRM_INACTIVE');
      return firm;
    }
    const firm = memberships.find((f) => f.id === requestedFirmId);
    if (!firm) throw AppError.notFound('Firm not found');
    return firm;
  }
  if (memberships.length === 1) return memberships[0]!;
  if (memberships.length > 1) {
    throw AppError.unprocessableEntity(
      'Select which firm should manage the new company',
      'FIRM_SELECTION_REQUIRED',
      { firms: memberships.map((f) => ({ id: f.id, name: f.name })) },
    );
  }
  if (isSuperAdmin) return ensureApplianceFirm(creatorUserId);
  throw AppError.forbidden(
    'Only practice staff can create client companies. Ask a firm administrator to add you to the firm first.',
    'FIRM_MEMBERSHIP_REQUIRED',
  );
}

// Assignment-only variant for SELF-SIGNUP tenants: the tenant is
// managed by the appliance firm (so firm/global rules apply and
// practice staff can operate on it), but the signing-up user gets
// NO firm membership — they are a client, not practice staff.
// Idempotent; never touches an existing assignment to another firm.
export async function assignTenantToApplianceFirm(
  tenantId: string,
  actorUserId: string,
): Promise<void> {
  const firm = await ensureApplianceFirm(actorUserId);
  const existing = await tenantFirmAssignmentService.getActiveForTenant(tenantId);
  if (existing) return;
  await tenantFirmAssignmentService.assignTenant(
    firm.id,
    { tenantId, force: false },
    actorUserId,
  );
}
