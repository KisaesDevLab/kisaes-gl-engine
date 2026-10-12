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
  jurisdictions: PortalTaxJurisdictionDTO[];
  payments: PortalTaxPaymentDTO[];
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
