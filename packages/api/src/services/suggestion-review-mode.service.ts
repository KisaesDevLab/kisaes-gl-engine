// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Who may APPROVE category suggestions on a tenant, versus who may only
// SUGGEST. One answer for the API guard, the /mode endpoint the web reads,
// and the staff notification's recipient list.
//
//   super admin                                  → review
//   tenant actively managed by a firm            → review iff the caller is an
//                                                  active member of THAT firm
//                                                  (any firm role); everyone
//                                                  else on the tenant suggests
//   no active managing firm (self-managed books) → review iff tenant role is
//                                                  owner; accountants and
//                                                  bookkeepers suggest
//
// Uses the JWT's effective tenant role (req.userRole), exactly like
// requirePracticeAccess, so a switched-tenant session is judged by its role
// on THIS tenant.

import * as tenantFirmAssignmentService from './tenant-firm-assignment.service.js';
import * as firmsService from './firms.service.js';
import * as firmUsersService from './firm-users.service.js';

export interface ReviewMode {
  mode: 'review' | 'suggest';
  managedByFirm: boolean;
  firmName?: string;
  canReview: boolean;
}

export async function resolveReviewMode(
  tenantId: string,
  userId: string,
  userRole: string | undefined,
  isSuperAdmin: boolean,
): Promise<ReviewMode> {
  const assignment = await tenantFirmAssignmentService.getActiveForTenant(tenantId);
  let firm: { id: string; name: string; isActive: boolean } | null = null;
  if (assignment) {
    try {
      firm = await firmsService.getById(assignment.firmId);
    } catch {
      firm = null;
    }
  }
  // A deactivated managing firm authorizes nobody (same rule as
  // getRoleForUser), so the tenant is treated as self-managed.
  const managedByFirm = !!(firm && firm.isActive);
  const base = managedByFirm ? { managedByFirm, firmName: firm!.name } : { managedByFirm };

  if (isSuperAdmin) return { ...base, mode: 'review', canReview: true };

  let canReview: boolean;
  if (managedByFirm) {
    const firmRole = await firmUsersService.getRoleForUser(firm!.id, userId);
    canReview = firmRole !== null;
  } else {
    canReview = userRole === 'owner';
  }
  return { ...base, mode: canReview ? 'review' : 'suggest', canReview };
}
