// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// QA run 2 (QA2-01 / D13): installment status AS OF a day.
//
// The engine applies every KNOWN credit to the installments, whatever its date
// (payments.ts, R2-10): a payment booked with a future date, and the even
// withholding share credited on a LATER installment's due date, both back-fill
// an earlier installment. That is the right year-end projection for staff, but
// it is wrong for "is Q3 paid?" today: on 2026-10-12 a Q3 that only reaches zero
// on 2027-01-15 is past due, not Paid.
//
// `installmentsAsOf` re-reads the engine's own application record (applied
// entries with their dates) — no tax math, nothing recomputed — and answers per
// installment as of `today`:
//   - a credit dated after today (estimated payment, or a later installment's
//     withholding share) is not credited yet: it is added back to the balance;
//   - a later installment's withholding share that back-filled an earlier one is
//     handed back to its own (upcoming) installment, where it is expected on its
//     due date (withholding is treated as paid evenly, D10);
//   - the part of a future-dated payment that only reached an upcoming
//     installment as a carried-in overpayment is added back too;
//   - status / paid / remaining / paidOn and the jurisdiction totals all come
//     from the same as-of balances, so they agree with each other.
// Works on a frozen snapshot payload as well as a live result (both carry the
// application record and the payment ledger).
import { ZERO, dAdd, dIsPos, dMin, dRoundDollars, dSub, dSum, dec, type Dec } from './decimal.js';
import type { JurisdictionEstimate } from './engine/vouchers.js';

export interface AsOfInstallment {
  index: number;
  /** Estimated-tax payments applied to it and dated on or before `today` (whole dollars). */
  paid: Dec;
  /** Still owed on it as of `today` (whole dollars). */
  remaining: Dec;
  status: 'paid' | 'unpaid';
  /** Day the balance reached zero, only when that day is on or before `today`. */
  paidOn: string | null;
  /** Amount to pay with this installment to be current as of `today`: its own remaining plus every earlier one's. */
  catchUpAmount: Dec;
}

export interface AsOfJurisdiction {
  installments: AsOfInstallment[];
  /** Estimated-tax payments dated on or before `today` (prior-year overpayment included). */
  estimatesPaid: Dec;
  /** Sum of the installments' as-of remaining balances. */
  remaining: Dec;
  /** Estimated-tax payments of this jurisdiction dated after `today` (not counted). */
  scheduled: Dec;
}

export interface AsOfLedgerPayment { id: string; jurisdiction: string; date: string | null; amount: string }

type EstimateLike = Pick<JurisdictionEstimate, 'jurisdiction' | 'installments' | 'payments' | 'totals'>;

export function installmentsAsOf(e: EstimateLike, ledger: ReadonlyArray<AsOfLedgerPayment>, today: string): AsOfJurisdiction {
  const R = dRoundDollars;
  const future = ledger.filter((p) => p.jurisdiction === e.jurisdiction && p.date != null && p.date > today && dIsPos(dec(p.amount)));
  const scheduled = dSum(future.map((p) => dec(p.amount)));
  const app = e.payments;
  if (!app) {
    return { installments: [], estimatesPaid: R(e.totals.estimatesPaid), remaining: R(e.totals.unpaid), scheduled: R(scheduled) };
  }
  const n = app.installments.length;
  const remaining: Dec[] = app.installments.map((a) => a.exact.unpaidAtEnd);
  const paid: Dec[] = app.installments.map(() => ZERO);
  const futureIds = new Set(future.map((p) => p.id));
  let futureApplied: Dec = ZERO;
  const upcoming = (i: number) => (app.installments[i]!.dueDate > today);

  app.installments.forEach((a, i) => {
    for (const x of a.applied) {
      if (x.source === 'carry') continue;
      if (futureIds.has(x.paymentId)) futureApplied = dAdd(futureApplied, x.amount);
      const isPayment = x.source !== 'withholding';
      if (x.date <= today) {
        if (isPayment) paid[i] = dAdd(paid[i]!, x.amount);
        continue;
      }
      // Its own withholding share, credited on its own (future) due date: expected, keep it.
      if (x.paymentId === `withholding.${i}`) continue;
      remaining[i] = dAdd(remaining[i]!, x.amount);
      if (!isPayment) {
        // A later installment's share back-filled this one: hand it back to its owner.
        const j = Number(x.paymentId.slice('withholding.'.length));
        if (Number.isInteger(j) && j >= 0 && j < n) remaining[j] = dSub(remaining[j]!, x.amount);
      }
    }
  });

  // Future-dated payments that went to the overpayment pool reached upcoming installments only as
  // carried-in amounts. Older money is used first, so take them back from the LATEST carries.
  let futureCarry = dSub(scheduled, futureApplied);
  for (let i = n - 1; i >= 0 && dIsPos(futureCarry); i--) {
    if (!upcoming(i)) continue;
    const take = dMin(futureCarry, app.installments[i]!.exact.carriedIn);
    if (!dIsPos(take)) continue;
    remaining[i] = dAdd(remaining[i]!, take);
    futureCarry = dSub(futureCarry, take);
  }

  let cumulative: Dec = ZERO;
  const installments: AsOfInstallment[] = app.installments.map((a, i) => {
    const rest = dIsPos(remaining[i]!) ? remaining[i]! : ZERO;
    cumulative = dAdd(cumulative, rest);
    const owed = dIsPos(R(rest));
    return {
      index: i, paid: R(paid[i]!), remaining: R(rest), status: owed ? 'unpaid' : 'paid',
      paidOn: !owed && a.paidInFullOn != null && a.paidInFullOn <= today ? a.paidInFullOn : null,
      catchUpAmount: R(cumulative),
    };
  });
  return {
    installments,
    estimatesPaid: R(dSub(app.exact.totalEstimates, scheduled)),
    remaining: R(cumulative),
    scheduled: R(scheduled),
  };
}
