// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// MODULE.md "Penalty (D7)" — event-driven underpayment accrual (§6654(a)-(b),
// Form 2210 Part III): each installment's UNPAID balance (payments.ts timeline)
// accrues from its due date to the earlier of the date it is paid or the return
// due date, at the rate in force each day. Day convention (R2-09, Form 2210
// Penalty Worksheet): the form counts "days from the due date to 6/30" at the
// first rate and "days from 6/30 to the payment date" at the next, so the day
// that ENDS on Jul 1 already carries the Q3 rate — a day d → d+1 takes the rate
// (and the year length) in force on d+1. Methods:
//   daily_simple        balance × rate × days ÷ days-in-year (federal; most states)
//   monthly_or_fraction balance × rate ÷ 12 × months-or-fraction (HI)
//   monthly_compound    balance × ((1 + rate ÷ 12)^months − 1) (ME)
//   tiered_flat         not computed — flat late-payment tiers, no rate (IL)
// The rate comes from a RateLookup the caller builds (federal:
// `penalty.underpayment_rate`; state: `statePenaltyRateOn`), so a 2027 quarter
// the IRS has not published yet surfaces as "verify" instead of a hard-coded
// number. A waiver (zero prior-year tax, balance below the minimum, no regime)
// zeroes the penalty but keeps the schedule for display. The Q4 relief ("file
// and pay by …") is a note: whether the return gets filed by then is unknown.

import type { PaymentJurisdiction } from '../entities-api.js';
import type { PenaltyMethod } from '../stateRuleKeys.js';
import { ZERO, ONE, dAdd, dDiv, dIsPos, dMul, dRoundDollars, dSub, dSum, dec, type Dec } from '../decimal.js';
import { addDays, daysBetween, daysInYear, monthsOrFraction, yearOf } from '../dates.js';
import type { EstimateContext } from './estimate-types.js';
import type { RatePeriod } from './parameters.js';
import type { PaymentApplicationResult } from './payments.js';

const STEP = 'penalty';
const MONTHS_PER_YEAR = String(12);

// ── Rate lookup ──────────────────────────────────────────────────────

export interface RateOnDate {
  /** Annual rate as a fraction; null = unknown (nothing can be computed for that day). */
  rate: Dec | null;
  /** false = the schedule does not cover the day; `rate` is a fallback (verify). */
  covered: boolean;
  keys: string[];
}

export type RateLookup = (isoDate: string) => RateOnDate;

/**
 * Lookup over a dated schedule (federal `penalty.underpayment_rate`). A day past
 * the last leg falls back to the LAST published rate with `covered: false`; a
 * day before the first leg to the first.
 */
export function scheduleRateLookup(periods: ReadonlyArray<RatePeriod>, keys: string[]): RateLookup {
  const sorted = [...periods].sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
  return (isoDate) => {
    const leg = sorted.find((p) => p.from <= isoDate && isoDate <= p.to);
    if (leg) return { rate: leg.rate, covered: true, keys };
    if (sorted.length === 0) return { rate: null, covered: false, keys };
    const first = sorted[0] as RatePeriod;
    const last = sorted[sorted.length - 1] as RatePeriod;
    return { rate: isoDate < first.from ? first.rate : last.rate, covered: false, keys };
  };
}

// ── Policy and results ───────────────────────────────────────────────

export interface PenaltyWaiver {
  reason: 'prior_year_zero_tax' | 'below_min_balance' | 'estimates_not_required' | 'no_estimate_regime' | 'other';
  detail: string;
}

export interface PenaltyPolicy {
  jurisdiction: PaymentJurisdiction;
  method: PenaltyMethod;
  rateOn: RateLookup;
  /** Accrual stops here (`return_due_date`). */
  returnDueDate: string;
  waiver: PenaltyWaiver | null;
  /** The last installment carries no penalty when the return is filed and paid in full by this date (note only). */
  lastInstallmentReliefDate: string | null;
  /** Caller-supplied badge (unverified rules, fallback pattern). */
  verify: boolean;
  /** Extra assumptions-page notes (e.g. state add-ons not modelled). */
  notes?: string[];
}

export interface PenaltySegment {
  from: string;
  /** Exclusive end. */
  to: string;
  /** Days (daily_simple) or months-or-fraction (monthly methods). */
  units: number;
  balance: Dec;
  rate: Dec;
  /** Days in the calendar year the segment's days fall in (daily_simple). */
  daysInYear: number | null;
  /** The rate for these days was not published (fallback used). */
  rateUncovered: boolean;
  amount: Dec;
}

export interface InstallmentPenalty {
  index: number;
  dueDate: string;
  /** Date accrual stopped: paid in full, or the return due date. */
  accruedTo: string | null;
  segments: PenaltySegment[];
  penalty: Dec;
  exact: Dec;
  verify: boolean;
}

export interface PenaltyResult {
  jurisdiction: PaymentJurisdiction;
  method: PenaltyMethod;
  /** false = the method cannot be computed from a rate (tiered_flat) — nothing accrued, verify. */
  computed: boolean;
  installments: InstallmentPenalty[];
  /** Σ installment penalties after the waiver (whole dollars). */
  total: Dec;
  /** Penalty that would apply without the waiver. */
  totalBeforeWaiver: Dec;
  waiver: PenaltyWaiver | null;
  verify: boolean;
  notes: string[];
  exact: { total: Dec; totalBeforeWaiver: Dec };
}

const R = dRoundDollars;

/** (1 + rate/12)^months − 1, by repeated multiplication (exact decimals). */
function compoundGrowth(rate: Dec, months: number): Dec {
  const monthly = dAdd(ONE, dDiv(rate, MONTHS_PER_YEAR));
  let acc: Dec = ONE;
  for (let i = 0; i < months; i++) acc = dMul(acc, monthly);
  return dSub(acc, ONE);
}

interface AccrualPiece { segments: PenaltySegment[]; verify: boolean }

/** daily_simple: walk the days, grouping runs with the same rate and year length. */
function accrueDaily(balance: Dec, from: string, to: string, policy: PenaltyPolicy): AccrualPiece {
  const segments: PenaltySegment[] = [];
  let verify = false;
  let runStart = from;
  let runRate: RateOnDate | null = null;
  let runYearDays = 0;
  let day = from;
  const flush = (end: string) => {
    if (!runRate || end <= runStart) return;
    const units = daysBetween(runStart, end);
    const rate = runRate.rate ?? ZERO;
    const amount = dDiv(dMul(dMul(balance, rate), String(units)), String(runYearDays));
    segments.push({ from: runStart, to: end, units, balance, rate, daysInYear: runYearDays, rateUncovered: !runRate.covered, amount });
  };
  while (day < to) {
    // Form 2210 convention: the day d → d+1 is priced at the rate and year length of d+1.
    const priced = addDays(day, 1);
    const r = policy.rateOn(priced);
    const yearDays = daysInYear(yearOf(priced));
    if (r.rate == null) verify = true;
    if (!r.covered) verify = true;
    if (!runRate || r.rate !== runRate.rate || r.covered !== runRate.covered || yearDays !== runYearDays) {
      flush(day);
      runStart = day; runRate = r; runYearDays = yearDays;
    }
    day = addDays(day, 1);
  }
  flush(to);
  return { segments, verify };
}

function accrueMonthly(balance: Dec, from: string, to: string, policy: PenaltyPolicy, compound: boolean): AccrualPiece {
  const r = policy.rateOn(from);
  const months = monthsOrFraction(from, to);
  const rate = r.rate ?? ZERO;
  const amount = compound ? dMul(balance, compoundGrowth(rate, months)) : dMul(dMul(balance, dDiv(rate, MONTHS_PER_YEAR)), String(months));
  return { segments: [{ from, to, units: months, balance, rate, daysInYear: null, rateUncovered: !r.covered, amount }], verify: r.rate == null || !r.covered };
}

/**
 * Accrue the underpayment penalty on the applied schedule. Pure; the optional
 * context receives trace rows and warnings.
 */
export function accruePenalty(applied: PaymentApplicationResult, policy: PenaltyPolicy, ctx?: EstimateContext): PenaltyResult {
  const notes: string[] = [...(policy.notes ?? [])];
  let verify = policy.verify;
  const computed = policy.method !== 'tiered_flat';
  if (!computed) {
    notes.push(`${policy.jurisdiction} charges flat late-payment tiers rather than an interest-style rate; the penalty is not computed here. Verify.`);
    ctx?.warn('TE_PENALTY_METHOD_NOT_COMPUTED', `${policy.jurisdiction}: penalty method '${policy.method}' cannot be computed from a rate; no penalty estimate.`, { jurisdiction: policy.jurisdiction, method: policy.method });
    verify = true;
  }

  const installments: InstallmentPenalty[] = applied.installments.map((inst) => {
    const segments: PenaltySegment[] = [];
    let instVerify = false;
    let accruedTo: string | null = null;
    if (computed) {
      const points = inst.timeline;
      for (let k = 0; k < points.length; k++) {
        const p = points[k]!;
        if (!dIsPos(p.balance)) continue;
        const next = points[k + 1];
        const rawEnd = next ? next.date : policy.returnDueDate;
        const end = rawEnd < policy.returnDueDate ? rawEnd : policy.returnDueDate;
        if (end <= p.date) continue;
        const piece = policy.method === 'daily_simple'
          ? accrueDaily(p.balance, p.date, end, policy)
          : accrueMonthly(p.balance, p.date, end, policy, policy.method === 'monthly_compound');
        segments.push(...piece.segments);
        instVerify = instVerify || piece.verify;
        accruedTo = end;
      }
      if (!accruedTo && inst.paidInFullOn) accruedTo = inst.paidInFullOn;
    }
    const exact = dSum(segments.map((s) => s.amount));
    if (ctx && dIsPos(exact)) {
      ctx.trace.add({ step: STEP, id: `${policy.jurisdiction}.penalty.${inst.index + 1}`, jurisdiction: policy.jurisdiction, label: `${policy.jurisdiction} underpayment penalty — installment ${inst.index + 1} (due ${inst.dueDate}, accrued to ${accruedTo})`, exact, source: 'parameter', formula: segments.map((s) => `${s.balance} × ${s.rate} × ${s.units}${s.daysInYear ? `/${s.daysInYear}` : ' mo'}`).join(' + '), parameterKeys: policy.rateOn(inst.dueDate).keys });
    }
    if (segments.some((s) => s.rateUncovered)) ctx?.warn('TE_PENALTY_RATE_UNCOVERED', `${policy.jurisdiction}: no published underpayment rate covers part of the accrual period for installment ${inst.index + 1}; the latest published rate was used. Verify.`, { jurisdiction: policy.jurisdiction, installment: inst.index + 1 });
    verify = verify || instVerify;
    return { index: inst.index, dueDate: inst.dueDate, accruedTo, segments, penalty: R(exact), exact, verify: instVerify };
  });

  const totalBeforeWaiver = dSum(installments.map((i) => i.exact));
  let total = totalBeforeWaiver;
  if (policy.waiver) {
    total = ZERO;
    notes.push(`No underpayment penalty: ${policy.waiver.detail}`);
    if (dIsPos(totalBeforeWaiver)) ctx?.info('TE_PENALTY_WAIVED', `${policy.jurisdiction}: the underpayment penalty (${R(totalBeforeWaiver)} before relief) does not apply — ${policy.waiver.detail}`, { jurisdiction: policy.jurisdiction, reason: policy.waiver.reason });
  }
  if (policy.lastInstallmentReliefDate) {
    notes.push(`If the return is filed and the balance paid in full by ${policy.lastInstallmentReliefDate}, no penalty accrues on the last installment (not assumed here).`);
  }
  notes.push(`Estimate: accrual runs from each due date to the earlier of the payment date or ${policy.returnDueDate}; the return's actual penalty depends on when it is filed and paid.`);
  if (ctx) {
    ctx.trace.add({ step: STEP, id: `${policy.jurisdiction}.penalty.total`, jurisdiction: policy.jurisdiction, label: `${policy.jurisdiction} estimated underpayment penalty${policy.waiver ? ' (waived)' : ''}`, exact: total, source: 'parameter', formula: installments.filter((i) => dIsPos(i.exact)).map((i) => `installment ${i.index + 1} ${i.exact}`).join(' + ') || undefined });
  }

  return {
    jurisdiction: policy.jurisdiction, method: policy.method, computed, installments,
    total: R(total), totalBeforeWaiver: R(totalBeforeWaiver), waiver: policy.waiver, verify, notes,
    exact: { total, totalBeforeWaiver },
  };
}

/** Convenience for tests and Phase 9: a lookup returning one flat rate for every day. */
export function flatRateLookup(rate: Dec, keys: string[] = []): RateLookup {
  const r = dec(rate);
  return () => ({ rate: r, covered: true, keys });
}
