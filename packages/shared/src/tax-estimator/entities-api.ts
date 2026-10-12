// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Tax Estimator Phase 4 — entity tax setup DTOs (MODULE.md D3, D8) and the
// tax-basis P&L contract the pure engine (Phase 6) consumes.
//
// MONEY: every amount is a decimal STRING with 4 places (no floats cross this
// boundary). SIGN CONVENTION: amounts in `byCharacter`, `recurring`,
// `nonRecurring`, `taxBasisProfit`, `bookNetIncome` and account `bookAmount` /
// `taxAmount` are PROFIT-POSITIVE (income +, expense −). Owner-level amounts
// (`ownerSehi`, `ownerRetirement`, `ownerPersonalDropped`, `sehiAsW2Wages`),
// guaranteed payments, W-2 wages, payments, add-backs and farming gross income
// are POSITIVE magnitudes.

import type { EntityTaxType, TaxMethod, TraceRow } from './types.js';

export const INCOME_CHARACTERS = [
  'ordinary', 'capital_gain_st', 'capital_gain_lt', 'section_1231',
  'interest', 'dividends_ordinary', 'dividends_qualified', 'rental',
] as const;
export type IncomeCharacter = typeof INCOME_CHARACTERS[number];

export type CharacterAmounts = Record<IncomeCharacter, string>;

/**
 * Character treatments (R1 F6): the 2025 TB seed has no code for these on most
 * forms (e.g. no Sch C interest, no qualified-dividend or §1231 code), so a CPA
 * sets the character explicitly on an income / other-income account. The
 * treatment wins over the TB code's character.
 */
export const CHARACTER_TREATMENTS = [
  'capital_gain_lt', 'capital_gain_st', 'section_1231', 'interest', 'dividends_ordinary', 'dividends_qualified',
] as const;
export type CharacterTreatment = typeof CHARACTER_TREATMENTS[number];

export const ACCOUNT_TREATMENTS = [
  'nondeductible_pct', 'owner_sehi', 'owner_retirement', 'owner_personal',
  'estimated_tax_payment', 'tax_depreciation_differs', 'w2_wages', 'guaranteed_payment',
  ...CHARACTER_TREATMENTS,
] as const;
export type AccountTreatment = typeof ACCOUNT_TREATMENTS[number];

export function isCharacterTreatment(t: AccountTreatment | null | undefined): t is CharacterTreatment {
  return !!t && (CHARACTER_TREATMENTS as readonly string[]).includes(t);
}

/** Treatments that may carry a person target (stored in payment_person_id / payment_taxpayer_id). */
export const PERSON_TARGET_TREATMENTS = [
  'estimated_tax_payment', 'guaranteed_payment', 'owner_sehi', 'owner_retirement', 'w2_wages',
] as const satisfies readonly AccountTreatment[];

export function allowsPersonTarget(t: AccountTreatment | null | undefined): boolean {
  return !!t && (PERSON_TARGET_TREATMENTS as readonly string[]).includes(t);
}

/**
 * The person target is REQUIRED for a guaranteed payment (it goes to that
 * partner) and for S corp owner SEHI / retirement (officer W-2 + SEHI land on
 * that officer, D10).
 */
export function personRequiredFor(t: AccountTreatment | null | undefined, entityType: EntityTaxType | null | undefined): boolean {
  if (t === 'guaranteed_payment') return true;
  return entityType === 's_corp' && (t === 'owner_sehi' || t === 'owner_retirement');
}

const COST_ACCOUNT_TYPES = ['expense', 'other_expense', 'cogs'] as const;
const INCOME_ACCOUNT_TYPES = ['revenue', 'other_revenue'] as const;

/** Account types each treatment applies to (R1 F9); null = any account type. */
export const TREATMENT_ACCOUNT_TYPES: Record<AccountTreatment, readonly string[] | null> = {
  nondeductible_pct: COST_ACCOUNT_TYPES,
  owner_sehi: COST_ACCOUNT_TYPES,
  owner_retirement: COST_ACCOUNT_TYPES,
  owner_personal: COST_ACCOUNT_TYPES,
  w2_wages: COST_ACCOUNT_TYPES,
  tax_depreciation_differs: COST_ACCOUNT_TYPES,
  guaranteed_payment: COST_ACCOUNT_TYPES,
  estimated_tax_payment: null,
  capital_gain_lt: INCOME_ACCOUNT_TYPES,
  capital_gain_st: INCOME_ACCOUNT_TYPES,
  section_1231: INCOME_ACCOUNT_TYPES,
  interest: INCOME_ACCOUNT_TYPES,
  dividends_ordinary: INCOME_ACCOUNT_TYPES,
  dividends_qualified: INCOME_ACCOUNT_TYPES,
};

/** Entity types a treatment is allowed on; null = any. Guaranteed payments exist only in partnerships. */
export const TREATMENT_ENTITY_TYPES: Partial<Record<AccountTreatment, readonly EntityTaxType[]>> = {
  guaranteed_payment: ['partnership'],
};

export function treatmentAllowedFor(t: AccountTreatment, accountType: string, entityType: EntityTaxType | null | undefined): boolean {
  const types = TREATMENT_ACCOUNT_TYPES[t];
  if (types && !types.includes(accountType)) return false;
  const ents = TREATMENT_ENTITY_TYPES[t];
  return !ents || (!!entityType && ents.includes(entityType));
}

/** 'federal' or a two-letter state / DC code. */
export type PaymentJurisdiction = string;

export interface TaxEstimatorWarning {
  /** Inline SCREAMING_SNAKE code, `TE_*`. */
  code: string;
  severity: 'warning' | 'info';
  message: string;
  details?: Record<string, unknown>;
}

// ── Entity settings ────────────────────────────────────────────────

export interface EntitySettingsDto {
  tenantId: string;
  companyId: string;
  taxEntityType: EntityTaxType | null;
  taxMethod: TaxMethod | null;
  isSstb: boolean;
  largeCorporation: boolean;
  farmerOverride: boolean | null;
  rentalQbiTradeOrBusiness: boolean;
  stateSourcing: string | null;
  updatedAt: string | null;
}

export type EntityTypeSource = 'tb_profile' | 'estimator_setting' | 'company_entity_type' | 'none';
export type TaxMethodSource = 'estimator_setting' | 'company_accounting_method';

export interface ResolvedEntityTax {
  tenantId: string;
  companyId: string;
  companyName: string;
  entityType: EntityTaxType | null;
  entityTypeSource: EntityTypeSource;
  taxMethod: TaxMethod;
  taxMethodSource: TaxMethodSource;
  /** Books' own reporting basis (companies.accounting_method). */
  booksMethod: TaxMethod;
  /** TB return form when a profile exists (1040 | 1065 | 1120S | 1120). */
  tbReturnForm: string | null;
  tbDefaultActivityType: string | null;
  fiscalYearStartMonth: number;
  /** companies.lock_date (TB5 closing date), ISO date. */
  closingDate: string | null;
  warnings: TaxEstimatorWarning[];
}

export interface EntitySettingsResponse {
  settings: EntitySettingsDto;
  resolved: ResolvedEntityTax;
}

export interface EntityYearInputsDto {
  tenantId: string;
  companyId: string;
  taxYear: number;
  w2WagesOverride: string | null;
  w2WagesOverrideReason: string | null;
  ubia: string | null;
  updatedAt: string | null;
}

// ── Treatments ─────────────────────────────────────────────────────

export interface AccountTreatmentDto {
  id: string;
  accountId: string;
  accountNumber: string | null;
  accountName: string;
  accountType: string;
  treatment: AccountTreatment | null;
  pct: string | null;
  paymentTaxpayerId: string | null;
  paymentPersonId: string | null;
  paymentJurisdiction: PaymentJurisdiction | null;
  nonRecurring: boolean;
  updatedAt: string;
  /**
   * R3-17: the row's taxpayer / person target belongs to ANOTHER firm that also manages
   * these books. Its ids are withheld (null) and the row is read-only for this firm.
   */
  targetOtherFirm?: boolean;
}

export interface TreatmentSuggestion {
  accountId: string;
  accountNumber: string | null;
  accountName: string;
  accountType: string;
  treatment: AccountTreatment;
  pct: string | null;
  paymentJurisdiction: PaymentJurisdiction | null;
  /** Why this was suggested (TB code, or pattern + account type). Never auto-applied. */
  reason: string;
  /** 'tb_code' = from the account's TB tax-code assignment; 'name' = account-name pattern. */
  basis: 'tb_code' | 'name';
}

export interface TransactionFlagDto {
  transactionId: string;
  nonRecurring: boolean;
  txnDate: string | null;
  txnType: string | null;
  txnNumber: string | null;
  updatedAt: string;
}

/** A firm taxpayer the company is linked to (any tax year), for the register surface. */
export interface RegisterLinkedTaxpayerDTO {
  id: string;
  displayName: string;
  years: number[];
}

/** GET/PUT /tax-estimator/register/transactions/:transactionId. */
export interface RegisterTransactionFlagDTO {
  transactionId: string;
  /** null = the transaction carries no company, so no estimate can read it. */
  companyId: string | null;
  /** The company is linked to at least one active taxpayer of the managing firm. */
  linked: boolean;
  taxpayers: RegisterLinkedTaxpayerDTO[];
  nonRecurring: boolean;
  /** firm_admin / firm_staff; firm_readonly sees the state only. */
  canEdit: boolean;
  updatedAt: string | null;
}

/** GET /tax-estimator/register/flags — flagged transactions of the active company (badge source). */
export interface RegisterCompanyFlagsDTO {
  companyId: string;
  linked: boolean;
  canEdit: boolean;
  /** Ids of flagged transactions, oldest first, at most `limit`. */
  transactionIds: string[];
  total: number;
  limit: number;
}

export interface PagedList<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

// ── Tax-basis P&L (engine input) ───────────────────────────────────

/** Where an account's entity-profit amount goes after the treatment map. */
export type TreatmentRoute =
  | 'entity'             // stays in entity profit under `character`
  | 'owner_sehi'         // Sch C / Sch F / partnership: removed from entity profit, owner-level SEHI
  | 'owner_retirement'   // Sch C / Sch F / partnership: removed from entity profit, owner-level retirement
  | 'officer_sehi'       // S corp >2% health: KEPT as an S corp deduction; officer W-2 box 1 + owner SEHI (D10)
  | 'officer_retirement' // S corp retirement for an officer: KEPT as the corporation's deduction; informational per officer
  | 'guaranteed_payment' // partnership: KEPT as a partnership deduction; ordinary (SE) income of the named partner
  | 'dropped'            // owner_personal / tax-exempt / nondeductible M-1 code: removed, not deducted anywhere
  | 'payment';           // estimated_tax_payment: removed, fed to the payment ledger

export interface TaxCodeRef {
  returnForm: string;
  activityType: string;
  code: string;
  description: string;
  /** 'seed' = a TB seed code (mapped by CODE identity); 'firm' = a FIRM: code (mapped by description). */
  source?: 'seed' | 'firm';
  /** Seed / firm `is_m1_adjustment`: a book-tax reconciling code, never a character. */
  isM1Adjustment?: boolean;
}

export interface TaxBasisAccountLine {
  accountId: string;
  accountNumber: string | null;
  name: string;
  accountType: string;
  character: IncomeCharacter;
  /**
   * 'tb_assignment' = from account_tax_assignments; 'treatment' = an estimator
   * character treatment (wins over the TB code); 'unassigned' = default ordinary + warning.
   */
  characterSource: 'tb_assignment' | 'treatment' | 'unassigned';
  taxCode: TaxCodeRef | null;
  /** The STORED estimator treatment (null when none). */
  treatment: AccountTreatment | null;
  /** Treatment actually applied: the estimator's, else one implied by the TB code (e.g. 887 → owner_sehi). */
  effectiveTreatment: AccountTreatment | null;
  treatmentSource: 'estimator' | 'tb_code' | null;
  /** Person target of the treatment (GP partner, S corp officer, payment person). */
  personId: string | null;
  pct: string | null;
  route: TreatmentRoute;
  accountNonRecurring: boolean;
  /** Book profit effect for the range (profit-positive). */
  bookAmount: string;
  /** Amount left in entity profit after the treatment (profit-positive). */
  taxAmount: string;
  /** taxAmount − bookAmount. */
  reclass: string;
  /** Portion of bookAmount excluded from the recurring series (account or transaction flag). */
  nonRecurringBookAmount: string;
  /** TB Tax RJE for the tax year on this account (profit-positive). Informational; NOT applied. */
  tbTaxRje: string;
}

export interface EstimatedTaxPaymentTxn {
  transactionId: string;
  date: string;
  /** Positive = paid. */
  amount: string;
  accountId: string;
  accountName: string;
  taxpayerId: string | null;
  personId: string | null;
  jurisdiction: PaymentJurisdiction | null;
  memo: string | null;
}

export interface TaxBasisMonth {
  /** 'YYYY-MM' */
  month: string;
  bookNetIncome: string;
  /** Entity tax-basis profit by character for the month = recurring + nonRecurring. */
  byCharacter: CharacterAmounts;
  recurring: CharacterAmounts;
  nonRecurring: CharacterAmounts;
  ownerSehi: string;
  ownerRetirement: string;
  /** S corp >2% shareholder health added to officer W-2 box 1 (not SS / Medicare wages). */
  sehiAsW2Wages: string;
  /** Partnership guaranteed payments (all partners). */
  guaranteedPayments: string;
  w2Wages: string;
}

/** Owner-level amounts for one person (null = no person target; Sch C's single owner). */
export interface OwnerLevelPerson {
  personId: string | null;
  /** SEHI deduction for the person (all entity types that have one). */
  ownerSehi: string;
  /** Owner retirement deduction (Sch C / Sch F / partnership only). */
  ownerRetirement: string;
  /** S corp: >2% shareholder health premiums added to the officer's W-2 box 1 only (no FICA). */
  sehiAsW2Wages: string;
  /** S corp: retirement contributions for the officer, deducted by the corporation (informational). */
  employerRetirement: string;
  trace: TraceRow[];
}

/** Partnership guaranteed payment to one partner: ordinary (SE) income of that partner; deducted by the partnership. */
export interface GuaranteedPaymentDto {
  /** null only when the person target was deleted after the treatment was set (warning TE_GP_PERSON_MISSING). */
  personId: string | null;
  amount: string;
  accounts: Array<{ accountId: string; name: string; amount: string }>;
  trace: TraceRow[];
}

/** How the range end was chosen (R1 F5). */
export type ThroughMonthSource = 'requested' | 'last_closed_month' | 'last_complete_month';

export interface TaxBasisPl {
  tenantId: string;
  companyId: string;
  companyName: string;
  taxYear: number;
  /** ISO first day of the tax year window (calendar year; fiscal year for C corps). */
  periodStart: string;
  /** ISO last day of `throughMonth`. */
  throughDate: string;
  throughMonth: string;
  /** Default = the last closed month (readiness), else the last COMPLETE calendar month; never the current partial month. */
  throughMonthSource: ThroughMonthSource;
  throughMonthReason: string;
  /** Whole months in [periodStart, throughDate] — the run-rate divisor. */
  monthsElapsed: number;
  /** Months left in the tax-year window after `throughMonth`. */
  monthsRemaining: number;
  basis: TaxMethod;
  entityType: EntityTaxType | null;
  glVersionStamp: number;
  configVersion: string;
  cached: boolean;

  bookNetIncome: string;
  /** Σ byCharacter — entity-level tax-basis profit before owner allocation. */
  taxBasisProfit: string;
  byCharacter: CharacterAmounts;
  recurring: CharacterAmounts;
  nonRecurring: CharacterAmounts;
  ownerLevel: {
    ownerSehi: string;
    ownerRetirement: string;
    ownerPersonalDropped: string;
    /** S corp only: Σ officer health premiums added to W-2 box 1. */
    sehiAsW2Wages: string;
    byPerson: OwnerLevelPerson[];
  };
  /** Partnership only: guaranteed payments per partner (kept as a partnership deduction). */
  guaranteedPayments: GuaranteedPaymentDto[];
  /** Σ nondeductible_pct add-backs (positive). */
  nondeductibleAddBack: string;
  /** Accounts flagged tax_depreciation_differs: BOOK amount kept in profit; the tax amount comes from an adjustment. */
  taxDepreciationDiffers: Array<{ accountId: string; name: string; bookAmount: string }>;
  estimatedPayments: EstimatedTaxPaymentTxn[];
  months: TaxBasisMonth[];
  farmingGrossIncome: { currentYear: string; priorYear: string };
  w2Wages: {
    /** Books w2_wages total through `throughMonth`. */
    ytd: string;
    recurringYtd: string;
    nonRecurringYtd: string;
    /** ytd + (recurringYtd ÷ monthsElapsed) × monthsRemaining — the D8 "year's total" from the books. */
    projectedYear: string;
    override: string | null;
    overrideReason: string | null;
    /** FULL-YEAR wages for the §199A limit: override when set, else projectedYear. */
    effective: string;
    source: 'books' | 'override';
    /** Wage accounts with a person target (officer wages per officer), YTD. */
    byPerson: Array<{ personId: string; ytd: string }>;
  };
  /** Manual per-year UBIA input (D8); null = UBIA limb not computed. */
  ubia: string | null;
  accounts: TaxBasisAccountLine[];
  trace: TraceRow[];
  warnings: TaxEstimatorWarning[];
}

// ── Readiness ──────────────────────────────────────────────────────

export interface ReadinessAccount {
  accountId: string;
  accountNumber: string | null;
  name: string;
  kind: 'bank' | 'credit_card';
  /** Statement date of the latest COMPLETED reconciliation. */
  reconciledThrough: string | null;
  /**
   * Last whole month the account is closed through ('YYYY-MM'): from its latest
   * completed reconciliation, or — for an account never reconciled and with no
   * activity before the tax year — the month before its first activity (R1 F11).
   */
  closedThroughMonth: string | null;
  closedThroughSource: 'reconciliation' | 'before_first_activity' | null;
  /** First month with activity in the range (YYYY-MM), null when none. */
  firstActivityMonth: string | null;
  hasInProgressReconciliation: boolean;
  hasActivityInRange: boolean;
}

export interface BooksReadiness {
  tenantId: string;
  companyId: string;
  taxYear: number;
  periodStart: string;
  throughMonth: string;
  throughMonthSource: ThroughMonthSource;
  /** Latest month whose bank AND credit-card accounts are all reconciled; null if none. */
  lastClosedMonth: string | null;
  /** `throughMonth` is after `lastClosedMonth` (allowed, with a warning). */
  throughIsOpen: boolean;
  closingDate: string | null;
  reconcilableAccounts: ReadinessAccount[];
  unreconciledAccounts: ReadinessAccount[];
  suspense: {
    suspenseAccountId: string | null;
    balance: string;
    transactionCount: number;
    unpostedFeedCount: number;
    lookalikeAccounts: Array<{ accountId: string; name: string; balance: string }>;
  };
  unmappedAccounts: Array<{ accountId: string; accountNumber: string | null; name: string; bookAmount: string }>;
  entity: ResolvedEntityTax;
  warnings: TaxEstimatorWarning[];
}
