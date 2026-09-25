// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Accrual schedule math, shared by the API (which stores the entries) and
// the web preview (which shows them before saving). Pure; money in cents.

export const ACCRUAL_KINDS = ['prepaid', 'deferred_revenue', 'accrued_expense', 'fixed_asset'] as const;
export type AccrualKind = typeof ACCRUAL_KINDS[number];
export const ACCRUAL_METHODS = ['full_month', 'mid_month', 'actual_days'] as const;
export type AccrualMethod = typeof ACCRUAL_METHODS[number];

export interface ScheduleInput {
  /** Decimal string or number, e.g. "1200.00". */
  totalAmount: string | number;
  /** First day of service, YYYY-MM-DD. */
  startDate: string;
  months: number;
  method: AccrualMethod;
}

export interface ScheduleLine {
  /** First of the month the amount belongs to, YYYY-MM-DD. */
  periodStart: string;
  /** Two-decimal string. */
  amount: string;
}

function monthStart(y: number, m: number): string {
  const d = new Date(Date.UTC(y, m, 1));
  return d.toISOString().slice(0, 10);
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
}

/**
 * Split an amount across months.
 *  - full_month:  equal amounts from the start month for `months` months.
 *  - mid_month:   half a month in the first and last calendar months
 *                 (months + 1 calendar months in total).
 *  - actual_days: the first month is prorated by the days of service left
 *                 in it, middle months are equal, the last takes the rest
 *                 (months + 1 calendar months unless service starts on the 1st).
 * Each month is rounded DOWN to the cent and the final month absorbs the
 * remainder, so no month is ever negative and the total always ties out.
 */
export function buildAccrualSchedule(input: ScheduleInput): ScheduleLine[] {
  const total = Math.round(Number(input.totalAmount) * 100);
  const months = Math.floor(input.months);
  if (!Number.isFinite(total) || total <= 0) throw new Error('Amount must be greater than zero');
  if (!Number.isFinite(months) || months < 1 || months > 600) throw new Error('Months must be between 1 and 600');
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input.startDate);
  if (!m) throw new Error('Start date must be YYYY-MM-DD');
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  const day = Number(m[3]);
  const per = total / months;

  const shares: number[] = [];
  if (input.method === 'full_month' || (input.method === 'actual_days' && day === 1)) {
    for (let i = 0; i < months; i++) shares.push(Math.floor(per));
  } else if (input.method === 'mid_month') {
    shares.push(Math.floor(per / 2));
    for (let i = 1; i < months; i++) shares.push(Math.floor(per));
    shares.push(0); // last half-month: filled by the remainder below
  } else {
    const dim = daysInMonth(y, mo);
    shares.push(Math.floor((per * (dim - day + 1)) / dim));
    for (let i = 1; i < months; i++) shares.push(Math.floor(per));
    shares.push(0);
  }
  const allButLast = shares.slice(0, -1).reduce((a, b) => a + b, 0);
  shares[shares.length - 1] = total - allButLast;

  return shares.map((cents, i) => ({
    periodStart: monthStart(y, mo + i),
    amount: (cents / 100).toFixed(2),
  }));
}
