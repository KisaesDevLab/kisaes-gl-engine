// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Tax Estimator Phase 4 request schemas — entity tax setup (MODULE.md D3, D8).
import { z } from 'zod';
import { ENTITY_TAX_TYPES, TAX_METHODS } from '../tax-estimator/types.js';
import { ACCOUNT_TREATMENTS, allowsPersonTarget } from '../tax-estimator/entities-api.js';

const MIN_TAX_YEAR = 2000;
const MAX_TAX_YEAR = 2100;
const MAX_BATCH = 500;
const MAX_REASON_LEN = 2000;
const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 200;
const MONEY_RE = /^\d{1,15}(\.\d{1,4})?$/;
const PCT_RE = /^\d{1,3}(\.\d{1,4})?$/;
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
  stateSourcing: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/).nullable().optional(),
}).strict();
export type UpsertEntitySettingsInput = z.infer<typeof upsertEntitySettingsSchema>;

export const upsertEntityYearInputsSchema = z.object({
  w2WagesOverride: money.nullable().optional(),
  w2WagesOverrideReason: z.string().trim().max(MAX_REASON_LEN).nullable().optional(),
  ubia: money.nullable().optional(),
}).strict().refine(
  (v) => !v.w2WagesOverride || (v.w2WagesOverrideReason ?? '').trim().length > 0,
  { message: 'A reason is required when overriding W-2 wages', path: ['w2WagesOverrideReason'] },
);
export type UpsertEntityYearInputsInput = z.infer<typeof upsertEntityYearInputsSchema>;

export const accountTreatmentInputSchema = z.object({
  accountId: z.string().uuid(),
  /** null + nonRecurring false removes the row. */
  treatment: z.enum(ACCOUNT_TREATMENTS).nullable(),
  pct: z.string().trim().regex(PCT_RE).nullable().optional(),
  paymentTaxpayerId: z.string().uuid().nullable().optional(),
  paymentPersonId: z.string().uuid().nullable().optional(),
  paymentJurisdiction: z.string().trim().regex(/^(federal|[A-Z]{2})$/).nullable().optional(),
  nonRecurring: z.boolean().default(false),
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
  if (v.treatment === 'guaranteed_payment' && v.paymentPersonId == null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['paymentPersonId'], message: 'a guaranteed payment needs the partner (paymentPersonId)' });
  }
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

export const taxEstListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  offset: z.coerce.number().int().min(0).default(0),
});

export const taxEstReadinessQuerySchema = z.object({
  through: z.string().regex(MONTH_RE).optional(),
  taxYear: z.coerce.number().int().min(MIN_TAX_YEAR).max(MAX_TAX_YEAR).optional(),
});

export const taxEstTaxBasisPlQuerySchema = z.object({
  taxYear: z.coerce.number().int().min(MIN_TAX_YEAR).max(MAX_TAX_YEAR),
  through: z.string().regex(MONTH_RE).optional(),
});
