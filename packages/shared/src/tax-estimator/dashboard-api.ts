// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Tax Estimator dashboard cards (OPEN-QUESTIONS.md Q52, Kurt 2026-10-13).
//
// Company dashboard: "Next estimated payment", "Projected tax for the year" and "Paid vs
// required" for the taxpayers linked to the active company. Firm-wide (Tax Estimator home):
// "Vouchers due in the next 30 days" and "Behind on payments".
//
// NO NEW TAX MATH. Every figure here is read off the estimate the engine already produced,
// projected AS OF a day by the same function the client portal uses (`installmentsAsOf`,
// via the portal's allow-list projection): the voucher amount, paid, remaining and status
// per installment; the engine's own §6654 / state penalty totals. The helpers below only
// select (which installment is next, which are due by today / inside the window) and add
// up those per-installment figures.
//
// MONEY: whole-dollar decimal strings, like the portal DTO.
import { dAdd, dIsPos, dRoundDollars } from './decimal.js';
import type { PortalTaxJurisdictionDTO } from './portal-api.js';

/** Days ahead the firm-wide "Vouchers due" card looks (inclusive of today and of the last day). */
export const TAX_EST_DASHBOARD_WINDOW_DAYS = 30;

/**
 * Where a card's figures came from (MODULE.md D10 cache / snapshots):
 *   live     — a live estimate (the Redis-cached result whose cache key matches today's inputs on
 *              the company dashboard; the newest stored summary of a live estimate on the firm cards),
 *   snapshot — the latest finalized snapshot (reason finalize / vouchers).
 */
export type TaxEstDashboardSource = 'live' | 'snapshot';

/** Who the company-dashboard payload was built for. */
export type TaxEstDashboardAudience = 'staff' | 'owner';

export interface TaxEstDashboardVoucherDTO {
  /** 'Q1'…'Q4' or 'Installment n'. */
  label: string;
  /** 'YYYY-MM-DD', business-day adjusted. */
  dueDate: string;
  /** The voucher amount (after withholding and carried-in overpayments). */
  amount: string;
  /** Still owed on it as of today. */
  remaining: string;
  status: 'paid' | 'unpaid';
}

export interface TaxEstDashboardJurisdictionDTO {
  /** 'federal' or a two-letter state code. */
  jurisdiction: string;
  /** "Federal (IRS)" / state name. */
  label: string;
  /** false = no vouchers for this jurisdiction (no regime, under the threshold …). */
  estimatesRequired: boolean;
  /** First installment due today or later (paid or not); null when none is left this year. */
  nextVoucher: TaxEstDashboardVoucherDTO | null;
  /** Σ voucher amounts of the installments due on or before today. */
  requiredToDate: string;
  /** Σ estimated payments applied to those installments, dated on or before today. */
  paidToDate: string;
  /** Σ still owed on those installments as of today (0 = current). */
  shortfall: string;
  /** The engine's estimated underpayment penalty for the year (whole dollars). Staff only; null for the owner audience. */
  penalty: string | null;
}

export interface TaxEstDashboardTaxpayerDTO {
  taxpayerId: string;
  displayName: string;
  taxYear: number;
  /** not_computed = no current cached estimate and no finalized snapshot (staff only; the owner audience omits the taxpayer). */
  status: 'ok' | 'not_computed';
  source: TaxEstDashboardSource | null;
  /** ISO timestamp the figures were computed (live) or frozen (snapshot). */
  asOf: string | null;
  /** 'YYYY-MM' the books were read through (earliest across the linked businesses). */
  booksThrough: string | null;
  totals: { total: string; federal: string; state: string } | null;
  /** Projected total minus the latest finalized snapshot's total; null when there is none or the figures ARE that snapshot. */
  changeSinceSnapshot: { amount: string; snapshotAt: string } | null;
  /**
   * Per-jurisdiction voucher / paid-vs-required figures. ABSENT (not empty) for the owner
   * audience when the owner's portal contact has the Q51 "Quarterly estimates" option off —
   * the owner card mirrors the portal, where that option hides the installments and the next
   * payment; the projected total always shows.
   */
  jurisdictions?: TaxEstDashboardJurisdictionDTO[];
  /** Σ jurisdiction shortfalls. Absent exactly when `jurisdictions` is. */
  shortfall?: string;
  /** Σ jurisdiction penalties (staff only; null for the owner audience). */
  penalty: string | null;
}

/** GET /api/v1/dashboard/tax-estimates — `data` is null when the cards are hidden. */
export interface CompanyTaxEstimatesDTO {
  audience: TaxEstDashboardAudience;
  /** The day the figures are projected to ('YYYY-MM-DD', UTC). */
  today: string;
  taxpayers: TaxEstDashboardTaxpayerDTO[];
}

export interface FirmVoucherDueDTO {
  taxpayerId: string;
  displayName: string;
  taxYear: number;
  jurisdiction: string;
  jurisdictionLabel: string;
  installment: string;
  dueDate: string;
  amount: string;
  remaining: string;
  status: 'paid' | 'unpaid';
  source: TaxEstDashboardSource;
  asOf: string;
}

export interface FirmBehindDTO {
  taxpayerId: string;
  displayName: string;
  taxYear: number;
  shortfall: string;
  penalty: string;
  source: TaxEstDashboardSource;
  asOf: string;
}

/** GET /api/v1/tax-estimator/dashboard — `data` is null when the caller sees no taxpayer. */
export interface FirmTaxEstDashboardDTO {
  today: string;
  windowDays: number;
  vouchersDue: FirmVoucherDueDTO[];
  behind: FirmBehindDTO[];
  /** Visible active taxpayers with a current-year setup but no stored estimate and no finalized snapshot. */
  notComputed: Array<{ taxpayerId: string; displayName: string; taxYear: number }>;
  visibleTaxpayers: number;
}

const R = dRoundDollars;

/** 'YYYY-MM-DD' + n calendar days (UTC). */
export function addDaysIso(day: string, days: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * One jurisdiction's card figures from its as-of projection (portal `toPortalEstimate`
 * output, which already applied `installmentsAsOf(today)`). `penalty` is the engine's
 * penalty total for the jurisdiction, or null to leave it out (owner audience).
 */
export function dashboardJurisdictionFigures(j: PortalTaxJurisdictionDTO, today: string, penalty: string | null): TaxEstDashboardJurisdictionDTO {
  const due = j.installments.filter((i) => i.dueDate <= today);
  const next = j.installments.find((i) => i.dueDate >= today) ?? null;
  return {
    jurisdiction: j.jurisdiction,
    label: j.label,
    estimatesRequired: j.estimatesRequired,
    nextVoucher: next ? { label: next.label, dueDate: next.dueDate, amount: next.amount, remaining: next.remaining, status: next.status } : null,
    requiredToDate: R(due.reduce((s, i) => dAdd(s, i.amount), '0')),
    paidToDate: R(due.reduce((s, i) => dAdd(s, i.paid), '0')),
    shortfall: R(due.reduce((s, i) => dAdd(s, i.remaining), '0')),
    penalty: penalty == null ? null : R(penalty),
  };
}

/** Taxpayer-level sums of the jurisdiction figures. */
export function dashboardTotals(js: readonly TaxEstDashboardJurisdictionDTO[], withPenalty: boolean): { shortfall: string; penalty: string | null } {
  return {
    shortfall: R(js.reduce((s, j) => dAdd(s, j.shortfall), '0')),
    penalty: withPenalty ? R(js.reduce((s, j) => dAdd(s, j.penalty ?? '0'), '0')) : null,
  };
}

/** true when any jurisdiction is short of its installments due to date. */
export const isBehind = (shortfall: string): boolean => dIsPos(R(shortfall));

/**
 * Installments due in [today, today + days] (both ends inclusive), from as-of projected
 * jurisdictions; paid ones included (the card shows the status).
 */
export function vouchersDueWithin(
  js: readonly PortalTaxJurisdictionDTO[], today: string, days: number = TAX_EST_DASHBOARD_WINDOW_DAYS,
): Array<{ jurisdiction: string; jurisdictionLabel: string; installment: string; dueDate: string; amount: string; remaining: string; status: 'paid' | 'unpaid' }> {
  const end = addDaysIso(today, days);
  const out = [];
  for (const j of js) {
    if (!j.estimatesRequired) continue;
    for (const i of j.installments) {
      if (i.dueDate < today || i.dueDate > end) continue;
      out.push({ jurisdiction: j.jurisdiction, jurisdictionLabel: j.label, installment: i.label, dueDate: i.dueDate, amount: i.amount, remaining: i.remaining, status: i.status });
    }
  }
  return out;
}
