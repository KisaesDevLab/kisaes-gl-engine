// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * Streamlined Sales Tax (SSUTA) discounts and bad debts (U-153;
 * sales-tax-ssuta-v1, Q-P23m as amended by Q-SPF3 and Q-SPF6).
 *
 * While a company's switch (companies.sales_tax_ssuta, default off) is on,
 * an early-payment discount D and a write-off W on an invoice carry their
 * share of its sales tax:
 *
 *   - per tax item i of the invoice (its sale rows), the settlement's share
 *     is the accrual running total over cash + discount + write-off
 *     (Q-P23e): share_i = round2(T_i x P_k / total) - round2(T_i x P_(k-1) /
 *     total), P = what the invoice had settled before (total - balance due,
 *     so recoveries count) plus this settlement;
 *   - share_i is split over [c, D, W] by largest remainder (allocateCents):
 *     d_i and w_i;
 *   - the payment posts Dr Sales Tax Payable d + w, Dr discount D - d, Dr
 *     write-off W - w, and stores rows kind 'discount' (tax -d_i, base
 *     -round2(D x base_i / total)) and 'bad_debt' (-w_i) with the
 *     application id and the payment date.
 *
 * The switch applies to postings made while it is on (Q-P23w); a bounce
 * and a recovery use the rows stored, never the switch. Discount rows count
 * on both bases, bad-debt and recovery rows on accrual only (the report and
 * the cash virtual ledger, E2). Credit memo applications and credits applied
 * later carry no discount or write-off, so no rows.
 */

import { and, eq, inArray, sql } from 'drizzle-orm';
import DecimalLib from 'decimal.js';
import type { DbOrTx, Tx } from '../db/index.js';
import { companies, transactionTaxLines } from '../db/schema/index.js';
import { allocateCents } from '../utils/sales-compute.js';
import { rowCompanyId } from './sales-tax.service.js';

const BaseDecimal = DecimalLib.default || DecimalLib;
const Decimal = BaseDecimal.clone({ precision: 40, rounding: BaseDecimal.ROUND_HALF_UP });
type DecimalValue = InstanceType<typeof Decimal>;
const D0 = () => new Decimal(0);
const d = (v: unknown) => new Decimal(v === null || v === undefined || v === '' ? '0' : String(v));
/** round2 half away from zero (decimal.js ROUND_HALF_UP rounds away from zero). */
const r2 = (x: DecimalValue) => x.toDecimalPlaces(2, BaseDecimal.ROUND_HALF_UP);
export const m2 = (x: DecimalValue) => r2(x).toFixed(2);

/** The company's SSUTA switch (Q-SPF6: off unless turned on). */
export async function ssutaOn(executor: DbOrTx, tenantId: string, companyId: string | null | undefined): Promise<boolean> {
  const co = await rowCompanyId(executor, tenantId, companyId);
  if (!co) return false;
  const [row] = await executor.select({ on: companies.salesTaxSsuta }).from(companies)
    .where(and(eq(companies.tenantId, tenantId), eq(companies.id, co))).limit(1);
  return row?.on === true;
}

/** One tax item of an invoice: its sale rows summed (non-taxable code rows carry no tax and are left out). */
export interface InvoiceTaxItem {
  salesTaxId: string | null;
  taxItemId: string | null;
  agencyId: string | null;
  rate: string | null;
  base: DecimalValue;
  tax: DecimalValue;
}

/** The sale rows of invoices with tax, per invoice and item (setup order of the rows). */
export async function invoiceTaxItems(executor: DbOrTx, tenantId: string, invoiceIds: string[]): Promise<Map<string, InvoiceTaxItem[]>> {
  const out = new Map<string, InvoiceTaxItem[]>();
  const ids = [...new Set(invoiceIds)];
  if (ids.length === 0) return out;
  const res = await executor.execute(sql`
    SELECT r.transaction_id, r.sales_tax_id, r.tax_item_id, r.agency_id, r.rate::text AS rate,
      SUM(r.base)::text AS base, SUM(r.tax)::text AS tax, MIN(r.created_at) AS first_at, MIN(r.id::text) AS first_id
    FROM transaction_tax_lines r
    WHERE r.tenant_id = ${tenantId} AND r.kind = 'sale' AND r.tax_code_id IS NULL
      AND r.transaction_id IN (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})
    GROUP BY r.transaction_id, r.sales_tax_id, r.tax_item_id, r.agency_id, r.rate
    ORDER BY r.transaction_id, first_at, first_id`);
  for (const row of res.rows as Array<Record<string, string | null>>) {
    const tax = d(row['tax']);
    if (tax.isZero()) continue;
    const id = String(row['transaction_id']);
    out.set(id, [...(out.get(id) ?? []), {
      salesTaxId: row['sales_tax_id'] ?? null, taxItemId: row['tax_item_id'] ?? null, agencyId: row['agency_id'] ?? null,
      rate: row['rate'] ?? null, base: d(row['base']), tax,
    }]);
  }
  return out;
}

/** One item's tax share of a settlement's discount and write-off. */
export interface ShareRow { item: InvoiceTaxItem; discountTax: DecimalValue; writeOffTax: DecimalValue; discountBase: DecimalValue; writeOffBase: DecimalValue }
export interface SettlementShares { discountTax: DecimalValue; writeOffTax: DecimalValue; rows: ShareRow[] }

export const NO_SHARES: SettlementShares = { discountTax: D0(), writeOffTax: D0(), rows: [] };

/**
 * The tax shares of one settlement (pure): cash c, discount D, write-off W
 * against an invoice of `total` that had settled `settledBefore` already.
 */
export function settlementShares(
  items: readonly InvoiceTaxItem[], total: DecimalValue, settledBefore: DecimalValue,
  c: DecimalValue, discount: DecimalValue, writeOff: DecimalValue,
): SettlementShares {
  const s = c.plus(discount).plus(writeOff);
  if (!discount.greaterThan(0) && !writeOff.greaterThan(0)) return NO_SHARES;
  if (total.isZero() || !s.greaterThan(0)) return NO_SHARES;
  const rows: ShareRow[] = [];
  let dt = D0();
  let wt = D0();
  for (const item of items) {
    const share = r2(item.tax.times(settledBefore.plus(s)).dividedBy(total)).minus(r2(item.tax.times(settledBefore).dividedBy(total)));
    const abs = share.abs();
    let parts = [D0(), D0(), D0()];
    if (!abs.isZero()) parts = allocateCents([c, discount, writeOff].map((x) => x.times(abs).dividedBy(s)), abs);
    const sign = share.isNegative() ? -1 : 1;
    const di = parts[1]!.times(sign);
    const wi = parts[2]!.times(sign);
    dt = dt.plus(di);
    wt = wt.plus(wi);
    rows.push({
      item, discountTax: di, writeOffTax: wi,
      discountBase: r2(discount.times(item.base).dividedBy(total)), writeOffBase: r2(writeOff.times(item.base).dividedBy(total)),
    });
  }
  return { discountTax: dt, writeOffTax: wt, rows };
}

/** The shares of a settlement on a (locked) invoice row, or none when the switch is off. */
export async function sharesFor(
  executor: DbOrTx, tenantId: string, on: boolean,
  inv: { id: string; total: string | null; amountPaid: string | null }, c: DecimalValue, discount: DecimalValue, writeOff: DecimalValue,
  items?: Map<string, InvoiceTaxItem[]>,
): Promise<SettlementShares> {
  if (!on || (!discount.greaterThan(0) && !writeOff.greaterThan(0))) return NO_SHARES;
  const list = (items ?? await invoiceTaxItems(executor, tenantId, [inv.id])).get(inv.id) ?? [];
  return settlementShares(list, d(inv.total), d(inv.amountPaid), c, discount, writeOff);
}

/** Writes a settlement's discount and bad-debt rows (tax signed by liability effect: negative). */
export async function writeShareRows(
  tx: Tx, tenantId: string, companyId: string | null | undefined, txnId: string, applicationId: string, invoiceId: string,
  eventDate: string, shares: SettlementShares,
): Promise<void> {
  const co = await rowCompanyId(tx, tenantId, companyId);
  if (!co || shares.rows.length === 0) return;
  const values: Array<typeof transactionTaxLines.$inferInsert> = [];
  for (const r of shares.rows) {
    const base = { tenantId, companyId: co, transactionId: txnId, eventDate, salesTaxId: r.item.salesTaxId, taxItemId: r.item.taxItemId,
      agencyId: r.item.agencyId, invoiceId, applicationId, rate: r.item.rate };
    if (!r.discountTax.isZero()) values.push({ ...base, kind: 'discount', base: r.discountBase.negated().toFixed(4), tax: r.discountTax.negated().toFixed(4) });
    if (!r.writeOffTax.isZero()) values.push({ ...base, kind: 'bad_debt', base: r.writeOffBase.negated().toFixed(4), tax: r.writeOffTax.negated().toFixed(4) });
  }
  if (values.length) await tx.insert(transactionTaxLines).values(values);
}

/** Drops a transaction's SSUTA rows (a payment edit rewrites them). */
export async function deleteShareRows(tx: Tx, tenantId: string, txnId: string): Promise<void> {
  await tx.delete(transactionTaxLines).where(and(eq(transactionTaxLines.tenantId, tenantId), eq(transactionTaxLines.transactionId, txnId),
    inArray(transactionTaxLines.kind, ['discount', 'bad_debt'])));
}

export type StoredRow = typeof transactionTaxLines.$inferSelect;

/** The SSUTA rows stored for applications on their own transactions (by application id): d and w as positive amounts, and the rows. */
export async function storedShares(executor: DbOrTx, tenantId: string, applicationIds: string[], txnIds: string[]) {
  const out = new Map<string, { discountTax: DecimalValue; writeOffTax: DecimalValue; rows: StoredRow[] }>();
  if (applicationIds.length === 0 || txnIds.length === 0) return out;
  const rows = await executor.select().from(transactionTaxLines).where(and(eq(transactionTaxLines.tenantId, tenantId),
    inArray(transactionTaxLines.applicationId, [...new Set(applicationIds)]),
    inArray(transactionTaxLines.transactionId, [...new Set(txnIds)]), inArray(transactionTaxLines.kind, ['discount', 'bad_debt'])))
    .orderBy(transactionTaxLines.createdAt, transactionTaxLines.id);
  for (const r of rows) {
    const e = out.get(r.applicationId!) ?? { discountTax: D0(), writeOffTax: D0(), rows: [] };
    if (r.kind === 'discount') e.discountTax = e.discountTax.minus(d(r.tax));
    else e.writeOffTax = e.writeOffTax.minus(d(r.tax));
    e.rows.push(r);
    out.set(r.applicationId!, e);
  }
  return out;
}

/** A bounce's mirror rows: the stored rows negated, on the returned_payment at the bounce date. */
export async function writeMirrorRows(tx: Tx, tenantId: string, returnId: string, eventDate: string, rows: StoredRow[]): Promise<void> {
  if (rows.length === 0) return;
  await tx.insert(transactionTaxLines).values(rows.map((r) => ({
    tenantId, companyId: r.companyId, transactionId: returnId, kind: r.kind, eventDate, salesTaxId: r.salesTaxId, taxItemId: r.taxItemId,
    agencyId: r.agencyId, taxCodeId: r.taxCodeId, invoiceId: r.invoiceId, applicationId: r.applicationId, rate: r.rate,
    base: d(r.base).negated().toFixed(4), tax: d(r.tax).negated().toFixed(4),
  })));
}
