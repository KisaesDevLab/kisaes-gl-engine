// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Tax Estimator adjustment allocation (MODULE.md "Projection"). PURE: no IO.
// Whole calendar months. Money is handled as integer cents parsed from decimal
// strings, never floats, and the 12 monthly values always sum EXACTLY to the
// stated total (remainder cents are handed out one per month, earliest first).
//
// Rules:
//   monthly   amount in every active month (start..end)
//   quarterly amount per quarter, split ÷3 across the quarter's months (never all
//             in the quarter-end month); only active months of the quarter receive it
//   annual    amount is the year total, spread evenly across the active range
//   one_time  amount lands in start_month
// The Phase 6 engine applies any pct / tax-vs-book substitution; nothing is netted here.

export type AdjustmentCadence = 'monthly' | 'quarterly' | 'annual' | 'one_time';

export interface AllocatableAdjustment {
  /** null = GL-linked run-rate (no manual amount): remaining months use the actuals run-rate. */
  amount: string | number | null;
  cadence: AdjustmentCadence;
  /** 1-12 */
  startMonth: number;
  /** 1-12 */
  endMonth: number;
  glLinked?: boolean;
  /**
   * R7-05: a non-recurring GL-linked adjustment is never run-rated — with no manual amount
   * the remaining months are zero (actuals only); with a plan the plan is kept.
   */
  nonRecurring?: boolean;
}

export interface AllocationContext {
  /** Last CLOSED month (0-12). With glActuals, months 1..throughMonth use actuals. */
  throughMonth?: number;
  /** GL actuals per month (index 0 = Jan) for a GL-linked adjustment; only months <= throughMonth are read. */
  glActuals?: ReadonlyArray<number | string>;
}

const MONTHS = 12;

/** Parse a decimal string/number to integer cents, half away from zero. Non-finite -> 0. */
export function toCents(v: string | number | null | undefined): number {
  if (v == null || v === '') return 0;
  const s = typeof v === 'number' ? v.toFixed(6) : String(v).trim();
  const m = /^(-?)(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m) return 0;
  const neg = m[1] === '-';
  const whole = Number(m[2] || '0');
  const frac = (m[3] ?? '').padEnd(3, '0');
  let cents = whole * 100 + Number(frac.slice(0, 2));
  if (Number(frac[2]) >= 5) cents += 1;
  return neg ? -cents : cents;
}

export function centsToNumber(c: number): number {
  return c / 100;
}

/** Split `cents` into `n` parts differing by at most one cent, summing exactly; extra cents go to the earliest parts. */
export function splitCents(cents: number, n: number): number[] {
  if (n <= 0) return [];
  const sign = cents < 0 ? -1 : 1;
  const abs = Math.abs(cents);
  const base = Math.floor(abs / n);
  const rem = abs - base * n;
  return Array.from({ length: n }, (_, i) => sign * (base + (i < rem ? 1 : 0)));
}

function clampMonth(m: number): number {
  return Math.min(MONTHS, Math.max(1, Math.trunc(m)));
}

/** Planned monthly cents (index 0 = Jan) for a manual amount. */
export function allocateCents(adj: AllocatableAdjustment): number[] {
  const out = new Array<number>(MONTHS).fill(0);
  const total = toCents(adj.amount);
  const start = clampMonth(adj.startMonth);
  const end = Math.max(start, clampMonth(adj.endMonth));
  const inRange = (m: number) => m >= start && m <= end; // 1-based month
  switch (adj.cadence) {
    case 'monthly':
      for (let m = start; m <= end; m++) out[m - 1] = total;
      break;
    case 'one_time':
      out[start - 1] = total;
      break;
    case 'annual': {
      const parts = splitCents(total, end - start + 1);
      parts.forEach((c, i) => { out[start - 1 + i] = c; });
      break;
    }
    case 'quarterly':
      for (let q = 0; q < 4; q++) {
        const shares = splitCents(total, 3);
        for (let i = 0; i < 3; i++) {
          const m = q * 3 + i + 1;
          if (inRange(m)) out[m - 1] = shares[i]!;
        }
      }
      break;
  }
  return out;
}

/**
 * Combine GL actuals (closed months) with the plan/run-rate for the remaining months.
 * `plannedCents` is the manual allocation; pass `runRate: true` when the adjustment has
 * no manual amount, so remaining months get actualsYTD ÷ throughMonth (cents, exact).
 */
export function splitActualsAndRemainingCents(
  plannedCents: ReadonlyArray<number>,
  throughMonth: number,
  glActualsToDate?: ReadonlyArray<number | string>,
  runRate = false,
): { months: number[]; actualsYtd: number; remaining: number; total: number } {
  const through = Math.min(MONTHS, Math.max(0, Math.trunc(throughMonth)));
  const months = new Array<number>(MONTHS).fill(0);
  let actualsYtd = 0;
  for (let i = 0; i < through; i++) {
    const a = glActualsToDate ? toCents(glActualsToDate[i]) : (plannedCents[i] ?? 0);
    months[i] = a;
    actualsYtd += a;
  }
  const remainingMonths = MONTHS - through;
  if (runRate && through > 0 && remainingMonths > 0) {
    // The run-rate is a per-month figure (no total to conserve), so each remaining month gets the rounded rate.
    const perMonth = Math.round(actualsYtd / through);
    for (let i = through; i < MONTHS; i++) months[i] = perMonth;
  } else if (!runRate) {
    for (let i = through; i < MONTHS; i++) months[i] = plannedCents[i] ?? 0;
  }
  const total = months.reduce((s, c) => s + c, 0);
  return { months, actualsYtd, remaining: total - actualsYtd, total };
}

/** Public API: monthly dollar amounts (index 0 = Jan) for one adjustment. */
export function allocateAdjustment(adj: AllocatableAdjustment, _taxYear: number, ctx: AllocationContext = {}): number[] {
  const useGl = adj.glLinked === true && ctx.throughMonth != null && ctx.throughMonth > 0;
  if (!useGl) {
    return allocateCents(adj).map(centsToNumber);
  }
  const planned = adj.amount == null ? new Array<number>(MONTHS).fill(0) : allocateCents(adj);
  const runRate = adj.amount == null && adj.nonRecurring !== true;
  return splitActualsAndRemainingCents(planned, ctx.throughMonth!, ctx.glActuals, runRate).months.map(centsToNumber);
}

/** Dollar-valued variant of splitActualsAndRemainingCents. */
export function splitActualsAndRemaining(
  monthly: ReadonlyArray<number>,
  throughMonth: number,
  glActualsToDate?: ReadonlyArray<number | string>,
  runRate = false,
): { months: number[]; actualsYtd: number; remaining: number; total: number } {
  const r = splitActualsAndRemainingCents(monthly.map((n) => toCents(n)), throughMonth, glActualsToDate, runRate);
  return {
    months: r.months.map(centsToNumber), actualsYtd: centsToNumber(r.actualsYtd),
    remaining: centsToNumber(r.remaining), total: centsToNumber(r.total),
  };
}

/** Sum of a monthly strip in exact cents, returned as dollars. */
export function sumMonthly(months: ReadonlyArray<number>): number {
  return centsToNumber(months.reduce((s, n) => s + toCents(n), 0));
}
