// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

// 3-tier rules plan, Phase 1 — firms foundation types.
// A firm anchors `tenant_firm` and `global_firm` rule ownership
// independent of tenant lifecycles or staff roster changes.

export const FIRM_ROLES = ['firm_admin', 'firm_staff', 'firm_readonly'] as const;
export type FirmRole = typeof FIRM_ROLES[number];

export interface Firm {
  id: string;
  name: string;
  slug: string;
  isActive: boolean;
  superAdminManaged: boolean;
  createdByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FirmUser {
  id: string;
  firmId: string;
  userId: string;
  firmRole: FirmRole;
  isActive: boolean;
  createdAt: string;
}

export interface TenantFirmAssignment {
  id: string;
  tenantId: string;
  firmId: string;
  assignedByUserId: string | null;
  assignedAt: string;
  isActive: boolean;
}

// Convenience aggregate the firm-admin UI uses to render the
// staff-list page (firm_user rows joined with the underlying user
// row's display name + email).
export interface FirmUserWithProfile extends FirmUser {
  email: string;
  displayName: string | null;
}

// Aggregate for the firm-admin "managed tenants" page.
export interface TenantFirmAssignmentWithTenant extends TenantFirmAssignment {
  tenantName: string;
  tenantSlug: string;
}
