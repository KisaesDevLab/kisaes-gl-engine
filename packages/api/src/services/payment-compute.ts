// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * Receive Payment allocation (U-132 receive-payment-v1, U-133
 * payment-settle-v1, U-134 payment-discounts-v1): every figure of a customer
 * payment from what the owner chose. Pure: the service reads the client's
 * open invoices and credits and passes them in, so POST /payments/preview
 * and the posting routes run exactly this. Golden cases:
 * packages/shared/fixtures/payment-golden.json.
 *
 *   cent balance  round2(stored balance_due), half away from zero. Invoices
 *                 written since sales-cents-v1 are whole cents already; only
 *                 a legacy invoice can carry a sub-cent residue, which is
 *                 never shown and never posted (Q-P21t).
 *   amounts       decimal strings with at most 2 places; no tolerance: cash
 *                 + discount + write-off + credits over the cent balance is
 *                 OVERAPPLIED (Q-P21g).
 *   order         per invoice: typed cash, discount and write-off first;
 *                 then credits (typed, then fill: min(credit left, invoice
 *                 left)); then cash fill rows / auto take what is left of the
 *                 payment, oldest first (txnDate, number, id).
 *   auto          no applications: the amount fills the open invoices oldest
 *                 first, each up to what is left of its cent balance.
 *   explicit      the rows sent: a typed amount is that amount; amount null
 *                 ("fill") takes what is left of the payment after the typed
 *                 rows, in date order. Rows not sent get 0.00. With no
 *                 payment amount, a fill row takes all that is left of its
 *                 invoice and the amount is the sum (from_applications).
 *   discount      discountAvailable = round2(total x discountPercent / 100)
 *                 half away from zero, capped at the cent balance, while the
 *                 payment date is on or before the invoice's discount date and
 *                 no discount was taken on it before; else 0.00.
 *                 suggestDiscount: available > 0, none typed, and the row's
 *                 cash equals cent balance - available exactly (Q-P21c).
 *   totals        amountDue = the open invoices' cent balances; applied =
 *                 the cash applied; discountsAndCredits = discounts + credits
 *                 applied; writeOffs; unapplied = amount - applied (an A/R
 *                 credit on the client); overpayment = unapplied when above 0.
 *   shortfalls    invoices this payment settles in part: what is left, with
 *                 withinWriteOffLimit = left <= the company's limit (false
 *                 without one).
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

/** The early-payment discount an invoice offers on `date` (U-134), 2 places. */
export function discountAvailable(
  inv: { total: string; balanceDueExact: string; discountPercent?: string | null; discountDate?: string | null; discountTaken?: boolean },
  date: string | null | undefined,
): DecimalValue {
  if (!inv.discountPercent || !inv.discountDate || !date || inv.discountTaken) return new Decimal(0);
  if (date > inv.discountDate) return new Decimal(0);
  const pct = dec(inv.discountPercent);
  if (!pct.greaterThan(0)) return new Decimal(0);
  const amount = dec(inv.total).times(pct).dividedBy(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  return Decimal.max(Decimal.min(amount, centBalance(inv.balanceDueExact)), 0);
}

export interface ComputeInvoice {
  invoiceId: string;
  invoiceNumber: string;
  txnDate: string;
  dueDate: string | null;
  total: string;
  /** Stored balance_due, 4 places, echoed as balanceDueExact. */
  balanceDueExact: string;
  discountPercent?: string | null;
  discountDate?: string | null;
  /** A discount was taken on this invoice already (U-134: one per invoice). */
  discountTaken?: boolean;
}

export interface ComputeCredit {
  sourcePaymentId: string;
  date: string;
  refNo: string | null;
  /** What is left of the credit, 2 places. */
  remaining: string;
}

export interface ComputeRequest {
  /** The payment date (discount window). */
  date?: string | null;
  /** The payment amount typed, or omitted. */
  amount?: string | null;
  /** Omitted: auto (oldest first). Present: explicit rows. */
  applications?: Array<{
    invoiceId: string;
    amount: string | null;
    discountAmount?: string | null;
    writeOffAmount?: string | null;
  }> | null;
  /** Credits of the same client applied to invoices; amount null fills. */
  creditApplications?: Array<{ sourcePaymentId: string; invoiceId: string; amount: string | null }> | null;
  /** The company's write-off limit (2-place string) or null. */
  writeOffThreshold?: string | null;
}

export type ProblemCode =
  | 'AMOUNT_REQUIRED'
  | 'APPLICATIONS_EXCEED_AMOUNT'
  | 'OVERAPPLIED'
  | 'INVOICE_NOT_OPEN'
  | 'DUPLICATE_INVOICE'
  | 'CREDIT_NOT_AVAILABLE';

export interface ComputeProblem { code: ProblemCode; invoiceId?: string; sourcePaymentId?: string }

export interface ComputedInvoice {
  invoiceId: string;
  invoiceNumber: string;
  txnDate: string;
  dueDate: string | null;
  total: string;
  balanceDue: string;
  balanceDueExact: string;
  payment: string;
  discount: string;
  writeOff: string;
  credits: string;
  remaining: string;
  discountPercent: string | null;
  discountDate: string | null;
  discountAvailable: string;
  suggestDiscount: boolean;
}

export interface ComputeResult {
  amount: string;
  amountSource: 'typed' | 'from_applications';
  invoices: ComputedInvoice[];
  totals: { amountDue: string; applied: string; discountsAndCredits: string; writeOffs: string; unapplied: string };
  overpayment: string;
  shortfalls: Array<{ invoiceId: string; amount: string; withinWriteOffLimit: boolean }>;
  problems: ComputeProblem[];
  /** Invoices with anything applied by this payment, oldest first. */
  applications: Array<{ invoiceId: string; amount: string; discountAmount: string; writeOffAmount: string; balanceDueExact: string }>;
  /** Credits applied, in the order sent. */
  creditApplications: Array<{ sourcePaymentId: string; invoiceId: string; amount: string; balanceDueExact: string }>;
}

/** Oldest first: txnDate, then number, then id. */
export function sortOpenInvoices<T extends { txnDate: string; invoiceNumber: string; invoiceId: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) =>
    a.txnDate < b.txnDate ? -1 : a.txnDate > b.txnDate ? 1
      : a.invoiceNumber < b.invoiceNumber ? -1 : a.invoiceNumber > b.invoiceNumber ? 1
        : a.invoiceId < b.invoiceId ? -1 : a.invoiceId > b.invoiceId ? 1 : 0);
}

const ZERO = () => new Decimal(0);

export function computePayment(openInvoices: ComputeInvoice[], req: ComputeRequest, credits: ComputeCredit[] = []): ComputeResult {
  const invoices = sortOpenInvoices(openInvoices.filter((i) => centBalance(i.balanceDueExact).greaterThan(0)));
  const byId = new Map(invoices.map((i) => [i.invoiceId, i]));
  const problems: ComputeProblem[] = [];
  const cash = new Map<string, DecimalValue>(invoices.map((i) => [i.invoiceId, ZERO()]));
  const disc = new Map<string, DecimalValue>(invoices.map((i) => [i.invoiceId, ZERO()]));
  const wo = new Map<string, DecimalValue>(invoices.map((i) => [i.invoiceId, ZERO()]));
  const cred = new Map<string, DecimalValue>(invoices.map((i) => [i.invoiceId, ZERO()]));
  const left = (id: string) => centBalance(byId.get(id)!.balanceDueExact)
    .minus(cash.get(id)!).minus(disc.get(id)!).minus(wo.get(id)!).minus(cred.get(id)!);
  const typedAmount = req.amount !== undefined && req.amount !== null && req.amount !== '' ? dec(req.amount) : null;
  const auto = req.applications === undefined || req.applications === null;

  // 1. Typed cash, discounts and write-offs; fill rows remembered.
  const fills: ComputeInvoice[] = [];
  let typedCash = ZERO();
  if (!auto) {
    const seen = new Set<string>();
    for (const row of req.applications!) {
      if (seen.has(row.invoiceId)) { problems.push({ code: 'DUPLICATE_INVOICE', invoiceId: row.invoiceId }); continue; }
      seen.add(row.invoiceId);
      const inv = byId.get(row.invoiceId);
      if (!inv) { problems.push({ code: 'INVOICE_NOT_OPEN', invoiceId: row.invoiceId }); continue; }
      disc.set(inv.invoiceId, dec(row.discountAmount ?? '0'));
      wo.set(inv.invoiceId, dec(row.writeOffAmount ?? '0'));
      if (row.amount === null) { fills.push(inv); continue; }
      const c = dec(row.amount);
      cash.set(inv.invoiceId, c);
      typedCash = typedCash.plus(c);
    }
  }

  // 2. Credits: typed, then fill, each within the credit's remaining.
  const creditLeft = new Map(credits.map((c) => [c.sourcePaymentId, dec(c.remaining)]));
  const creditRows: Array<{ sourcePaymentId: string; invoiceId: string; amount: DecimalValue }> = [];
  const creditInput = req.creditApplications ?? [];
  for (const pass of ['typed', 'fill'] as const) {
    for (const row of creditInput) {
      if ((row.amount === null) !== (pass === 'fill')) continue;
      const inv = byId.get(row.invoiceId);
      if (!inv) { problems.push({ code: 'INVOICE_NOT_OPEN', invoiceId: row.invoiceId }); continue; }
      const avail = creditLeft.get(row.sourcePaymentId);
      if (avail === undefined) { problems.push({ code: 'CREDIT_NOT_AVAILABLE', sourcePaymentId: row.sourcePaymentId }); continue; }
      const x = pass === 'typed' ? dec(row.amount) : Decimal.max(Decimal.min(avail, left(inv.invoiceId)), 0);
      if (x.greaterThan(avail)) problems.push({ code: 'CREDIT_NOT_AVAILABLE', sourcePaymentId: row.sourcePaymentId });
      creditLeft.set(row.sourcePaymentId, avail.minus(x));
      cred.set(inv.invoiceId, cred.get(inv.invoiceId)!.plus(x));
      if (x.greaterThan(0)) creditRows.push({ sourcePaymentId: row.sourcePaymentId, invoiceId: inv.invoiceId, amount: x });
    }
  }

  // 3. Cash: auto oldest first, or fill rows in date order.
  let amount: DecimalValue;
  let amountSource: ComputeResult['amountSource'] = 'typed';
  if (auto) {
    amount = typedAmount ?? ZERO();
    let rest = amount;
    for (const inv of invoices) {
      if (!rest.greaterThan(0)) break;
      const take = Decimal.max(Decimal.min(rest, left(inv.invoiceId)), 0);
      cash.set(inv.invoiceId, take);
      rest = rest.minus(take);
    }
  } else if (typedAmount === null) {
    amountSource = 'from_applications';
    let sum = typedCash;
    for (const inv of sortOpenInvoices(fills)) {
      const take = Decimal.max(left(inv.invoiceId), 0);
      cash.set(inv.invoiceId, take);
      sum = sum.plus(take);
    }
    amount = sum;
  } else {
    amount = typedAmount;
    let rest = Decimal.max(amount.minus(typedCash), 0);
    for (const inv of sortOpenInvoices(fills)) {
      const take = Decimal.max(Decimal.min(rest, left(inv.invoiceId)), 0);
      cash.set(inv.invoiceId, take);
      rest = rest.minus(take);
    }
  }

  const threshold = req.writeOffThreshold === null || req.writeOffThreshold === undefined ? null : dec(req.writeOffThreshold);
  let amountDue = ZERO();
  let applied = ZERO();
  let discounts = ZERO();
  let writeOffs = ZERO();
  let creditsApplied = ZERO();
  const shortfalls: ComputeResult['shortfalls'] = [];
  const applications: ComputeResult['applications'] = [];
  const rows: ComputedInvoice[] = invoices.map((inv) => {
    const cents = centBalance(inv.balanceDueExact);
    const c = cash.get(inv.invoiceId)!;
    const d = disc.get(inv.invoiceId)!;
    const w = wo.get(inv.invoiceId)!;
    const x = cred.get(inv.invoiceId)!;
    amountDue = amountDue.plus(cents);
    applied = applied.plus(c);
    discounts = discounts.plus(d);
    writeOffs = writeOffs.plus(w);
    creditsApplied = creditsApplied.plus(x);
    const settled = c.plus(d).plus(w).plus(x);
    const remaining = cents.minus(settled);
    if (remaining.isNegative()) problems.push({ code: 'OVERAPPLIED', invoiceId: inv.invoiceId });
    if (settled.greaterThan(0) && remaining.greaterThan(0)) {
      shortfalls.push({ invoiceId: inv.invoiceId, amount: money2(remaining), withinWriteOffLimit: threshold !== null && !remaining.greaterThan(threshold) });
    }
    if (c.plus(d).plus(w).greaterThan(0)) {
      applications.push({ invoiceId: inv.invoiceId, amount: money2(c), discountAmount: money2(d), writeOffAmount: money2(w), balanceDueExact: inv.balanceDueExact });
    }
    const avail = discountAvailable(inv, req.date);
    return {
      invoiceId: inv.invoiceId,
      invoiceNumber: inv.invoiceNumber,
      txnDate: inv.txnDate,
      dueDate: inv.dueDate,
      total: money2(round2(inv.total)),
      balanceDue: money2(cents),
      balanceDueExact: inv.balanceDueExact,
      payment: money2(c),
      discount: money2(d),
      writeOff: money2(w),
      credits: money2(x),
      remaining: money2(remaining),
      discountPercent: inv.discountPercent ?? null,
      discountDate: inv.discountDate ?? null,
      discountAvailable: money2(avail),
      suggestDiscount: avail.greaterThan(0) && d.isZero() && c.equals(cents.minus(avail)),
    };
  });

  if (applied.greaterThan(amount)) problems.push({ code: 'APPLICATIONS_EXCEED_AMOUNT' });
  if (!amount.greaterThan(0) && !applied.greaterThan(0) && !discounts.greaterThan(0) && !writeOffs.greaterThan(0) && !creditsApplied.greaterThan(0)) {
    problems.push({ code: 'AMOUNT_REQUIRED' });
  }
  const unapplied = Decimal.max(amount.minus(applied), 0);

  return {
    amount: money2(amount),
    amountSource,
    invoices: rows,
    totals: {
      amountDue: money2(amountDue),
      applied: money2(applied),
      discountsAndCredits: money2(discounts.plus(creditsApplied)),
      writeOffs: money2(writeOffs),
      unapplied: money2(unapplied),
    },
    overpayment: money2(unapplied),
    shortfalls,
    problems,
    applications,
    creditApplications: creditRows.map((r) => ({
      sourcePaymentId: r.sourcePaymentId, invoiceId: r.invoiceId, amount: money2(r.amount),
      balanceDueExact: byId.get(r.invoiceId)!.balanceDueExact,
    })),
  };
}
