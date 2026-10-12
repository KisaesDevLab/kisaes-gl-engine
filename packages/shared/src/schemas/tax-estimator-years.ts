// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Tax Estimator Phase 5 request schemas — annual settings, scenarios, adjustments,
// state rows, firm settings. None accepts a firm id or an allowed-tenant list; an
// adjustment's tenantId/companyId/accountId name the GL TARGET and are validated
// server-side against the firm scope (404 TE_TENANT_NOT_MANAGED).
import { z } from 'zod';
import { SAFE_HARBOR_OVERRIDES, PORTAL_SHOWS, taxEstimatorStateCodeSchema } from './tax-estimator-taxpayers.js';

const MIN_TAX_YEAR = 2000;
const MAX_TAX_YEAR = 2100;
const MAX_NAME = 120;
const MAX_MEMO = 2000;
const MAX_DISCLAIMER = 4000;
const MAX_STATE_ROWS = 12;
const MAX_STATE_RATE = 0.2;

export const RATE_MODES = ['brackets', 'effective'] as const;
export const DEDUCTION_MODES = ['auto', 'standard', 'itemized'] as const;
export const HSA_COVERAGES = ['self', 'family', 'none'] as const;
export const ADJUSTMENT_CADENCES = ['monthly', 'quarterly', 'annual', 'one_time'] as const;
export const ADJUSTMENT_KINDS = ['income', 'deduction', 'addback'] as const;
export const STATE_RESIDENCIES = ['resident', 'nonresident'] as const;
export const STATE_BASES = ['federal_agi', 'federal_taxable', 'custom'] as const;
export const ITEMIZED_KEYS = ['saltPaid', 'mortgageInterest', 'charitableCash', 'charitableNoncash', 'other'] as const;
export const SCH1A_KEYS = ['qualifiedTips', 'qualifiedOvertime', 'carLoanInterest'] as const;
export const MAX_SCENARIOS_PER_YEAR = 6;
export const DEFAULT_DISCLAIMER_TEXT = 'Projection based on bookkeeping records and the assumptions listed. Not a tax return.';

const uuid = z.string().uuid();
const taxYear = z.coerce.number().int().min(MIN_TAX_YEAR).max(MAX_TAX_YEAR);
const stateCode = taxEstimatorStateCodeSchema;
const money = z.union([z.number(), z.string().trim().regex(/^-?\d+(\.\d{1,4})?$/)]).transform((v) => String(v));
const nonNegMoney = money.refine((v) => Number(v) >= 0, 'Must not be negative');
const CENTS = 100;
const CENT_EPSILON = 1e-6;
/**
 * Money carried as a JSON number in jsonb inputs (itemized, Schedule 1-A, withholding,
 * person inputs, farmer gross). R3-13: whole cents only, so the number round-trips through
 * jsonb and the string-decimal bridge exactly (|v| <= 1e12 keeps v × 100 inside 2^53).
 */
const nonNegNumber = z.number().min(0).max(1e12)
  .refine((v) => Math.abs(v * CENTS - Math.round(v * CENTS)) < CENT_EPSILON, 'At most 2 decimal places (whole cents)');
const month = z.number().int().min(1).max(12);

export const yearParamsSchema = z.object({ id: uuid, taxYear });
export const scenarioIdParamsSchema = z.object({ scenarioId: uuid });
export const adjustmentIdParamsSchema = z.object({ adjustmentId: uuid });
export const adjustmentTypeIdParamsSchema = z.object({ typeId: uuid });

export const itemizedSchema = z.object({
  saltPaid: nonNegNumber.optional(), mortgageInterest: nonNegNumber.optional(),
  charitableCash: nonNegNumber.optional(), charitableNoncash: nonNegNumber.optional(), other: nonNegNumber.optional(),
}).strict();

const sch1aPersonSchema = z.object({
  qualifiedTips: nonNegNumber.optional(), qualifiedOvertime: nonNegNumber.optional(), carLoanInterest: nonNegNumber.optional(),
}).strict();
export const sch1aSchema = z.object({ primary: sch1aPersonSchema.optional(), spouse: sch1aPersonSchema.optional() }).strict();
export const hsaCoverageSchema = z.object({
  primary: z.enum(HSA_COVERAGES).optional(), spouse: z.enum(HSA_COVERAGES).optional(),
}).strict();
export const RETIREMENT_PLAN_TYPES = ['sep', 'solo_401k', 'simple', 'none'] as const;

/** Phase 10b (Q28): per-person year inputs keyed by role. Money as plain numbers like the other jsonb inputs. */
const personYearInputSchema = z.object({
  retirementPlanType: z.enum(RETIREMENT_PLAN_TYPES).nullable().optional(),
  /** Elective-deferral portion of the owner retirement contributions (solo 401(k) / SIMPLE). */
  employeeDeferral: nonNegNumber.nullable().optional(),
  /** W-2 box 1 wages from jobs OUTSIDE the linked entities. */
  w2Wages: nonNegNumber.nullable().optional(),
  /** Social Security wages of those jobs; blank = same as box 1. */
  w2SocialSecurityWages: nonNegNumber.nullable().optional(),
}).strict();
export const personInputsSchema = z.object({ primary: personYearInputSchema.optional(), spouse: personYearInputSchema.optional() }).strict();

/** Phase 10b (Q34): farmer / fisherman gross-income test figures; a year present here wins over the books. */
const farmerGrossPersonSchema = z.object({
  farming: nonNegNumber.optional(), fishing: nonNegNumber.optional(), totalGross: nonNegNumber.optional(),
}).strict();
const farmerGrossYearSchema = z.object({ primary: farmerGrossPersonSchema.optional(), spouse: farmerGrossPersonSchema.optional() }).strict();
export const farmerGrossSchema = z.object({ current: farmerGrossYearSchema.optional(), prior: farmerGrossYearSchema.optional() }).strict();

export const withholdingSchema = z.object({
  federal: nonNegNumber.optional(),
  states: z.record(stateCode, nonNegNumber).optional(),
}).strict();

/** PUT body for a year. priorYear* are write-only strings: null clears, omitted keeps. */
export const upsertYearSchema = z.object({
  priorYearTax: nonNegMoney.nullable().optional(),
  priorYearAgi: money.nullable().optional(),
  priorYearTwelveMonths: z.boolean().optional(),
  priorYearFiled: z.boolean().optional(),
  safeHarborRule: z.enum(SAFE_HARBOR_OVERRIDES).nullable().optional(),
  rateMode: z.enum(RATE_MODES).optional(),
  effectiveRateOverride: z.number().min(0).max(1).nullable().optional(),
  deductionMode: z.enum(DEDUCTION_MODES).optional(),
  itemized: itemizedSchema.optional(),
  sch1a: sch1aSchema.optional(),
  creditsNonrefundable: nonNegMoney.optional(),
  creditsRefundable: nonNegMoney.optional(),
  hsaCoverage: hsaCoverageSchema.optional(),
  withholding: withholdingSchema.optional(),
  personInputs: personInputsSchema.optional(),
  mfsLivedApartAllYear: z.boolean().optional(),
  niiAllocableDeductions: nonNegMoney.nullable().optional(),
  farmerGross: farmerGrossSchema.optional(),
  isFisherman: z.boolean().optional(),
}).superRefine((v, ctx) => {
  if (v.rateMode === 'effective' && v.effectiveRateOverride === null) {
    ctx.addIssue({ code: 'custom', path: ['effectiveRateOverride'], message: 'Effective-rate mode needs a rate' });
  }
});
export type UpsertYearInput = z.infer<typeof upsertYearSchema>;

export const scenarioNameSchema = z.string().trim().min(1).max(MAX_NAME);
export const createScenarioSchema = z.object({ name: scenarioNameSchema });
export type CreateScenarioInput = z.infer<typeof createScenarioSchema>;
export const updateScenarioSchema = z.object({ name: scenarioNameSchema });
/** QA D21: POST .../clone — optional name for the copy. */
export const cloneScenarioSchema = z.object({ name: scenarioNameSchema.optional() });
export type UpdateScenarioInput = z.infer<typeof updateScenarioSchema>;

const adjustmentBase = z.object({
  adjustmentTypeId: uuid,
  personId: uuid.nullable().optional(),
  linkId: uuid.nullable().optional(),
  label: z.string().trim().max(200).default(''),
  /** null only for a GL-linked adjustment (remaining months follow the actuals run-rate). */
  amount: money.nullable(),
  pct: z.number().min(0).max(100).nullable().optional(),
  cadence: z.enum(ADJUSTMENT_CADENCES),
  startMonth: month.default(1),
  endMonth: month.default(12),
  glLinked: z.boolean().default(false),
  tenantId: uuid.nullable().optional(),
  companyId: uuid.nullable().optional(),
  accountId: uuid.nullable().optional(),
  nonRecurring: z.boolean().default(false),
  memo: z.string().trim().max(MAX_MEMO).nullable().optional(),
});

function checkAdjustment(v: Partial<z.infer<typeof adjustmentBase>>, ctx: z.RefinementCtx) {
  if (v.startMonth != null && v.endMonth != null && v.startMonth > v.endMonth) {
    ctx.addIssue({ code: 'custom', path: ['endMonth'], message: 'End month must not be before start month' });
  }
  if (v.glLinked === true && (!v.tenantId || !v.companyId || !v.accountId)) {
    ctx.addIssue({ code: 'custom', path: ['accountId'], message: 'A GL-linked adjustment needs tenant, company and account' });
  }
  if (v.glLinked === false && (v.tenantId || v.companyId || v.accountId)) {
    ctx.addIssue({ code: 'custom', path: ['glLinked'], message: 'GL fields require glLinked' });
  }
  if (v.amount === null && v.glLinked !== true) {
    ctx.addIssue({ code: 'custom', path: ['amount'], message: 'Amount is required unless the adjustment is GL-linked' });
  }
}
export const createAdjustmentSchema = adjustmentBase.superRefine(checkAdjustment);
export type CreateAdjustmentInput = z.infer<typeof createAdjustmentSchema>;
/** PATCH: any subset; the service re-validates the merged row. */
export const updateAdjustmentSchema = adjustmentBase.partial().superRefine(checkAdjustment);
export type UpdateAdjustmentInput = z.infer<typeof updateAdjustmentSchema>;

const adjustmentTypeBase = z.object({
  name: z.string().trim().min(1).max(MAX_NAME),
  kind: z.enum(ADJUSTMENT_KINDS),
  affectsSe: z.boolean().default(false),
  affectsQbi: z.boolean().default(false),
  isCapitalGainLt: z.boolean().default(false),
  isCapitalGainSt: z.boolean().default(false),
  isQualifiedDividend: z.boolean().default(false),
  isReitDividend: z.boolean().default(false),
  isPtp: z.boolean().default(false),
  is1231: z.boolean().default(false),
  isAboveTheLine: z.boolean().default(false),
  nonRecurring: z.boolean().default(false),
  defaultPct: z.number().min(0).max(100).nullable().optional(),
  isActive: z.boolean().default(true),
});
export const createAdjustmentTypeSchema = adjustmentTypeBase;
export type CreateAdjustmentTypeInput = z.infer<typeof createAdjustmentTypeSchema>;
export const updateAdjustmentTypeSchema = adjustmentTypeBase.partial();
export type UpdateAdjustmentTypeInput = z.infer<typeof updateAdjustmentTypeSchema>;
export const listAdjustmentTypesQuerySchema = z.object({
  includeInactive: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
});

export const stateRowSchema = z.object({
  residency: z.enum(STATE_RESIDENCIES),
  state: stateCode,
  effectiveRate: z.number().min(0).max(MAX_STATE_RATE),
  base: z.enum(STATE_BASES).default('federal_agi'),
  customBase: money.nullable().optional(),
  /** null + sourcedManual=false means "derive from entity state x share" (engine phase). */
  sourcedIncome: money.nullable().optional(),
  sourcedManual: z.boolean().default(false),
  creditOverride: money.nullable().optional(),
  memo: z.string().trim().max(MAX_MEMO).nullable().optional(),
  // Phase 10b gate inputs (D12b). On PUT: omitted = keep the value saved for this state,
  // null = clear. withholding null falls back to the year's withholding.states[state].
  withholding: nonNegMoney.nullable().optional(),
  otherCredits: nonNegMoney.nullable().optional(),
  grossIncome: money.nullable().optional(),
  priorYearGrossIncome: money.nullable().optional(),
  nonWithheldIncome: money.nullable().optional(),
  exemptions: nonNegMoney.nullable().optional(),
  stateDeductions: nonNegMoney.nullable().optional(),
  /** Prior-year STATE tax / AGI (D9): write-only, encrypted at rest; omitted = keep, null = clear. */
  priorYearTax: nonNegMoney.nullable().optional(),
  priorYearAgi: money.nullable().optional(),
}).superRefine((v, ctx) => {
  if (v.base === 'custom' && v.customBase == null) {
    ctx.addIssue({ code: 'custom', path: ['customBase'], message: 'A custom base needs an amount' });
  }
  if (v.sourcedManual && v.sourcedIncome == null) {
    ctx.addIssue({ code: 'custom', path: ['sourcedIncome'], message: 'Manual sourced income needs an amount' });
  }
});
export type StateRowInput = z.infer<typeof stateRowSchema>;
export const replaceStateRowsSchema = z.object({ rows: z.array(stateRowSchema).max(MAX_STATE_ROWS) });
export type ReplaceStateRowsInput = z.infer<typeof replaceStateRowsSchema>;

export const upsertFirmSettingsSchema = z.object({
  safeHarborDefault: z.enum(SAFE_HARBOR_OVERRIDES).optional(),
  /** null / empty = the shipped default text. */
  disclaimerText: z.string().trim().max(MAX_DISCLAIMER).nullable().optional()
    .transform((v) => (v === '' ? null : v)),
  portalShows: z.enum(PORTAL_SHOWS).optional(),
  /** D17: a non-admin sees a taxpayer only through a linked tenant they can reach. Default ON. */
  restrictTaxpayersToLinkedTenants: z.boolean().optional(),
});
export type UpsertFirmSettingsInput = z.infer<typeof upsertFirmSettingsSchema>;

