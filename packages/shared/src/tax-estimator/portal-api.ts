// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Tax Estimator Phase 13 — client-portal and Report Pack DTOs.
//
// PORTAL CONTRACT (MODULE.md "Access", UI-SPEC §05): the portal payload is an
// ALLOW-LIST projection of the estimate built server-side. It carries only the
// signed-in contact's own taxpayer totals, voucher due dates / amounts, payments
// and the firm disclaimer. It NEVER carries other owners, persons, links,
// adjustments, rates, traces, parameters, readiness, safe-harbor workings or
// prior-year figures. Adding a field here is a privacy decision: extend the
// allow-list test in portal-tax-estimates-public.routes.test.ts with it.
// MONEY: whole-dollar decimal strings.

/** One installment of one jurisdiction's voucher schedule, as the client sees it. */
export interface PortalTaxInstallmentDTO {
  /** 'Q1'…'Q4', or 'Installment n' (farmer / non-quarterly schedules). */
  label: string;
  /** 'YYYY-MM-DD', business-day adjusted. */
  dueDate: string;
  /** The voucher amount for this installment (after withholding and carried-in overpayments). */
  amount: string;
  /** Estimated-tax payments applied to it. */
  paid: string;
  /** Still owed on it. */
  remaining: string;
  status: 'paid' | 'unpaid';
  /** Date the installment was fully paid, when known. */
  paidOn: string | null;
}

export interface PortalTaxJurisdictionDTO {
  /** 'federal' or a two-letter state code. */
  jurisdiction: string;
  /** "Federal (IRS)" / state name or code. */
  label: string;
  estimatesRequired: boolean;
  installments: PortalTaxInstallmentDTO[];
  /** The next unpaid installment and the amount to pay with it to be current; null when nothing is due. */
  nextPayment: { label: string; dueDate: string; amount: string } | null;
  totals: { required: string; withholding: string; estimatesPaid: string; remaining: string };
}

export interface PortalTaxPaymentDTO {
  /** 'YYYY-MM-DD'; null for a prior-year overpayment credited on the original due date. */
  date: string | null;
  jurisdiction: string;
  amount: string;
}

export interface PortalTaxEstimateDTO {
  taxpayer: { id: string; displayName: string };
  taxYear: number;
  /** live = computed on request (Redis-cached); snapshot = the firm's latest finalized snapshot (D10). */
  source: 'live' | 'snapshot';
  /** ISO timestamp the figures were computed (live) or frozen (snapshot). */
  asOf: string;
  /** 'YYYY-MM' the books were read through (earliest across the linked businesses), null when unknown. */
  booksThrough: string | null;
  firmName: string | null;
  disclaimer: string;
  totals: { total: string; federal: string; state: string };
  /**
   * Q51: present only when the contact's `quarterly_estimates` option is on (default on).
   * Absent = the installment table, next payment and voucher PDF are not shared.
   */
  jurisdictions?: PortalTaxJurisdictionDTO[];
  /** Q51: present only when the contact's `payments_on_record` option is on (default on). */
  payments?: PortalTaxPaymentDTO[];
  /** Q51: present only when the contact's `calculation_summary` option is on (default off). */
  calculationSummary?: PortalTaxCalcSummaryDTO;
}

// ── Q51: per-contact portal options ─────────────────────────────────────

/**
 * What one portal contact may see of the tax estimates shared with them (OPEN-QUESTIONS
 * Q51). One row per portal contact; it applies to every taxpayer the contact can open.
 * No row = DEFAULT_PORTAL_CONTACT_TAX_OPTIONS (exactly the view before Q51). The
 * projected total is always shown while the contact has tax_estimates_access.
 */
export interface PortalContactTaxOptionsDTO {
  /** The client-friendly calculation summary (PortalTaxCalcSummaryDTO). Default off. */
  calculationSummary: boolean;
  /** The installment table, next payment and the payment-voucher PDF. Default on. */
  quarterlyEstimates: boolean;
  /** The list of estimated-tax payments on record. Default on. */
  paymentsOnRecord: boolean;
  /** Download of the client-audience estimate PDF. Default off. */
  pdfDownload: boolean;
}

export type PortalContactTaxOptionKey = keyof PortalContactTaxOptionsDTO;
export const PORTAL_CONTACT_TAX_OPTION_KEYS: readonly PortalContactTaxOptionKey[] = [
  'calculationSummary', 'quarterlyEstimates', 'paymentsOnRecord', 'pdfDownload',
] as const;

/** Today's view (before Q51): installments + payments on, summary + PDF off. */
export const DEFAULT_PORTAL_CONTACT_TAX_OPTIONS: Readonly<PortalContactTaxOptionsDTO> = Object.freeze({
  calculationSummary: false, quarterlyEstimates: true, paymentsOnRecord: true, pdfDownload: false,
});

/** Staff-facing labels (one source for both option editors and the audit trail). */
export const PORTAL_CONTACT_TAX_OPTION_LABELS: Record<PortalContactTaxOptionKey, string> = {
  calculationSummary: 'Calculation summary',
  quarterlyEstimates: 'Quarterly estimates and vouchers',
  paymentsOnRecord: 'Payments on record',
  pdfDownload: 'Download the estimate PDF',
};

/**
 * Turning a section ON is a grant, OFF a revoke (Q41(7) asymmetry: tenant-side staff may
 * revoke but not grant). Keys absent from `next` keep their `current` value.
 */
export function portalOptionChanges(
  current: PortalContactTaxOptionsDTO, next: Partial<PortalContactTaxOptionsDTO>,
): { merged: PortalContactTaxOptionsDTO; granted: PortalContactTaxOptionKey[]; revoked: PortalContactTaxOptionKey[] } {
  const merged = { ...current };
  const granted: PortalContactTaxOptionKey[] = [];
  const revoked: PortalContactTaxOptionKey[] = [];
  for (const k of PORTAL_CONTACT_TAX_OPTION_KEYS) {
    const v = next[k];
    if (v === undefined || v === current[k]) continue;
    merged[k] = v;
    (v ? granted : revoked).push(k);
  }
  return { merged, granted, revoked };
}

/** GET/PUT .../portal/contacts/:id/tax-estimate-options (tenant side). */
export interface PortalContactTaxOptionsResponseDTO {
  options: PortalContactTaxOptionsDTO;
  /** false = the caller may only switch sections OFF (Q41(7)); the UI disables turning one on. */
  canGrant: boolean;
}

/** A scenario the contact may pick (Q51); listed only when more than one is shared. */
export interface PortalTaxScenarioOptionDTO {
  id: string;
  /** Shown as named by staff (name scenarios client-appropriately). */
  name: string;
  isBase: boolean;
}

/**
 * Q51 calculation summary — a client-friendly, whole-dollar projection of the estimate.
 * Built server-side by buildPortalCalcSummary (ALLOW-LIST): the taxpayer's OWN share of each
 * business only. Never entity totals, other owners, ownership %, adjustment detail, rates,
 * traces, formulas, review chips or warnings.
 */
export interface PortalTaxCalcSummaryDTO {
  /** One row per business: the taxpayer's (and spouse's) combined share of its projected income. */
  businesses: Array<{ name: string; amount: string }>;
  /** Wages, interest, dividends, capital gains, other income (non-zero lines only). */
  otherIncome: Array<{ label: string; amount: string }>;
  totalIncome: string;
  /** Adjustments to income, total only. */
  adjustmentsTotal: string;
  agi: string;
  deduction: { kind: 'standard' | 'itemized'; amount: string };
  /** Schedule 1-A deductions (tips / overtime / car-loan interest / seniors); '0' when none. */
  additionalDeductions: string;
  qbiDeduction: string;
  taxableIncome: string;
  regularTax: string;
  /** All credits applied (nonrefundable allowed + refundable), as a positive amount. */
  credits: string;
  selfEmploymentTax: string;
  additionalMedicareTax: string;
  niit: string;
  federalTotal: string;
  /** One row per state (resident and nonresident rows of a state combined). */
  states: Array<{ state: string; label: string; amount: string }>;
  stateTotal: string;
  total: string;
}

/** GET /api/portal/tax-estimates — the taxpayers this contact may see. */
export interface PortalTaxEstimateListItemDTO {
  id: string;
  displayName: string;
  /** Tax years with estimates the contact can open, newest first. */
  years: number[];
}

export interface PortalTaxEstimateListDTO {
  /** false = TAX_ESTIMATOR_V1 is off for the contact's tenant (the dashboard hides the entry). */
  featureEnabled: boolean;
  taxpayers: PortalTaxEstimateListItemDTO[];
}

/**
 * GET /api/portal/tax-estimates/:taxpayerId?year= — `estimate` is null when the
 * firm shows snapshots for this taxpayer and none has been finalized yet.
 */
export interface PortalTaxEstimateResponseDTO {
  estimate: PortalTaxEstimateDTO | null;
  unavailableReason: 'no_snapshot' | null;
  /**
   * Q51: the scenarios this contact may pick, Base first — present only when more than one
   * is offered (no key at all otherwise, so the default response is unchanged).
   */
  scenarios?: PortalTaxScenarioOptionDTO[];
  /** Q51: the scenario shown; present together with `scenarios`. */
  scenarioId?: string;
  /** Q51: true when the contact may download the client estimate PDF (absent = not offered). */
  pdfDownload?: true;
}

/** GET /api/v1/reports/tax-estimate/taxpayers — Report Pack option choices for the active company. */
export interface TaxEstimatePackTaxpayerDTO {
  id: string;
  displayName: string;
  /** Tax years this taxpayer is linked to the company for, newest first. */
  years: number[];
  /** QA D10: the scenarios of those years (Base first), for the optional scenario picker. */
  scenarios?: Array<{ id: string; name: string; taxYear: number; isBase: boolean }>;
}

/**
 * Default tax year of the portal view: the newest year not after the current calendar
 * year, else the newest. ONE definition for the server (portal-estimates.service) and the
 * portal page, so a page that does not name a year shows the year the server would pick.
 */
export function portalDefaultYear(years: readonly number[], today: Date = new Date()): number | undefined {
  const sorted = [...years].sort((a, b) => b - a);
  return sorted.find((y) => y <= today.getUTCFullYear()) ?? sorted[0];
}
