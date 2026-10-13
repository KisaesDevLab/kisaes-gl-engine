// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Tax Estimator taxpayers / persons / links request schemas (MODULE.md D1).
// None of these accept a firm id, an allowed-tenant list or a role: the firm
// scope is resolved server-side. `tenantId` on a link names the TARGET tenant
// and is validated against the server-resolved allowed set.
import { z } from 'zod';
import { FILING_STATUSES, ACTIVITY_TYPES } from '../tax-estimator/types.js';
import { STATE_CODES } from '../tax-estimator/stateRuleKeys.js';

const MIN_TAX_YEAR = 2000;
const MAX_TAX_YEAR = 2100;
const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 50;
const MAX_NAME = 255;
const MAX_PERSON_NAME = 120;
const MAX_MEMO = 2000;
const MIN_REASON_LEN = 3;
const MONTHS = 12;
const PCT_MAX = 100;

export const SAFE_HARBOR_OVERRIDES = ['prior_year', 'lesser_of', 'current_year'] as const;
export const PORTAL_SHOWS = ['live', 'snapshot'] as const;
export const PERSON_ROLES = ['primary', 'spouse'] as const;
export const PARTNER_SE_STATUSES = ['general', 'limited', 'llc_member_manager'] as const;
export const TAXPAYER_LIST_SORT_KEYS = ['displayName', 'filingStatus', 'residentState', 'createdAt'] as const;
export const TAXPAYER_STATUS_FILTERS = ['active', 'archived', 'all'] as const;

const uuid = z.string().uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
export const TE_STATE_CODE_MESSAGE = 'Use a two-letter state code (one of the 50 states or DC)';
/**
 * QA D3/D4: a state code must be one of the 51 jurisdictions the module has
 * rules for. Any other two letters ("ZZ") are rejected (400), never stored.
 */
export const taxEstimatorStateCodeSchema = z.string().trim().toUpperCase()
  .refine((s) => (STATE_CODES as readonly string[]).includes(s), { message: TE_STATE_CODE_MESSAGE });
const stateCode = taxEstimatorStateCodeSchema;
const pct = z.coerce.number().min(0).max(PCT_MAX);
const optionalReason = z.string().trim().max(MAX_MEMO);

export const taxpayerIdParamsSchema = z.object({ id: uuid });
export const personRoleParamsSchema = z.object({ id: uuid, role: z.enum(PERSON_ROLES) });
export const linkIdParamsSchema = z.object({ id: uuid, linkId: uuid });
export const contactIdParamsSchema = z.object({ id: uuid, contactId: uuid });
export const dependentIdParamsSchema = z.object({ id: uuid, dependentId: uuid });

/**
 * D17 (2026-10-12): replace a taxpayer's staff allow-list. Firm admins / super admins only
 * (403 TE_FIRM_ADMIN_REQUIRED otherwise). Empty = every staff member the linked-tenant
 * rule allows; non-empty = only these users (plus firm admins). Ids are validated
 * server-side against the firm's eligible members (422 TE_STAFF_NOT_ELIGIBLE).
 */
export const MAX_TAXPAYER_STAFF = 200;
export const replaceTaxpayerStaffSchema = z.object({
  userIds: z.array(uuid).max(MAX_TAXPAYER_STAFF)
    .refine((ids) => new Set(ids).size === ids.length, { message: 'Each user may appear once' }),
});
export type ReplaceTaxpayerStaffInput = z.infer<typeof replaceTaxpayerStaffSchema>;

export const createTaxpayerSchema = z.object({
  displayName: z.string().trim().min(1).max(MAX_NAME),
  filingStatus: z.enum(FILING_STATUSES).default('single'),
  residentState: stateCode.nullable().optional(),
  safeHarborOverride: z.enum(SAFE_HARBOR_OVERRIDES).nullable().optional(),
  portalShows: z.enum(PORTAL_SHOWS).nullable().optional(),
});
export type CreateTaxpayerInput = z.infer<typeof createTaxpayerSchema>;

export const updateTaxpayerSchema = z.object({
  displayName: z.string().trim().min(1).max(MAX_NAME).optional(),
  filingStatus: z.enum(FILING_STATUSES).optional(),
  residentState: stateCode.nullable().optional(),
  safeHarborOverride: z.enum(SAFE_HARBOR_OVERRIDES).nullable().optional(),
  portalShows: z.enum(PORTAL_SHOWS).nullable().optional(),
});
export type UpdateTaxpayerInput = z.infer<typeof updateTaxpayerSchema>;

export const listTaxpayersQuerySchema = z.object({
  q: z.string().trim().max(MAX_NAME).optional(),
  status: z.enum(TAXPAYER_STATUS_FILTERS).default('active'),
  /** Comma separated filing statuses. */
  filingStatus: z.string().optional().transform((s) => (s ? s.split(',').filter(Boolean) : undefined))
    .pipe(z.array(z.enum(FILING_STATUSES)).optional()),
  /** QA D29: comma separated resident-state codes. */
  residentState: z.string().optional().transform((s) => (s ? s.split(',').map((x) => x.trim().toUpperCase()).filter(Boolean) : undefined))
    .pipe(z.array(taxEstimatorStateCodeSchema).optional()),
  sortBy: z.enum(TAXPAYER_LIST_SORT_KEYS).default('displayName'),
  sortDir: z.enum(['asc', 'desc']).default('asc'),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ListTaxpayersQuery = z.infer<typeof listTaxpayersQuerySchema>;

/** Twelve booleans Jan..Dec; true = the month is SEHI-eligible (no employer plan available). */
export const sehiMonthsSchema = z.array(z.boolean()).length(MONTHS);

export const upsertPersonSchema = z.object({
  firstName: z.string().trim().min(1).max(MAX_PERSON_NAME),
  lastName: z.string().trim().min(1).max(MAX_PERSON_NAME),
  dateOfBirth: isoDate.nullable().optional(),
  isBlind: z.boolean().default(false),
  sehiEligibleMonths: sehiMonthsSchema.optional(),
});
export type UpsertPersonInput = z.infer<typeof upsertPersonSchema>;

// ── Dependents (OPEN-QUESTIONS Q44) ────────────────────────────────────
// No SSN is ever stored. The kind is the user's call (the engine re-checks the
// qualifying-child age test and warns); relationship is informational.
export const DEPENDENT_KINDS = ['qualifying_child', 'qualifying_relative'] as const;
export const DEPENDENT_RELATIONSHIPS = [
  'son', 'daughter', 'stepchild', 'foster_child', 'grandchild', 'sibling', 'niece_nephew', 'parent', 'grandparent', 'other_relative', 'other',
] as const;
export const MAX_DEPENDENTS = 20;
const MAX_DEPENDENT_NAME = 120;
const MAX_DEPENDENT_MONTHS = 12;

export const upsertDependentSchema = z.object({
  displayName: z.string().trim().min(1).max(MAX_DEPENDENT_NAME),
  dateOfBirth: isoDate,
  relationship: z.enum(DEPENDENT_RELATIONSHIPS).default('other'),
  kind: z.enum(DEPENDENT_KINDS),
  monthsLivedWith: z.number().int().min(0).max(MAX_DEPENDENT_MONTHS).nullable().optional(),
  isStudent: z.boolean().default(false),
  isDisabled: z.boolean().default(false),
  firstTaxYear: z.number().int().min(MIN_TAX_YEAR).max(MAX_TAX_YEAR).nullable().optional(),
  lastTaxYear: z.number().int().min(MIN_TAX_YEAR).max(MAX_TAX_YEAR).nullable().optional(),
}).superRefine((v, ctx) => {
  if (v.firstTaxYear != null && v.lastTaxYear != null && v.lastTaxYear < v.firstTaxYear) {
    ctx.addIssue({ code: 'custom', path: ['lastTaxYear'], message: 'Last tax year must not be before the first tax year' });
  }
});
export type UpsertDependentInput = z.infer<typeof upsertDependentSchema>;

export const linksQuerySchema = z.object({ taxYear: z.coerce.number().int().min(MIN_TAX_YEAR).max(MAX_TAX_YEAR) });

const moneyInput = z.union([z.number(), z.string().trim().regex(/^-?\d+(\.\d{1,4})?$/)])
  .transform((v) => String(v));

export const upsertLinkSchema = z.object({
  personRole: z.enum(PERSON_ROLES),
  taxYear: z.number().int().min(MIN_TAX_YEAR).max(MAX_TAX_YEAR),
  tenantId: uuid,
  companyId: uuid,
  profitPct: pct.nullable().optional(),
  lossPct: pct.nullable().optional(),
  capitalPct: pct.nullable().optional(),
  partnerSeStatus: z.enum(PARTNER_SE_STATUSES).nullable().optional(),
  partnerSeMemo: optionalReason.nullable().optional(),
  isOfficer: z.boolean().default(false),
  activityType: z.enum(ACTIVITY_TYPES).default('active'),
  activeParticipation: z.boolean().default(false),
  /** null/omitted = use the derived default (rental follows the entity setting). */
  qbiEligible: z.boolean().nullable().optional(),
  qbiOverrideReason: optionalReason.nullable().optional(),
  allowedLossOverride: moneyInput.nullable().optional(),
  allowedLossReason: optionalReason.nullable().optional(),
});
export type UpsertLinkInput = z.infer<typeof upsertLinkSchema>;
export const MIN_OVERRIDE_REASON_LEN = MIN_REASON_LEN;

export const companyOptionsQuerySchema = z.object({
  q: z.string().trim().max(MAX_NAME).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  offset: z.coerce.number().int().min(0).default(0),
});
export type CompanyOptionsQuery = z.infer<typeof companyOptionsQuerySchema>;

export const linkContactSchema = z.object({
  portalContactId: uuid,
  /** When true, flips portal_contact_companies.tax_estimates_access for the taxpayer's linked companies in the contact's tenant. */
  grantAccess: z.boolean().default(false),
});
export type LinkContactInput = z.infer<typeof linkContactSchema>;

export const unlinkContactQuerySchema = z.object({
  revokeAccess: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
});
