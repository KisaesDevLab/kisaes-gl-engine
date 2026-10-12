// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Tax Estimator taxpayers API DTOs (MODULE.md D1).
import type { FilingStatus, ActivityType } from './types.js';

export type SafeHarborOverride = 'prior_year' | 'lesser_of' | 'current_year';
export type PortalShows = 'live' | 'snapshot';
export type PersonRole = 'primary' | 'spouse';
export type PartnerSeStatus = 'general' | 'limited' | 'llc_member_manager';
/** Entity type as far as the link validations are concerned. */
export type LinkEntityKind = 'partnership' | 's_corp' | 'c_corp' | 'sole';

export interface TaxpayerDTO {
  id: string;
  displayName: string;
  filingStatus: FilingStatus;
  residentState: string | null;
  safeHarborOverride: SafeHarborOverride | null;
  portalShows: PortalShows | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PersonDTO {
  id: string;
  taxpayerId: string;
  role: PersonRole;
  firstName: string;
  lastName: string;
  dateOfBirth: string | null;
  isBlind: boolean;
  sehiEligibleMonths: boolean[];
}

export interface TaxpayerListItemDTO extends TaxpayerDTO {
  personNames: string[];
  linkCount: number;
  /** D17: a staff allow-list is set (the list shows a lock). */
  staffRestricted: boolean;
}

export interface TaxpayerListDTO {
  data: TaxpayerListItemDTO[];
  total: number;
  limit: number;
  offset: number;
}

export interface TaxpayerDetailDTO {
  taxpayer: TaxpayerDTO;
  persons: PersonDTO[];
  /** D17: a staff allow-list is set. */
  staffRestricted: boolean;
}

// ── D17 taxpayer visibility: per-taxpayer staff allow-list ─────────────

export interface TaxpayerStaffMemberDTO {
  userId: string;
  /** Empty when the user record no longer exists. */
  email: string;
  displayName: string | null;
  /** The member's current firm role; null = no longer an active member of the firm. */
  firmRole: 'firm_admin' | 'firm_staff' | 'firm_readonly' | null;
  addedAt: string;
}

export interface TaxpayerStaffDTO {
  taxpayerId: string;
  /** Empty = everyone the linked-tenant rule allows; non-empty = only these users plus firm admins. */
  members: TaxpayerStaffMemberDTO[];
  total: number;
  /** The firm switch (restrict_taxpayers_to_linked_tenants) at read time. */
  restrictToLinkedTenants: boolean;
  /** The caller is a firm admin / super admin and may change the list. */
  canEdit: boolean;
}

export interface TaxpayerStaffCandidateDTO {
  userId: string;
  email: string;
  displayName: string | null;
  firmRole: 'firm_staff' | 'firm_readonly';
}

export interface TaxpayerStaffCandidateListDTO {
  data: TaxpayerStaffCandidateDTO[];
  total: number;
}

export interface LinkDTO {
  id: string;
  taxpayerId: string;
  personId: string;
  personRole: PersonRole;
  taxYear: number;
  tenantId: string;
  companyId: string;
  /** null when the tenant is no longer in the caller's scope (names are not disclosed). */
  tenantName: string | null;
  companyName: string | null;
  entityKind: LinkEntityKind | null;
  returnForm: string | null;
  /** True when the link's tenant is outside the caller's current scope. Stored, but excluded from computation and options. */
  outOfScope: boolean;
  profitPct: number | null;
  lossPct: number | null;
  capitalPct: number | null;
  partnerSeStatus: PartnerSeStatus | null;
  partnerSeMemo: string | null;
  isOfficer: boolean;
  activityType: ActivityType;
  activeParticipation: boolean;
  qbiEligible: boolean | null;
  qbiOverrideReason: string | null;
  allowedLossOverride: string | null;
  allowedLossReason: string | null;
}

export interface LinkWarningDTO {
  code: 'PROFIT_PCT_UNDER_100' | 'LOSS_PCT_UNDER_100';
  taxYear: number;
  tenantId: string;
  companyId: string;
  total: number;
  message: string;
}

export interface LinkUpsertResultDTO {
  link: LinkDTO;
  warnings: LinkWarningDTO[];
}

export interface LinkListDTO {
  data: LinkDTO[];
  total: number;
  warnings: LinkWarningDTO[];
}

export interface CompanyOptionDTO {
  tenantId: string;
  tenantName: string;
  companyId: string;
  companyName: string;
  entityType: string;
  returnForm: string | null;
}

export interface CompanyOptionListDTO {
  data: CompanyOptionDTO[];
  total: number;
  limit: number;
  offset: number;
}

export interface TaxpayerContactDTO {
  portalContactId: string;
  tenantId: string;
  /** Blank for contacts in a tenant outside the caller's scope. */
  email: string;
  firstName: string | null;
  lastName: string | null;
  outOfScope: boolean;
  taxEstimatesAccess: boolean;
  createdAt: string;
}

/**
 * QA D11: a portal contact the taxpayer could be linked to — an active contact of one of
 * the taxpayer's linked companies, in a tenant inside the caller's D1 scope (whatever the
 * caller's active tenant is).
 */
export interface TaxpayerContactCandidateDTO {
  portalContactId: string;
  tenantId: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  /** The linked companies this contact has portal access to. */
  companyNames: string[];
}

export interface TaxpayerContactCandidateListDTO {
  data: TaxpayerContactCandidateDTO[];
  total: number;
}

export interface TaxpayerContactListDTO {
  data: TaxpayerContactDTO[];
  total: number;
}

/** Error codes the taxpayers API can return. */
export const TAXPAYER_ERROR_CODES = [
  'TE_TENANT_NOT_MANAGED', 'TE_LINK_PCT_OVER_100', 'TE_LIMITED_ONLY_PARTNERSHIP', 'TE_OFFICER_ONLY_SCORP',
  'TE_TAXPAYER_NOT_FOUND', 'TE_PERSON_LIMIT',
] as const;

export interface LinkContactResultDTO {
  contact: TaxpayerContactDTO;
  /** Number of portal_contact_companies rows whose tax_estimates_access was switched on. */
  grantedCompanies: number;
}

export interface UnlinkContactResultDTO {
  revokedCompanies: number;
}
