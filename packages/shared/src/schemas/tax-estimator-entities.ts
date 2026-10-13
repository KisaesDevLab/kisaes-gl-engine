// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Tax Estimator Phase 4 request schemas — entity tax setup (MODULE.md D3, D8).
import { z } from 'zod';
import { ENTITY_TAX_TYPES, TAX_METHODS } from '../tax-estimator/types.js';
import { ACCOUNT_TREATMENTS, allowsPersonTarget } from '../tax-estimator/entities-api.js';
import { PROJECTION_METHODS } from '../tax-estimator/projection-method.js';
import { SPLIT_MODES } from '../tax-estimator/treatment-splits.js';
import { taxEstimatorStateCodeSchema } from './tax-estimator-taxpayers.js';

const MIN_TAX_YEAR = 2000;
const MAX_TAX_YEAR = 2100;
const MAX_BATCH = 500;
const MAX_REASON_LEN = 2000;
const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 200;
const MONEY_RE = /^\d{1,15}(\.\d{1,4})?$/;
const PCT_RE = /^\d{1,3}(\.\d{1,4})?$/;
/** Split pct (Q50): NUMERIC(9,6). */
const SPLIT_PCT_RE = /^\d{1,3}(\.\d{1,6})?$/;
const MAX_SPLIT_ROWS = 50;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

const money = z.string().trim().regex(MONEY_RE, 'Amount must be a non-negative decimal with up to 4 places');

/** Path params: both are re-verified against the server-resolved firm scope on every request. */
export const taxEstEntityParamsSchema = z.object({
  tenantId: z.string().uuid(),
  companyId: z.string().uuid(),
});

export const taxEstEntityYearParamsSchema = taxEstEntityParamsSchema.extend({
  taxYear: z.coerce.number().int().min(MIN_TAX_YEAR).max(MAX_TAX_YEAR),
});

export const upsertEntitySettingsSchema = z.object({
  taxEntityType: z.enum(ENTITY_TAX_TYPES).nullable().optional(),
  taxMethod: z.enum(TAX_METHODS).nullable().optional(),
  isSstb: z.boolean().optional(),
  largeCorporation: z.boolean().optional(),
  farmerOverride: z.boolean().nullable().optional(),
  rentalQbiTradeOrBusiness: z.boolean().optional(),
  stateSourcing: taxEstimatorStateCodeSchema.nullable().optional(),
}).strict();
export type UpsertEntitySettingsInput = z.infer<typeof upsertEntitySettingsSchema>;

export const upsertEntityYearInputsSchema = z.object({
  w2WagesOverride: money.nullable().optional(),
  w2WagesOverrideReason: z.string().trim().max(MAX_REASON_LEN).nullable().optional(),
  ubia: money.nullable().optional(),
  /** Q41: include the >2% shareholder health W-2 add-on in §199A W-2 wages (default false). */
  includeSehiInW2Wages: z.boolean().optional(),
  /** Q46: projection of the ordinary character for this entity year (default run_rate). */
  projectionMethod: z.enum(PROJECTION_METHODS).optional(),
}).strict().refine(
  (v) => !v.w2WagesOverride || (v.w2WagesOverrideReason ?? '').trim().length > 0,
  { message: 'A reason is required when overriding W-2 wages', path: ['w2WagesOverrideReason'] },
);
export type UpsertEntityYearInputsInput = z.infer<typeof upsertEntityYearInputsSchema>;

/**
 * One owner-split row (Q50). Shape only here; the service checks the 100% total
 * (400 TE_SPLIT_PCT_TOTAL), duplicates and that every target is linked to the business
 * (422 TE_TARGET_NOT_LINKED).
 */
export const treatmentSplitInputSchema = z.object({
  taxpayerId: z.string().uuid().nullable().optional(),
  personId: z.string().uuid().nullable().optional(),
  pct: z.string().trim().regex(SPLIT_PCT_RE, 'pct must be 0-100 with up to 6 places').nullable().optional(),
  amount: money.nullable().optional(),
  taxYear: z.number().int().min(MIN_TAX_YEAR).max(MAX_TAX_YEAR).nullable().optional(),
}).strict();
export type TreatmentSplitInput = z.infer<typeof treatmentSplitInputSchema>;

export const accountTreatmentInputSchema = z.object({
  accountId: z.string().uuid(),
  /** null + nonRecurring false removes the row. */
  treatment: z.enum(ACCOUNT_TREATMENTS).nullable(),
  pct: z.string().trim().regex(PCT_RE).nullable().optional(),
  paymentTaxpayerId: z.string().uuid().nullable().optional(),
  paymentPersonId: z.string().uuid().nullable().optional(),
  paymentJurisdiction: z.union([z.literal('federal'), taxEstimatorStateCodeSchema]).nullable().optional(),
  nonRecurring: z.boolean().default(false),
  /** Q50: 'pct' (default) or 'amount'; meaningful with `splits`. */
  splitMode: z.enum(SPLIT_MODES).optional(),
  /**
   * Q50: owner split. Absent / null / [] = the single target (paymentPersonId / paymentTaxpayerId)
   * takes 100%. When given, the single-target fields must be omitted (the first row becomes them).
   */
  splits: z.array(treatmentSplitInputSchema).max(MAX_SPLIT_ROWS).nullable().optional(),
}).strict().superRefine((v, ctx) => {
  if (v.treatment === 'nondeductible_pct') {
    if (v.pct == null) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['pct'], message: 'pct is required for nondeductible_pct' });
    else if (Number(v.pct) > 100) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['pct'], message: 'pct must be 0-100' });
  } else if (v.pct != null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['pct'], message: 'pct applies to nondeductible_pct only' });
  }
  if (v.treatment !== 'estimated_tax_payment' && v.paymentJurisdiction != null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['paymentJurisdiction'], message: 'paymentJurisdiction applies to estimated_tax_payment only' });
  }
  // Person target: payments, guaranteed payments, owner SEHI / retirement, W-2 wages (officer).
  if (!allowsPersonTarget(v.treatment) && (v.paymentTaxpayerId != null || v.paymentPersonId != null)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['treatment'], message: 'a person target applies to payment, guaranteed-payment, owner and W-2 wage treatments only' });
  }
  const splits = v.splits ?? [];
  if (v.treatment === 'guaranteed_payment' && v.paymentPersonId == null && splits.length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['paymentPersonId'], message: 'a guaranteed payment needs the partner (paymentPersonId)' });
  }
  if (splits.length === 0) return;
  if (!allowsPersonTarget(v.treatment)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['splits'], message: 'splits apply to payment, guaranteed-payment, owner and W-2 wage treatments only' });
    return;
  }
  if (v.paymentTaxpayerId != null || v.paymentPersonId != null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['splits'], message: 'give either splits or paymentTaxpayerId / paymentPersonId, not both' });
  }
  const mode = v.splitMode ?? 'pct';
  const isPayment = v.treatment === 'estimated_tax_payment';
  splits.forEach((r, i) => {
    if (isPayment ? r.taxpayerId == null : r.personId == null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['splits', i, isPayment ? 'taxpayerId' : 'personId'], message: isPayment ? 'each payment split row needs a taxpayer' : 'each split row needs a person' });
    }
    if (mode === 'pct' && (r.pct == null || r.amount != null || r.taxYear != null)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['splits', i, 'pct'], message: 'a % split row has a pct and no amount / taxYear' });
    }
    if (mode === 'amount' && (r.amount == null || r.taxYear == null || r.pct != null)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['splits', i, 'amount'], message: 'a $ split row has an amount and a taxYear and no pct' });
    }
  });
});
export type AccountTreatmentInput = z.infer<typeof accountTreatmentInputSchema>;

export const putAccountTreatmentsSchema = z.object({
  treatments: z.array(accountTreatmentInputSchema).min(1).max(MAX_BATCH),
}).strict();

export const putTransactionFlagsSchema = z.object({
  flags: z.array(z.object({
    transactionId: z.string().uuid(),
    /** false removes the flag. */
    nonRecurring: z.boolean(),
  }).strict()).min(1).max(MAX_BATCH),
}).strict();
export type PutTransactionFlagsInput = z.infer<typeof putTransactionFlagsSchema>;

/**
 * Register / transaction-detail surface (R7-07 #2): one transaction in the caller's
 * ACTIVE tenant and company. The tenant is never a parameter — the server uses the
 * session's active tenant (D1 scope re-checked).
 */
export const taxEstRegisterTxnParamsSchema = z.object({
  transactionId: z.string().uuid(),
});
export const putRegisterTransactionFlagSchema = z.object({
  /** false removes the flag. */
  nonRecurring: z.boolean(),
}).strict();
export type PutRegisterTransactionFlagInput = z.infer<typeof putRegisterTransactionFlagSchema>;

export const taxEstListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  offset: z.coerce.number().int().min(0).default(0),
});

export const taxEstReadinessQuerySchema = z.object({
  through: z.string().regex(MONTH_RE).optional(),
  taxYear: z.coerce.number().int().min(MIN_TAX_YEAR).max(MAX_TAX_YEAR).optional(),
});

/** GET .../owner-candidates (Q50): the year the profit % defaults come from (default = latest linked year). */
export const taxEstOwnerCandidatesQuerySchema = z.object({
  taxYear: z.coerce.number().int().min(MIN_TAX_YEAR).max(MAX_TAX_YEAR).optional(),
});

export const taxEstTaxBasisPlQuerySchema = z.object({
  taxYear: z.coerce.number().int().min(MIN_TAX_YEAR).max(MAX_TAX_YEAR),
  through: z.string().regex(MONTH_RE).optional(),
});
