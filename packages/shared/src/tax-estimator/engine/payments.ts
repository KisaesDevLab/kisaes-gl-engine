// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// MODULE.md "Payments" (Phase 10, D7): the payment ledger for one jurisdiction.
//   - payments = GL `estimated_tax_payment` rows + manual entries (deduplicated by
//     transaction id) + the prior-year overpayment, dated the prior return's
//     original due date;
//   - withholding is treated as paid EVENLY — one share credited on each
//     installment's due date (D10 default; actual-date election in backlog);
//   - every payment is applied to the EARLIEST installment with an unpaid
//     balance (§6654(b)(3) / Form 2210 instructions), excess carries forward and
//     reduces the next installment when it falls due;
//   - a payment made before anything is due (and a January payment of the next
//     year, PROGRESS.md R-note) simply enters the same event stream.
// The result carries each installment's balance TIMELINE so penalty.ts can
// accrue on the exact unpaid balance between events.

import type { PaymentJurisdiction } from '../entities-api.js';
import { ZERO, dAdd, dDiv, dIsPos, dMin, dMul, dRoundDollars, dSub, dSum, dec, type Dec } from '../decimal.js';
import type { EstimateContext, InstallmentDue } from './estimate-types.js';

const STEP = 'payments';

export type PaymentSource = 'gl' | 'manual' | 'prior_year_overpayment';

export interface EstimatePayment {
  id: string;
  /** 'YYYY-MM-DD' the payment was made (GL transaction date / manual date). */
  date: string;
  /** Positive. */
  amount: Dec;
  source: PaymentSource;
  jurisdiction: PaymentJurisdiction;
  /** GL transaction id for deduplication between the GL reader and manual entries. */
  transactionId?: string | null;
  memo?: string | null;
}

/**
 * One row per (jurisdiction, transaction id); the first row wins so a manual
 * entry listed before its GL twin keeps the manual memo. Rows without a
 * transaction id are never merged.
 */
export function dedupePayments(payments: ReadonlyArray<EstimatePayment>): EstimatePayment[] {
  const seen = new Set<string>();
  const out: EstimatePayment[] = [];
  for (const p of payments) {
    if (p.transactionId) {
      const k = `${p.jurisdiction}|${p.transactionId}`;
      if (seen.has(k)) continue;
      seen.add(k);
    }
    out.push(p);
  }
  return out;
}

/** Even withholding: one share per installment, in proportion to the installment percentages. */
export function withholdingShares(withholding: Dec, installmentPcts: ReadonlyArray<Dec>): Dec[] {
  const total = dSum(installmentPcts);
  if (installmentPcts.length === 0) return [];
  if (!dIsPos(total)) return installmentPcts.map(() => dDiv(dec(withholding), String(installmentPcts.length)));
  return installmentPcts.map((p) => dDiv(dMul(dec(withholding), p), total));
}

export interface PaymentApplicationInput {
  jurisdiction: PaymentJurisdiction;
  installments: InstallmentDue[];
  /** Withholding credited on each installment's due date (same length as `installments`). */
  withholdingShares: Dec[];
  payments: EstimatePayment[];
  /**
   * Accrual horizon (return due date). Payments dated after it are STILL applied — `unpaidAtEnd`
   * is "unpaid after every known payment" (R2-10) — but penalty.ts never accrues past this date,
   * and such a payment is flagged TE_PAYMENT_AFTER_RETURN_DUE.
   */
  endDate: string;
}

export interface AppliedPayment {
  paymentId: string;
  date: string;
  amount: Dec;
  source: PaymentSource | 'withholding' | 'carry';
}

export interface BalancePoint {
  date: string;
  /** Unpaid balance of the installment from this date on. */
  balance: Dec;
}

export interface InstallmentApplication {
  index: number;
  dueDate: string;
  required: Dec;
  /** Withholding share credited on the due date. */
  withholdingCredited: Dec;
  /** Excess from earlier installments / early payments that reduced this one on its due date. */
  carriedIn: Dec;
  /** Required − withholding share − carried in (floored at 0) — what estimates had to cover. */
  netRequired: Dec;
  applied: AppliedPayment[];
  /** Date the balance reached zero (null = never, given the payments known); may be after `endDate`. */
  paidInFullOn: string | null;
  /** Balance after every known payment, whatever its date (not "as of endDate"; see `endDate`). */
  unpaidAtEnd: Dec;
  /** Balance timeline (unrounded) for the penalty accrual; first point = due date. */
  timeline: BalancePoint[];
  exact: { required: Dec; withholdingCredited: Dec; carriedIn: Dec; netRequired: Dec; unpaidAtEnd: Dec };
}

export interface PaymentApplicationResult {
  jurisdiction: PaymentJurisdiction;
  installments: InstallmentApplication[];
  /** Payments that could not be matched to an installment (dated after `endDate` with nothing unpaid, or beyond all installments). */
  excessAfterLast: Dec;
  totalRequired: Dec;
  totalWithholding: Dec;
  totalEstimates: Dec;
  totalUnpaidAtEnd: Dec;
  exact: { excessAfterLast: Dec; totalRequired: Dec; totalWithholding: Dec; totalEstimates: Dec; totalUnpaidAtEnd: Dec };
}

type EventKind = 'due' | 'pay';
interface Event { date: string; kind: EventKind; amount: Dec; index: number; payment: AppliedPayment | null }

const KIND_ORDER: Record<EventKind, number> = { due: 0, pay: 1 };
const R = dRoundDollars;

/**
 * Apply withholding shares and payments to the installments, earliest unpaid
 * first. Pure; the context (optional) only receives trace rows / warnings.
 */
export function applyPayments(input: PaymentApplicationInput, ctx?: EstimateContext): PaymentApplicationResult {
  const n = input.installments.length;
  if (input.withholdingShares.length !== n) throw new Error('TE_PAYMENTS_SHAPE: withholdingShares must match installments');
  const events: Event[] = [];
  input.installments.forEach((inst, i) => {
    events.push({ date: inst.dueDate, kind: 'due', amount: dec(inst.required), index: i, payment: null });
    const wh = dec(input.withholdingShares[i] as Dec);
    if (dIsPos(wh)) events.push({ date: inst.dueDate, kind: 'pay', amount: wh, index: i, payment: { paymentId: `withholding.${i}`, date: inst.dueDate, amount: wh, source: 'withholding' } });
  });
  for (const p of input.payments) {
    const amt = dec(p.amount);
    if (!dIsPos(amt)) { ctx?.warn('TE_PAYMENT_NOT_POSITIVE', `Payment ${p.id} (${p.date}) is not positive and was ignored.`, { paymentId: p.id }); continue; }
    if (p.date > input.endDate) ctx?.info('TE_PAYMENT_AFTER_RETURN_DUE', `Payment ${p.id} is dated ${p.date}, after the return due date ${input.endDate}; it reduces the unpaid balance shown on the voucher but the underpayment penalty still accrued to ${input.endDate}.`, { paymentId: p.id });
    // Same-day order: due → withholding shares → estimated payments (index n sorts after every installment index).
    events.push({ date: p.date, kind: 'pay', amount: amt, index: n, payment: { paymentId: p.id, date: p.date, amount: amt, source: p.source } });
  }
  events.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : KIND_ORDER[a.kind] - KIND_ORDER[b.kind]) || a.index - b.index);

  const balance: Dec[] = input.installments.map(() => ZERO);
  const due: boolean[] = input.installments.map(() => false);
  const paidOn: (string | null)[] = input.installments.map(() => null);
  const carriedIn: Dec[] = input.installments.map(() => ZERO);
  const applied: AppliedPayment[][] = input.installments.map(() => []);
  const timeline: BalancePoint[][] = input.installments.map(() => []);
  let over: Dec = ZERO;

  for (const ev of events) {
    if (ev.kind === 'due') {
      const i = ev.index;
      due[i] = true;
      const carry = dMin(over, ev.amount);
      carriedIn[i] = carry;
      over = dSub(over, carry);
      balance[i] = dSub(ev.amount, carry);
      if (dIsPos(carry)) applied[i]!.push({ paymentId: `carry.${i}`, date: ev.date, amount: carry, source: 'carry' });
      if (!dIsPos(balance[i]!)) { balance[i] = ZERO; paidOn[i] = ev.date; }
      timeline[i]!.push({ date: ev.date, balance: balance[i]! });
      continue;
    }
    let remaining = ev.amount;
    for (let i = 0; i < n && dIsPos(remaining); i++) {
      if (!due[i] || !dIsPos(balance[i]!)) continue;
      const take = dMin(balance[i]!, remaining);
      balance[i] = dSub(balance[i]!, take);
      remaining = dSub(remaining, take);
      applied[i]!.push({ ...(ev.payment as AppliedPayment), amount: take });
      timeline[i]!.push({ date: ev.date, balance: balance[i]! });
      if (!dIsPos(balance[i]!)) paidOn[i] = ev.date;
    }
    if (dIsPos(remaining)) over = dAdd(over, remaining);
  }

  const installments: InstallmentApplication[] = input.installments.map((inst, i) => {
    const wh = dec(input.withholdingShares[i] as Dec);
    const netRequired = dMin(dec(inst.required), dSub(dSub(dec(inst.required), wh), carriedIn[i]!));
    const net = dIsPos(netRequired) ? netRequired : ZERO;
    const whCredited = dMin(wh, dSub(dec(inst.required), carriedIn[i]!));
    const exact = { required: dec(inst.required), withholdingCredited: dIsPos(whCredited) ? whCredited : ZERO, carriedIn: carriedIn[i]!, netRequired: net, unpaidAtEnd: balance[i]! };
    ctx?.trace.add({ step: STEP, id: `${input.jurisdiction}.installment.${i + 1}.unpaid`, jurisdiction: input.jurisdiction, label: `${input.jurisdiction} installment ${i + 1} (due ${inst.dueDate}) unpaid after known payments`, exact: balance[i]!, source: 'input', formula: `required ${inst.required} − withholding ${wh} − carried ${carriedIn[i]} − estimates ${dSum(applied[i]!.filter((a) => a.source !== 'withholding' && a.source !== 'carry').map((a) => a.amount))}` });
    return {
      index: i, dueDate: inst.dueDate, required: R(exact.required), withholdingCredited: R(exact.withholdingCredited), carriedIn: R(exact.carriedIn), netRequired: R(net),
      applied: applied[i]!, paidInFullOn: paidOn[i]!, unpaidAtEnd: R(balance[i]!), timeline: timeline[i]!, exact,
    };
  });

  const totalRequired = dSum(input.installments.map((x) => dec(x.required)));
  const totalWithholding = dSum(input.withholdingShares.map((x) => dec(x)));
  const totalEstimates = dSum(input.payments.filter((p) => dIsPos(dec(p.amount))).map((p) => dec(p.amount)));
  const totalUnpaid = dSum(balance);
  if (dIsPos(over)) ctx?.info('TE_PAYMENTS_EXCESS', `${input.jurisdiction}: payments exceed the required installments by ${R(over)}; the excess is an overpayment.`, { jurisdiction: input.jurisdiction, excess: R(over) });

  return {
    jurisdiction: input.jurisdiction, installments,
    excessAfterLast: R(over), totalRequired: R(totalRequired), totalWithholding: R(totalWithholding), totalEstimates: R(totalEstimates), totalUnpaidAtEnd: R(totalUnpaid),
    exact: { excessAfterLast: over, totalRequired, totalWithholding, totalEstimates, totalUnpaidAtEnd: totalUnpaid },
  };
}
