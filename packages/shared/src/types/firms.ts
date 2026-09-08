// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// 3-tier rules plan, Phase 1 — firms foundation types.
// A firm anchors `tenant_firm` and `global_firm` rule ownership
// independent of tenant lifecycles or staff roster changes.

export const FIRM_ROLES = ['firm_admin', 'firm_staff', 'firm_readonly'] as const;
export type FirmRole = typeof FIRM_ROLES[number];

// The self-hosted appliance hosts firm-wide (global) conditional
// rules through a single "appliance firm" that every tenant on the
// box auto-joins. It is a SINGLETON identified by this reserved
// slug — firms.slug is UNIQUE, so the slug alone guarantees one and
// only one appliance firm. Provisioning (`ensureApplianceFirm`)
// creates it on demand; the name is editable later via firm
// settings without affecting the slug-keyed identity.
export const APPLIANCE_FIRM_SLUG = 'default-practice';
export const APPLIANCE_FIRM_NAME = 'Default Practice';

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

// GET /firms/:id response: the firm plus the CALLER's role in it, so
// the UI can hide roster / managed-tenant / invite controls from a
// firm_readonly member instead of letting the server 403 them.
// Super admins always read as `firm_admin`.
export interface FirmWithMyRole extends Firm {
  myRole: FirmRole;
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

// Admin → Firms list row: the firm plus live counts.
export interface AdminFirmSummary extends Firm {
  memberCount: number;   // active firm_users rows
  tenantCount: number;   // active tenant_firm_assignments rows
}

// Tenant-side view of an assignment (admin tenant detail page).
export interface TenantFirmAssignmentWithFirm extends TenantFirmAssignment {
  firmName: string;
  firmSlug: string;
  firmIsActive: boolean;
  assignedByEmail: string | null;
}

export interface TenantFirmState {
  current: TenantFirmAssignmentWithFirm | null;
  // Soft-detached history, newest first.
  history: TenantFirmAssignmentWithFirm[];
}

// Per-tenant access roles a firm staffer can be granted on a managed tenant.
// Mirrors user_tenant_access.role (and admin.ts adminCreateUserRoles).
export const TENANT_ACCESS_ROLES = ['owner', 'accountant', 'bookkeeper', 'readonly'] as const;
export type TenantAccessRole = typeof TENANT_ACCESS_ROLES[number];

// One row in the firm-staff "tenant access" matrix: a tenant the firm manages
// plus whether (and with what role) the staffer can operate on it. Firm
// membership does NOT grant tenant access on its own — this is the UX that
// writes the per-tenant `user_tenant_access` grants across the firm's clients.
export interface StaffTenantAccessRow {
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
  hasAccess: boolean;
  role: TenantAccessRole | null;
}

// ─── "Invite my accountant" (firm_invites) ───────────────────────
// A tenant owner invites a firm staffer by email; accepting assigns the
// tenant to the ACCEPTOR's firm and grants them accountant access.
export const FIRM_INVITE_STATUSES = ['sent', 'viewed', 'accepted', 'expired', 'revoked'] as const;
export type FirmInviteStatus = typeof FIRM_INVITE_STATUSES[number];

export const FIRM_INVITE_TTL_DAYS = 14;
export const FIRM_INVITE_CODE_LENGTH = 8;

// Row as shown on the owner's Settings → Team pending list. Never carries
// the token or code (only hashes are stored server-side anyway).
export interface FirmInvite {
  id: string;
  tenantId: string;
  recipientEmail: string;
  status: FirmInviteStatus;
  expiresAt: string;
  sentAt: string;
  resendCount: number;
  viewedAt: string | null;
  acceptedAt: string | null;
  acceptedFirmId: string | null;
  acceptedFirmName: string | null;
  createdByName: string | null;
}

// What the accepting staffer sees before confirming.
export interface FirmInvitePreview {
  tenantId: string;
  tenantName: string;
  inviterName: string | null;
  inviterEmail: string | null;
  expiresAt: string;
  status: FirmInviteStatus;
  // The firm currently managing the tenant (name only — no id leak).
  currentFirmName: string | null;
  // Firms the acceptor may accept INTO (their active firm_admin /
  // firm_staff memberships; every active firm for a super admin).
  firms: Array<{ id: string; name: string }>;
}

export interface AcceptFirmInviteResult {
  tenantId: string;
  tenantName: string;
  firmId: string;
  firmName: string;
  // True when the tenant was already assigned to this firm (idempotent).
  alreadyAssigned: boolean;
  // True when a new accountant access row was created for the acceptor.
  accessGranted: boolean;
}
