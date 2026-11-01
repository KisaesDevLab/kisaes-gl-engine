// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * Receive Payment allocation (U-132, receive-payment-v1): every figure of a
 * customer payment from what the owner chose. Pure: the service reads the
 * client's open invoices and passes them in, so POST /payments/preview and
 * the posting routes run exactly this. Golden cases:
 * packages/shared/fixtures/payment-golden.json.
 *
 *   cent balance  round2(stored balance_due), half away from zero. Invoices
 *                 written since sales-cents-v1 are whole cents already; only
 *                 a legacy invoice can carry a sub-cent residue, which is
 *                 never shown and never posted (Q-P21t).
 *   amounts       decimal strings with at most 2 places; no tolerance: a
 *                 payment over the cent balance is OVERAPPLIED (Q-P21g).
 *   auto          no applications: the amount fills the open invoices oldest
 *                 first (txnDate, number, id), each up to its cent balance.
 *   explicit      the rows sent: a typed amount is that amount; amount null
 *                 ("fill") takes what is left of the payment after the typed
 *                 rows, up to the row's cent balance, in date order. Rows not
 *                 sent get 0.00. With no payment amount, a fill row takes its
 *                 whole cent balance and the amount is the sum
 *                 (amountSource from_applications).
 *   totals        amountDue = the open invoices' cent balances; applied = the
 *                 cash applied; unapplied = amount - applied (a credit that
 *                 stays on the client's A/R).
 *   shortfalls    invoices partly paid by this payment: cent balance - payment.
 */

import DecimalLib from 'decimal.js';

const BaseDecimal = DecimalLib.default || DecimalLib;
const Decimal = BaseDecimal.clone({ precision: 40, rounding: BaseDecimal.ROUND_HALF_UP });
type DecimalValue = InstanceType<typeof Decimal>;

/** A money amount the client sends: at most 2 places, no sign, no exponent. */
export const MONEY_INPUT_RE = /^\d{1,15}(\.\d{1,2})?$/;

/** Most applications one request may carry (400 TOO_MANY_APPLICATIONS). */
export const MAX_APPLICATIONS = 1000;

export function dec(value: string | number | null | undefined): DecimalValue {
  return new Decimal(value === null || value === undefined || value === '' ? '0' : String(value));
}

/** round2, half away from zero. */
export function round2(value: string | DecimalValue | null | undefined): DecimalValue {
  return (typeof value === 'string' || value == null ? dec(value) : value).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

/** The cent balance of a stored balance_due (4-place string). */
export function centBalance(balanceDueExact: string | null | undefined): DecimalValue {
  return round2(balanceDueExact ?? '0');
}

export const money2 = (d: DecimalValue): string => d.toFixed(2);

export interface ComputeInvoice {
  invoiceId: string;
  invoiceNumber: string;
  txnDate: string;
  dueDate: string | null;
  total: string;
  /** Stored balance_due, 4 places, echoed as balanceDueExact. */
  balanceDueExact: string;
}

export interface ComputeRequest {
  /** The payment amount typed, or omitted. */
  amount?: string | null;
  /** Omitted: auto (oldest first). Present: explicit rows. */
  applications?: Array<{ invoiceId: string; amount: string | null }> | null;
}

export type ProblemCode =
  | 'AMOUNT_REQUIRED'
  | 'APPLICATIONS_EXCEED_AMOUNT'
  | 'OVERAPPLIED'
  | 'INVOICE_NOT_OPEN'
  | 'DUPLICATE_INVOICE';

export interface ComputeProblem { code: ProblemCode; invoiceId?: string }

export interface ComputedInvoice {
  invoiceId: string;
  invoiceNumber: string;
  txnDate: string;
  dueDate: string | null;
  total: string;
  balanceDue: string;
  balanceDueExact: string;
  payment: string;
  remaining: string;
}

export interface ComputeResult {
  amount: string;
  amountSource: 'typed' | 'from_applications';
  invoices: ComputedInvoice[];
  totals: { amountDue: string; applied: string; discountsAndCredits: string; unapplied: string };
  shortfalls: Array<{ invoiceId: string; amount: string }>;
  problems: ComputeProblem[];
  /** The applications to post: invoices with a payment above 0.00, oldest first. */
  applications: Array<{ invoiceId: string; amount: string; balanceDueExact: string }>;
}

/** Oldest first: txnDate, then number, then id. */
export function sortOpenInvoices<T extends { txnDate: string; invoiceNumber: string; invoiceId: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) =>
    a.txnDate < b.txnDate ? -1 : a.txnDate > b.txnDate ? 1
      : a.invoiceNumber < b.invoiceNumber ? -1 : a.invoiceNumber > b.invoiceNumber ? 1
        : a.invoiceId < b.invoiceId ? -1 : a.invoiceId > b.invoiceId ? 1 : 0);
}

export function computePayment(openInvoices: ComputeInvoice[], req: ComputeRequest): ComputeResult {
  const invoices = sortOpenInvoices(openInvoices.filter((i) => centBalance(i.balanceDueExact).greaterThan(0)));
  const byId = new Map(invoices.map((i) => [i.invoiceId, i]));
  const problems: ComputeProblem[] = [];
  const pay = new Map<string, DecimalValue>(invoices.map((i) => [i.invoiceId, new Decimal(0)]));
  const typedAmount = req.amount !== undefined && req.amount !== null && req.amount !== '' ? dec(req.amount) : null;
  let amount: DecimalValue;
  let amountSource: ComputeResult['amountSource'] = 'typed';

  if (req.applications === undefined || req.applications === null) {
    // Auto: oldest first.
    amount = typedAmount ?? new Decimal(0);
    let left = amount;
    for (const inv of invoices) {
      if (!left.greaterThan(0)) break;
      const take = Decimal.min(left, centBalance(inv.balanceDueExact));
      pay.set(inv.invoiceId, take);
      left = left.minus(take);
    }
  } else {
    const seen = new Set<string>();
    const fills: ComputeInvoice[] = [];
    let typedSum = new Decimal(0);
    for (const row of req.applications) {
      if (seen.has(row.invoiceId)) {
        problems.push({ code: 'DUPLICATE_INVOICE', invoiceId: row.invoiceId });
        continue;
      }
      seen.add(row.invoiceId);
      const inv = byId.get(row.invoiceId);
      if (!inv) {
        problems.push({ code: 'INVOICE_NOT_OPEN', invoiceId: row.invoiceId });
        continue;
      }
      if (row.amount === null) {
        fills.push(inv);
        continue;
      }
      const c = dec(row.amount);
      pay.set(inv.invoiceId, c);
      typedSum = typedSum.plus(c);
      if (c.greaterThan(centBalance(inv.balanceDueExact))) problems.push({ code: 'OVERAPPLIED', invoiceId: inv.invoiceId });
    }
    const orderedFills = sortOpenInvoices(fills);
    if (typedAmount === null) {
      amountSource = 'from_applications';
      let sum = typedSum;
      for (const inv of orderedFills) {
        const take = centBalance(inv.balanceDueExact);
        pay.set(inv.invoiceId, take);
        sum = sum.plus(take);
      }
      amount = sum;
    } else {
      amount = typedAmount;
      let left = Decimal.max(amount.minus(typedSum), 0);
      for (const inv of orderedFills) {
        const take = Decimal.min(left, centBalance(inv.balanceDueExact));
        pay.set(inv.invoiceId, take);
        left = left.minus(take);
      }
    }
  }

  let amountDue = new Decimal(0);
  let applied = new Decimal(0);
  const shortfalls: ComputeResult['shortfalls'] = [];
  const applications: ComputeResult['applications'] = [];
  const rows: ComputedInvoice[] = invoices.map((inv) => {
    const cents = centBalance(inv.balanceDueExact);
    const p = pay.get(inv.invoiceId) ?? new Decimal(0);
    amountDue = amountDue.plus(cents);
    applied = applied.plus(p);
    const remaining = cents.minus(p);
    if (p.greaterThan(0) && remaining.greaterThan(0)) shortfalls.push({ invoiceId: inv.invoiceId, amount: money2(remaining) });
    if (p.greaterThan(0)) applications.push({ invoiceId: inv.invoiceId, amount: money2(p), balanceDueExact: inv.balanceDueExact });
    return {
      invoiceId: inv.invoiceId,
      invoiceNumber: inv.invoiceNumber,
      txnDate: inv.txnDate,
      dueDate: inv.dueDate,
      total: money2(round2(inv.total)),
      balanceDue: money2(cents),
      balanceDueExact: inv.balanceDueExact,
      payment: money2(p),
      remaining: money2(remaining),
    };
  });

  if (applied.greaterThan(amount)) problems.push({ code: 'APPLICATIONS_EXCEED_AMOUNT' });
  if (!amount.greaterThan(0) && !applied.greaterThan(0)) problems.push({ code: 'AMOUNT_REQUIRED' });
  const unapplied = Decimal.max(amount.minus(applied), 0);

  return {
    amount: money2(amount),
    amountSource,
    invoices: rows,
    totals: { amountDue: money2(amountDue), applied: money2(applied), discountsAndCredits: '0.00', unapplied: money2(unapplied) },
    shortfalls,
    problems,
    applications,
  };
}
