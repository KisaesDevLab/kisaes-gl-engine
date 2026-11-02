// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * Sales tax liability v2, owed and payments (U-149, U-152;
 * sales-tax-liability-v2, cash-basis-spf-v1).
 *
 * Everything sums the stored tax rows (transaction_tax_lines) and payment
 * lines (sales_tax_payment_lines), so the report, the owed figure and Pay
 * Sales Tax round identically (Q-P23b). Columns per agency and tax item:
 *
 * - collected — accrual: sale rows by their date. Cash (Q-P23e, Q-SPF1,
 *   Q-SPF3): each settlement k of an invoice (the cash virtual ledger's
 *   ar_apps, on the same dates) takes share_k = round2(T x P_k / total) -
 *   round2(T x P_(k-1) / total), P = cumulative cash + discount (never
 *   write-offs; bounces negative; credits and deposit draws at the apply or
 *   draw date, Q-P23y); a refund of a credit memo's credit takes the memo's
 *   rows the same way; sales receipts, daily sales and every other row
 *   count on their date.
 * - discounts — SSUTA discount rows (both bases). badDebts, recoveries —
 *   SSUTA rows on accrual; always 0.00 on cash (Q-SPF3).
 * - adjustments, paid — payment lines by date; openingPaid — opening lines.
 * - owedAtEnd = cumulative collected + discounts + badDebts + recoveries +
 *   adjustments - paid - opening.
 *
 * glMovement is the Sales Tax Payable movement on the chosen basis (the
 * accrual GL or the cash virtual ledger) = Σ columns + unassigned +
 * otherEntries (+ roundingDifference on cash: the exact shares the cash
 * ledger recognises less the rounded report shares).
 */

import { sql, type SQL } from 'drizzle-orm';
import DecimalLib from 'decimal.js';
import { db, type DbOrTx } from '../db/index.js';
import { AppError } from '../utils/errors.js';
import { arAppsCte, cashBasisLinesWith, buildSalesTaxLiability, executeCashBasis } from './report.service.js';

const BaseDecimal = DecimalLib.default || DecimalLib;
const Decimal = BaseDecimal.clone({ precision: 40, rounding: BaseDecimal.ROUND_HALF_UP });
type DecimalValue = InstanceType<typeof Decimal>;
const D0 = () => new Decimal(0);
const dec = (v: unknown) => new Decimal(v === null || v === undefined || v === '' ? '0' : String(v));
const m2 = (d: DecimalValue) => d.toDecimalPlaces(2, BaseDecimal.ROUND_HALF_UP).toFixed(2);
const r6 = (d: DecimalValue) => d.toDecimalPlaces(6, BaseDecimal.ROUND_HALF_UP).toFixed(6);

export type SalesTaxBasis = 'accrual' | 'cash';
const COLUMNS = ['collected', 'discounts', 'badDebts', 'recoveries', 'adjustments', 'paid'] as const;
type Column = typeof COLUMNS[number];
type Event = Column | 'opening';

interface Cell { inRange: DecimalValue; cum: DecimalValue }
interface Bucket {
  agencyId: string | null;
  itemId: string | null;
  cols: Record<Event, Cell>;
  taxable: DecimalValue;
  nonTaxable: Map<string, DecimalValue>;
}

const newCell = (): Cell => ({ inRange: D0(), cum: D0() });
const newBucket = (agencyId: string | null, itemId: string | null): Bucket => ({
  agencyId, itemId, taxable: D0(), nonTaxable: new Map(),
  cols: { collected: newCell(), discounts: newCell(), badDebts: newCell(), recoveries: newCell(), adjustments: newCell(), paid: newCell(), opening: newCell() },
});

/** The company's sales tax basis (Q-P23a): accrual unless set to cash. */
export async function companyBasis(tenantId: string, companyId: string | null, executor: DbOrTx = db): Promise<SalesTaxBasis> {
  if (!companyId) return 'accrual';
  const r = await executor.execute(sql`SELECT sales_tax_basis FROM companies WHERE tenant_id = ${tenantId} AND id = ${companyId}`);
  return (r.rows as Array<{ sales_tax_basis: string }>)[0]?.sales_tax_basis === 'cash' ? 'cash' : 'accrual';
}

/**
 * Tax events dated on or before `endDate` on a basis: one row per (item,
 * agency, code, event) with the base, tax and the exact (unrounded) tax the
 * GL moved, split into the part in [startDate, endDate] and the cumulative.
 */
function eventsSql(tenantId: string, companyId: string | null, basis: SalesTaxBasis, startDate: string | null, endDate: string, agencyId: string | null): SQL {
  const coT = companyId ? sql`t.company_id = ${companyId}` : sql`TRUE`;
  // A row written before its item had an agency (a legacy item) belongs to the item's agency now.
  const agency = agencyId ? sql`COALESCE(ev.agency_id, si.agency_id) = ${agencyId}` : sql`TRUE`;
  const from = startDate ?? '0001-01-01';
  const accrualKinds = sql`
    SELECT r.tax_item_id, r.agency_id, r.tax_code_id,
      CASE r.kind WHEN 'sale' THEN 'collected' WHEN 'discount' THEN 'discounts' WHEN 'bad_debt' THEN 'badDebts' ELSE 'recoveries' END AS col,
      r.event_date AS d, r.base::numeric AS base, r.tax::numeric AS tax, r.tax::numeric AS exact
    FROM transaction_tax_lines r
    JOIN transactions t ON t.id = r.transaction_id AND t.tenant_id = r.tenant_id
    WHERE r.tenant_id = ${tenantId} AND t.status = 'posted' AND ${coT}`;
  const events = basis === 'accrual'
    ? sql`WITH ev AS (${accrualKinds})`
    : sql`
      WITH ${arAppsCte(tenantId)},
      st AS (
        -- Each live settlement of an invoice with its running cash + discount
        -- (Q-P23e), on the cash virtual ledger's dates.
        SELECT app.invoice_id, COALESCE(app.rec_date, pay.txn_date) AS d, app.cash_amount,
          SUM(app.cash_amount) OVER w AS p_k,
          SUM(app.cash_amount) OVER w - app.cash_amount AS p_prev
        FROM ar_apps app
        JOIN transactions pay ON pay.id = app.payment_id AND pay.tenant_id = ${tenantId} AND pay.status = 'posted'
        WHERE COALESCE(app.rec_date, pay.txn_date) <= ${endDate}
        WINDOW w AS (PARTITION BY app.invoice_id ORDER BY COALESCE(app.rec_date, pay.txn_date), app.app_created, app.kind, app.app_id
                     ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
      ),
      mr AS (
        -- U-137 rule 3b: refunds of a credit memo's credit, running total.
        SELECT pay.source_payment_id AS memo_id, pay.txn_date AS d, pay.total::numeric AS cash_amount,
          SUM(pay.total::numeric) OVER w AS p_k,
          SUM(pay.total::numeric) OVER w - pay.total::numeric AS p_prev
        FROM transactions pay
        JOIN transactions m ON m.id = pay.source_payment_id AND m.tenant_id = pay.tenant_id AND m.txn_type = 'credit_memo' AND m.status = 'posted'
        WHERE pay.tenant_id = ${tenantId} AND pay.txn_type = 'customer_refund' AND pay.status = 'posted'
          AND pay.basis <> 'accrual' AND pay.txn_date <= ${endDate}
        WINDOW w AS (PARTITION BY pay.source_payment_id ORDER BY pay.txn_date, pay.created_at, pay.id
                     ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
      ),
      ev AS (
        SELECT r.tax_item_id, r.agency_id, r.tax_code_id, 'collected' AS col, st.d,
          round(r.base::numeric * st.p_k / t.total::numeric, 2) - round(r.base::numeric * st.p_prev / t.total::numeric, 2) AS base,
          round(r.tax::numeric * st.p_k / t.total::numeric, 2) - round(r.tax::numeric * st.p_prev / t.total::numeric, 2) AS tax,
          r.tax::numeric * st.cash_amount / t.total::numeric AS exact
        FROM st
        JOIN transactions t ON t.id = st.invoice_id AND t.tenant_id = ${tenantId} AND t.status = 'posted' AND NULLIF(t.total::numeric, 0) IS NOT NULL
        JOIN transaction_tax_lines r ON r.transaction_id = t.id AND r.tenant_id = ${tenantId} AND r.kind = 'sale'
        WHERE ${coT}
        UNION ALL
        SELECT r.tax_item_id, r.agency_id, r.tax_code_id, 'collected', mr.d,
          round(r.base::numeric * mr.p_k / t.total::numeric, 2) - round(r.base::numeric * mr.p_prev / t.total::numeric, 2),
          round(r.tax::numeric * mr.p_k / t.total::numeric, 2) - round(r.tax::numeric * mr.p_prev / t.total::numeric, 2),
          r.tax::numeric * mr.cash_amount / t.total::numeric
        FROM mr
        JOIN transactions t ON t.id = mr.memo_id AND t.tenant_id = ${tenantId} AND NULLIF(t.total::numeric, 0) IS NOT NULL
        JOIN transaction_tax_lines r ON r.transaction_id = t.id AND r.tenant_id = ${tenantId} AND r.kind = 'sale'
        WHERE ${coT}
        UNION ALL
        -- Sales receipts, daily sales and any other row-bearing transaction
        -- on their date; SSUTA discount rows on both bases (bad debts and
        -- recoveries never on cash, Q-SPF3).
        SELECT r.tax_item_id, r.agency_id, r.tax_code_id,
          CASE r.kind WHEN 'sale' THEN 'collected' ELSE 'discounts' END, r.event_date, r.base::numeric, r.tax::numeric, r.tax::numeric
        FROM transaction_tax_lines r
        JOIN transactions t ON t.id = r.transaction_id AND t.tenant_id = r.tenant_id
        WHERE r.tenant_id = ${tenantId} AND t.status = 'posted' AND ${coT}
          AND ((r.kind = 'sale' AND t.txn_type NOT IN ('invoice', 'credit_memo')) OR r.kind = 'discount')
      )`;
  return sql`
    ${events}
    SELECT ev.tax_item_id, COALESCE(ev.agency_id, si.agency_id) AS agency_id, ev.tax_code_id, ev.col,
      COALESCE(SUM(ev.base) FILTER (WHERE ev.d >= ${from}), 0)::text AS in_base,
      COALESCE(SUM(ev.tax) FILTER (WHERE ev.d >= ${from}), 0)::text AS in_tax,
      COALESCE(SUM(ev.exact) FILTER (WHERE ev.d >= ${from}), 0)::text AS in_exact,
      COALESCE(SUM(ev.tax), 0)::text AS cum_tax,
      COALESCE(SUM(ev.exact), 0)::text AS cum_exact
    FROM ev
    LEFT JOIN sales_tax_items si ON si.id = ev.tax_item_id AND si.tenant_id = ${tenantId}
    WHERE ev.d <= ${endDate} AND ${agency}
    GROUP BY ev.tax_item_id, COALESCE(ev.agency_id, si.agency_id), ev.tax_code_id, ev.col`;
}

interface EventRow { tax_item_id: string | null; agency_id: string | null; tax_code_id: string | null; col: Column; in_base: string; in_tax: string; in_exact: string; cum_tax: string; cum_exact: string }
interface LineRow { tax_item_id: string | null; agency_id: string | null; kind: string; in_amount: string; cum_amount: string }

/** Payment lines (paid, adjustment, opening) of live transactions dated on or before `endDate`. */
function paymentLinesSql(tenantId: string, companyId: string | null, startDate: string | null, endDate: string, agencyId: string | null, allDates = false): SQL {
  const from = startDate ?? '0001-01-01';
  return sql`
    SELECT l.tax_item_id, COALESCE(l.agency_id, si.agency_id) AS agency_id, l.kind,
      COALESCE(SUM(l.amount) FILTER (WHERE l.line_date >= ${from}), 0)::text AS in_amount,
      COALESCE(SUM(l.amount), 0)::text AS cum_amount
    FROM sales_tax_payment_lines l
    LEFT JOIN transactions t ON t.id = l.transaction_id AND t.tenant_id = l.tenant_id
    LEFT JOIN sales_tax_items si ON si.id = l.tax_item_id AND si.tenant_id = l.tenant_id
    WHERE l.tenant_id = ${tenantId} AND (l.transaction_id IS NULL OR t.status = 'posted')
      AND ${companyId ? sql`l.company_id = ${companyId}` : sql`TRUE`}
      AND ${agencyId ? sql`COALESCE(l.agency_id, si.agency_id) = ${agencyId}` : sql`TRUE`}
      AND ${allDates ? sql`TRUE` : sql`l.line_date <= ${endDate}`}
    GROUP BY l.tax_item_id, COALESCE(l.agency_id, si.agency_id), l.kind`;
}

/** Sales Tax Payable movement on a basis: [start, end] (start null = cumulative). */
async function stpMovement(tenantId: string, companyId: string | null, basis: SalesTaxBasis, startDate: string | null, endDate: string): Promise<DecimalValue> {
  if (basis === 'cash') {
    const r = await executeCashBasis(sql`
      WITH ${cashBasisLinesWith(tenantId, startDate, endDate, companyId)}
      SELECT COALESCE(SUM(cb.credit - cb.debit), 0)::text AS m
      FROM cb_lines cb JOIN accounts a ON a.id = cb.account_id AND a.tenant_id = ${tenantId}
      WHERE a.system_tag = 'sales_tax_payable'`);
    return dec((r.rows as Array<{ m: string }>)[0]?.m);
  }
  const r = await db.execute(sql`
    SELECT COALESCE(SUM(jl.credit - jl.debit), 0)::text AS m
    FROM journal_lines jl
    JOIN transactions t ON t.id = jl.transaction_id AND t.tenant_id = jl.tenant_id
    JOIN accounts a ON a.id = jl.account_id AND a.tenant_id = jl.tenant_id
    WHERE jl.tenant_id = ${tenantId} AND t.status = 'posted' AND t.basis <> 'cash'
      AND a.system_tag = 'sales_tax_payable'
      AND ${companyId ? sql`t.company_id = ${companyId}` : sql`TRUE`}
      AND ${startDate ? sql`t.txn_date >= ${startDate}` : sql`TRUE`} AND t.txn_date <= ${endDate}`);
  return dec((r.rows as Array<{ m: string }>)[0]?.m);
}

interface Names {
  items: Map<string, { name: string; rate: string | null; agencyId: string | null; kind: string; isActive: boolean; order: number }>;
  agencies: Map<string, { name: string; order: number }>;
  codes: Map<string, string>;
}

async function loadNames(tenantId: string, companyId: string | null, executor: DbOrTx = db): Promise<Names> {
  const co = (alias: string) => (companyId ? sql`${sql.raw(alias)}.company_id = ${companyId}` : sql`TRUE`);
  const items = await executor.execute(sql`
    SELECT i.id, i.name, i.rate::text AS rate, i.agency_id, i.kind, i.is_active
    FROM sales_tax_items i WHERE i.tenant_id = ${tenantId} AND ${co('i')} ORDER BY i.created_at, i.id`);
  const agencies = await executor.execute(sql`
    SELECT ag.id, COALESCE(c.display_name, '') AS name
    FROM sales_tax_agencies ag LEFT JOIN contacts c ON c.id = ag.vendor_id AND c.tenant_id = ag.tenant_id
    WHERE ag.tenant_id = ${tenantId} AND ${co('ag')} ORDER BY ag.created_at, ag.id`);
  const codes = await executor.execute(sql`SELECT id, code FROM sales_tax_codes WHERE tenant_id = ${tenantId} AND ${co('sales_tax_codes')}`);
  return {
    items: new Map((items.rows as Array<Record<string, any>>).map((r, k) => [r['id'], {
      name: r['name'], rate: r['rate'] === null ? null : new Decimal(r['rate']).toFixed(6), agencyId: r['agency_id'], kind: r['kind'], isActive: r['is_active'], order: k,
    }])),
    agencies: new Map((agencies.rows as Array<Record<string, any>>).map((r, k) => [r['id'], { name: r['name'], order: k }])),
    codes: new Map((codes.rows as Array<Record<string, any>>).map((r) => [r['id'], r['code']])),
  };
}

async function buckets(tenantId: string, companyId: string | null, basis: SalesTaxBasis, startDate: string | null, endDate: string, agencyId: string | null, payAllDates = false, executor: DbOrTx = db) {
  const ev = await executor.execute(eventsSql(tenantId, companyId, basis, startDate, endDate, agencyId));
  const lines = await executor.execute(paymentLinesSql(tenantId, companyId, startDate, endDate, agencyId, payAllDates));
  const map = new Map<string, Bucket>();
  const get = (agency: string | null, item: string | null) => {
    const k = `${agency ?? '-'}|${item ?? '-'}`;
    let b = map.get(k);
    if (!b) { b = newBucket(agency, item); map.set(k, b); }
    return b;
  };
  let roundingIn = D0();
  let roundingCum = D0();
  for (const r of ev.rows as unknown as EventRow[]) {
    // An unassigned row (no item) keeps no agency: one unassigned bucket.
    const b = get(r.tax_item_id ? r.agency_id : null, r.tax_item_id);
    const cell = b.cols[r.col];
    cell.inRange = cell.inRange.plus(dec(r.in_tax));
    cell.cum = cell.cum.plus(dec(r.cum_tax));
    if (r.col === 'collected') {
      if (r.tax_code_id) b.nonTaxable.set(r.tax_code_id, (b.nonTaxable.get(r.tax_code_id) ?? D0()).plus(dec(r.in_base)));
      else b.taxable = b.taxable.plus(dec(r.in_base));
      roundingIn = roundingIn.plus(dec(r.in_exact)).minus(dec(r.in_tax));
      roundingCum = roundingCum.plus(dec(r.cum_exact)).minus(dec(r.cum_tax));
    }
  }
  for (const r of lines.rows as unknown as LineRow[]) {
    const b = get(r.agency_id, r.tax_item_id);
    const col: Event = r.kind === 'paid' ? 'paid' : r.kind === 'adjustment' ? 'adjustments' : 'opening';
    b.cols[col].inRange = b.cols[col].inRange.plus(dec(r.in_amount));
    b.cols[col].cum = b.cols[col].cum.plus(dec(r.cum_amount));
  }
  return { map, roundingIn: basis === 'cash' ? roundingIn : D0(), roundingCum: basis === 'cash' ? roundingCum : D0() };
}

const owedOf = (b: Bucket, part: 'inRange' | 'cum') =>
  b.cols.collected[part].plus(b.cols.discounts[part]).plus(b.cols.badDebts[part]).plus(b.cols.recoveries[part])
    .plus(b.cols.adjustments[part]).minus(b.cols.paid[part]).minus(b.cols.opening[part]);

/** Group buckets by agency (at posting time, Q-P23v) in setup order; items with no activity still listed. */
function byAgency(map: Map<string, Bucket>, names: Names, agencyId: string | null) {
  const out = new Map<string | null, Bucket[]>();
  const seen = new Set<string>();
  for (const b of map.values()) {
    if (!b.itemId) continue;
    seen.add(b.itemId);
    out.set(b.agencyId, [...(out.get(b.agencyId) ?? []), b]);
  }
  for (const [id, it] of names.items) {
    if (seen.has(id) || it.kind !== 'item' || !it.isActive) continue;
    if (agencyId && it.agencyId !== agencyId) continue;
    out.set(it.agencyId, [...(out.get(it.agencyId) ?? []), newBucket(it.agencyId, id)]);
  }
  const ord = (a: string | null) => (a === null ? Number.MAX_SAFE_INTEGER : names.agencies.get(a)?.order ?? Number.MAX_SAFE_INTEGER - 1);
  return [...out.entries()].sort(([a], [b]) => ord(a) - ord(b)).map(([agency, list]) => ({
    agency,
    items: list.sort((x, y) => (names.items.get(x.itemId!)?.order ?? 0) - (names.items.get(y.itemId!)?.order ?? 0)),
  }));
}

const sumCols = (list: Bucket[], part: 'inRange' | 'cum') => {
  const t = Object.fromEntries([...COLUMNS, 'opening'].map((c) => [c, D0()])) as Record<Event, DecimalValue>;
  let taxable = D0();
  for (const b of list) {
    for (const c of [...COLUMNS, 'opening'] as Event[]) t[c] = t[c].plus(b.cols[c][part]);
    taxable = taxable.plus(b.taxable);
  }
  return { t, taxable };
};

export interface LiabilityOptions { basis?: SalesTaxBasis | null; agencyId?: string | null }

/**
 * GET /reports/sales-tax-liability (v1 + v2). Keeps v1's totalSales /
 * totalTax numbers; every new field is a decimal string.
 */
export async function buildSalesTaxLiabilityV2(
  tenantId: string, startDate: string, endDate: string, companyId: string | null, opts: LiabilityOptions = {},
) {
  if (startDate > endDate) throw AppError.badRequest('start_date is after end_date.', 'VALIDATION_ERROR');
  const basis = opts.basis ?? await companyBasis(tenantId, companyId);
  const agencyId = opts.agencyId ?? null;
  const v1 = await buildSalesTaxLiability(tenantId, startDate, endDate, companyId);
  const names = await loadNames(tenantId, companyId);
  if (agencyId && !names.agencies.has(agencyId)) throw AppError.notFound('Sales tax agency not found');
  const { map, roundingIn, roundingCum } = await buckets(tenantId, companyId, basis, startDate, endDate, agencyId);

  const itemOut = (b: Bucket) => {
    const it = b.itemId ? names.items.get(b.itemId) : undefined;
    return {
      taxItemId: b.itemId,
      name: it?.name ?? '',
      rate: it?.rate ?? null,
      taxableSales: m2(b.taxable),
      nonTaxable: [...b.nonTaxable.entries()].filter(([, v]) => !v.isZero())
        .map(([codeId, amount]) => ({ codeId, code: names.codes.get(codeId) ?? '', amount: m2(amount) })),
      collected: m2(b.cols.collected.inRange),
      discounts: m2(b.cols.discounts.inRange),
      badDebts: m2(b.cols.badDebts.inRange),
      recoveries: m2(b.cols.recoveries.inRange),
      adjustments: m2(b.cols.adjustments.inRange),
      paid: m2(b.cols.paid.inRange),
      owedAtEnd: m2(owedOf(b, 'cum')),
    };
  };
  const totalsOut = (list: Bucket[]) => {
    const { t, taxable } = sumCols(list, 'inRange');
    return {
      taxableSales: m2(taxable),
      collected: m2(t.collected), discounts: m2(t.discounts), badDebts: m2(t.badDebts), recoveries: m2(t.recoveries),
      adjustments: m2(t.adjustments), paid: m2(t.paid),
      owedAtEnd: m2(list.reduce((s, b) => s.plus(owedOf(b, 'cum')), D0())),
    };
  };

  const groups = byAgency(map, names, agencyId);
  const assigned = groups.flatMap((g) => g.items);
  const unassignedBuckets = [...map.values()].filter((b) => !b.itemId);
  const un = sumCols(unassignedBuckets, 'inRange').t;
  const unCum = sumCols(unassignedBuckets, 'cum').t;
  const unassignedIn = un.collected.plus(un.discounts).plus(un.badDebts).plus(un.recoveries).plus(un.adjustments).minus(un.paid).minus(un.opening);
  const unassignedCum = unCum.collected.plus(unCum.discounts).plus(unCum.badDebts).plus(unCum.recoveries).plus(unCum.adjustments).minus(unCum.paid).minus(unCum.opening);
  const tin = sumCols(assigned, 'inRange').t;
  const tcum = sumCols(assigned, 'cum').t;
  const colsIn = tin.collected.plus(tin.discounts).plus(tin.badDebts).plus(tin.recoveries).plus(tin.adjustments).minus(tin.paid);
  const colsCum = tcum.collected.plus(tcum.discounts).plus(tcum.badDebts).plus(tcum.recoveries).plus(tcum.adjustments).minus(tcum.paid);
  const owedAtEnd = colsCum.minus(tcum.opening);

  // The GL ties only company-wide: an agency filter leaves the GL fields out.
  const gl = agencyId ? null : {
    movement: await stpMovement(tenantId, companyId, basis, startDate, endDate),
    balance: await stpMovement(tenantId, companyId, basis, null, endDate),
  };
  const otherIn = gl ? gl.movement.minus(colsIn).minus(unassignedIn).minus(roundingIn) : null;
  const otherCum = gl ? gl.balance.minus(colsCum).minus(unassignedCum).minus(roundingCum) : null;

  return {
    ...v1,
    basis,
    agencyId,
    agencies: groups.map((g) => ({
      agencyId: g.agency,
      name: g.agency ? names.agencies.get(g.agency)?.name ?? '' : '',
      items: g.items.map(itemOut),
      totals: totalsOut(g.items),
    })),
    totals: totalsOut(assigned),
    total: m2(tin.collected.plus(tin.discounts).plus(tin.badDebts).plus(tin.recoveries)),
    unassigned: m2(unassignedIn),
    openingPaid: m2(tcum.opening),
    otherEntries: otherIn ? m2(otherIn) : null,
    glMovement: gl ? m2(gl.movement) : null,
    roundingDifference: r6(roundingIn),
    balanceCheck: gl ? {
      stpBalance: m2(gl.balance),
      owedAtEnd: m2(owedAtEnd),
      unassigned: m2(unassignedCum),
      otherEntriesCumulative: m2(otherCum!),
      openingPaid: m2(tcum.opening),
      roundingDifferenceCumulative: r6(roundingCum),
    } : null,
  };
}

/**
 * GET /sales-tax/owed: per agency and item, rows counted on the basis dated
 * on or before asOf + every live adjustment - every live paid and opening
 * line, whatever their date (S1: a payment made after asOf still counts, so
 * tax is never paid twice). The same figure Pay Sales Tax checks.
 */
export async function salesTaxOwed(tenantId: string, companyId: string, asOf: string, opts: LiabilityOptions = {}, executor: DbOrTx = db) {
  // `executor`: Pay Sales Tax reads owed inside its transaction, under the
  // agency lock, on that connection (never a second pool connection).
  const basis = opts.basis ?? await companyBasis(tenantId, companyId, executor);
  const agencyId = opts.agencyId ?? null;
  const names = await loadNames(tenantId, companyId, executor);
  if (agencyId && !names.agencies.has(agencyId)) throw AppError.notFound('Sales tax agency not found');
  const { map } = await buckets(tenantId, companyId, basis, null, asOf, agencyId, true, executor);
  const groups = byAgency(map, names, agencyId);
  const unassigned = [...map.values()].filter((b) => !b.itemId).reduce((s, b) => s.plus(owedOf(b, 'cum')), D0());
  const agencies = groups.map((g) => {
    const items = g.items.map((b) => ({ taxItemId: b.itemId!, name: names.items.get(b.itemId!)?.name ?? '', owed: m2(owedOf(b, 'cum')) }));
    return {
      agencyId: g.agency,
      name: g.agency ? names.agencies.get(g.agency)?.name ?? '' : '',
      items,
      total: m2(g.items.reduce((s, b) => s.plus(owedOf(b, 'cum')), D0())),
    };
  });
  return {
    asOf, basis, agencyId,
    agencies,
    unassigned: m2(unassigned),
    total: m2(groups.flatMap((g) => g.items).reduce((s, b) => s.plus(owedOf(b, 'cum')), D0())),
  };
}

/** GET /reports/sales-tax-payments: payments and linked payments by date. */
export async function buildSalesTaxPaymentsV2(tenantId: string, startDate: string, endDate: string, companyId: string | null, agencyId: string | null = null) {
  const r = await db.execute(sql`
    SELECT l.transaction_id, to_char(t.txn_date, 'YYYY-MM-DD') AS txn_date, t.txn_type, t.txn_number, l.agency_id,
      COALESCE(c.display_name, '') AS agency_name,
      COALESCE(SUM(l.amount) FILTER (WHERE l.kind = 'paid'), 0)::text AS paid,
      COALESCE(SUM(l.amount) FILTER (WHERE l.kind = 'adjustment'), 0)::text AS adjustments
    FROM sales_tax_payment_lines l
    JOIN transactions t ON t.id = l.transaction_id AND t.tenant_id = l.tenant_id AND t.status = 'posted'
    LEFT JOIN sales_tax_agencies ag ON ag.id = l.agency_id AND ag.tenant_id = l.tenant_id
    LEFT JOIN contacts c ON c.id = ag.vendor_id AND c.tenant_id = l.tenant_id
    WHERE l.tenant_id = ${tenantId} AND l.kind IN ('paid', 'adjustment')
      AND ${companyId ? sql`l.company_id = ${companyId}` : sql`TRUE`}
      AND ${agencyId ? sql`l.agency_id = ${agencyId}` : sql`TRUE`}
      AND t.txn_date >= ${startDate} AND t.txn_date <= ${endDate}
    GROUP BY l.transaction_id, t.txn_date, t.txn_type, t.txn_number, l.agency_id, c.display_name
    ORDER BY t.txn_date, t.txn_number NULLS LAST, l.transaction_id`);
  return {
    title: 'Sales Tax Payments', startDate, endDate,
    data: (r.rows as Array<Record<string, any>>).map((x) => ({
      transactionId: x['transaction_id'], txn_date: x['txn_date'], date: x['txn_date'], txnType: x['txn_type'], number: x['txn_number'],
      agencyId: x['agency_id'], agencyName: x['agency_name'],
      total: m2(dec(x['paid'])), paid: m2(dec(x['paid'])), adjustments: m2(dec(x['adjustments'])),
      linked: x['txn_type'] !== 'sales_tax_payment',
    })),
  };
}

/**
 * Q-P23z: what the cash-basis rule corrections of U-152 (Unapplied
 * receipts, write-offs off cash, bill discounts) move in the company's
 * closed periods (on or before its closing date). Report rules only: no
 * posted row changes. Counts and sums per category.
 */
export async function cashBasisSpfDiagnostic(tenantId: string, companyId: string) {
  const co = await db.execute(sql`SELECT to_char(lock_date, 'YYYY-MM-DD') AS d FROM companies WHERE tenant_id = ${tenantId} AND id = ${companyId}`);
  const closing = (co.rows as Array<{ d: string | null }>)[0]?.d ?? null;
  const empty = { count: 0, amount: '0.00' };
  if (!closing) {
    return { companyId, closingDate: null, unappliedReceipts: empty, customerDeposits: empty, writeOffs: empty, billDiscounts: empty };
  }
  const one = async (q: SQL) => {
    const r = (await db.execute(q)).rows as Array<{ n: string; s: string }>;
    return { count: Number(r[0]?.n ?? 0), amount: m2(dec(r[0]?.s)) };
  };
  const unapplied = await one(sql`
    WITH ${arAppsCte(tenantId)},
    rem AS (
      SELECT t.id, SUM(jl.credit - jl.debit) - COALESCE((SELECT SUM(a.amount) FROM ar_apps a WHERE a.payment_id = t.id AND a.kind <> 'credit'), 0) AS r
      FROM transactions t
      JOIN journal_lines jl ON jl.transaction_id = t.id AND jl.tenant_id = t.tenant_id AND jl.is_void_reversal = false
      JOIN accounts ac ON ac.id = jl.account_id AND ac.tenant_id = t.tenant_id AND ac.detail_type = 'accounts_receivable'
      WHERE t.tenant_id = ${tenantId} AND t.company_id = ${companyId} AND t.status = 'posted'
        AND t.txn_type = 'customer_payment' AND t.txn_date <= ${closing}
      GROUP BY t.id
    )
    SELECT COUNT(*) FILTER (WHERE r > 0)::text AS n, COALESCE(SUM(r) FILTER (WHERE r > 0), 0)::text AS s FROM rem`);
  const deposits = await one(sql`
    SELECT COUNT(*)::text AS n, COALESCE(SUM(ABS(jl.credit - jl.debit)), 0)::text AS s
    FROM journal_lines jl
    JOIN transactions t ON t.id = jl.transaction_id AND t.tenant_id = jl.tenant_id
    JOIN accounts ac ON ac.id = jl.account_id AND ac.tenant_id = jl.tenant_id AND ac.system_tag = 'customer_deposits'
    WHERE jl.tenant_id = ${tenantId} AND t.company_id = ${companyId} AND t.status = 'posted' AND jl.is_void_reversal = false
      AND t.txn_type IN ('customer_payment', 'returned_payment', 'customer_refund') AND t.txn_date <= ${closing}`);
  const writeOffs = await one(sql`
    SELECT COUNT(*)::text AS n, COALESCE(SUM(pa.write_off_amount), 0)::text AS s
    FROM payment_applications pa
    JOIN transactions t ON t.id = pa.payment_id AND t.tenant_id = pa.tenant_id AND t.status = 'posted'
    WHERE pa.tenant_id = ${tenantId} AND t.company_id = ${companyId} AND pa.voided_at IS NULL
      AND pa.write_off_amount > 0 AND t.txn_date <= ${closing}`);
  const discounts = await one(sql`
    SELECT COUNT(*)::text AS n, COALESCE(SUM(bpa.discount_amount), 0)::text AS s
    FROM bill_payment_applications bpa
    JOIN transactions t ON t.id = bpa.payment_id AND t.tenant_id = bpa.tenant_id AND t.status = 'posted'
    WHERE bpa.tenant_id = ${tenantId} AND t.company_id = ${companyId} AND bpa.discount_amount > 0 AND t.txn_date <= ${closing}`);
  return { companyId, closingDate: closing, unappliedReceipts: unapplied, customerDeposits: deposits, writeOffs, billDiscounts: discounts };
}
