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
// (`ownerSehi`, `ownerRetirement`, `ownerPersonalDropped`), W-2 wages, payments,
// add-backs and farming gross income are POSITIVE magnitudes.

import type { EntityTaxType, TaxMethod, TraceRow } from './types.js';

export const INCOME_CHARACTERS = [
  'ordinary', 'capital_gain_st', 'capital_gain_lt', 'section_1231',
  'interest', 'dividends_ordinary', 'dividends_qualified', 'rental',
] as const;
export type IncomeCharacter = typeof INCOME_CHARACTERS[number];

export type CharacterAmounts = Record<IncomeCharacter, string>;

export const ACCOUNT_TREATMENTS = [
  'nondeductible_pct', 'owner_sehi', 'owner_retirement', 'owner_personal',
  'estimated_tax_payment', 'tax_depreciation_differs', 'w2_wages',
] as const;
export type AccountTreatment = typeof ACCOUNT_TREATMENTS[number];

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
}

export interface TreatmentSuggestion {
  accountId: string;
  accountNumber: string | null;
  accountName: string;
  accountType: string;
  treatment: AccountTreatment;
  pct: string | null;
  paymentJurisdiction: PaymentJurisdiction | null;
  /** Why this was suggested (pattern + account type). Never auto-applied. */
  reason: string;
}

export interface TransactionFlagDto {
  transactionId: string;
  nonRecurring: boolean;
  txnDate: string | null;
  txnType: string | null;
  txnNumber: string | null;
  updatedAt: string;
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
  | 'entity'           // stays in entity profit under `character`
  | 'owner_sehi'       // removed from entity profit, owner-level SEHI
  | 'owner_retirement' // removed from entity profit, owner-level retirement
  | 'dropped'          // owner_personal: removed, not deducted anywhere
  | 'payment';         // estimated_tax_payment: removed, fed to the payment ledger

export interface TaxCodeRef {
  returnForm: string;
  activityType: string;
  code: string;
  description: string;
}

export interface TaxBasisAccountLine {
  accountId: string;
  accountNumber: string | null;
  name: string;
  accountType: string;
  character: IncomeCharacter;
  /** 'tb_assignment' = from account_tax_assignments; 'unassigned' = default ordinary + warning. */
  characterSource: 'tb_assignment' | 'unassigned';
  taxCode: TaxCodeRef | null;
  treatment: AccountTreatment | null;
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
  w2Wages: string;
}

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
  /** Whole months in [periodStart, throughDate]. */
  monthsElapsed: number;
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
  };
  /** Σ nondeductible_pct add-backs (positive). */
  nondeductibleAddBack: string;
  /** Accounts flagged tax_depreciation_differs: BOOK amount kept in profit; the tax amount comes from an adjustment. */
  taxDepreciationDiffers: Array<{ accountId: string; name: string; bookAmount: string }>;
  estimatedPayments: EstimatedTaxPaymentTxn[];
  months: TaxBasisMonth[];
  farmingGrossIncome: { currentYear: string; priorYear: string };
  w2Wages: {
    booksYtd: string;
    override: string | null;
    overrideReason: string | null;
    effective: string;
    source: 'books' | 'override';
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
  /** Last whole month covered by that reconciliation ('YYYY-MM'). */
  closedThroughMonth: string | null;
  hasInProgressReconciliation: boolean;
  hasActivityInRange: boolean;
}

export interface BooksReadiness {
  tenantId: string;
  companyId: string;
  taxYear: number;
  periodStart: string;
  throughMonth: string;
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
