// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

/**
 * A/P open items as of a date (U-121 A/P half; ap-aging-exact-v1,
 * open-balances-asof-v1). The A/P twin of ar-open-items.ts.
 *
 * Built from the ledger, not from bill headers, so a vendor's items always
 * add up to its A/P balance on the date (A/P lines by COALESCE(line
 * contact, transaction contact), credit - debit):
 *
 *   1. Items: every posted transaction dated on or before asOf with A/P
 *      lines, per vendor and transaction; open = Σ(credit - debit). A bill
 *      is positive; a vendor credit or the A/P debit of a bill payment is
 *      negative.
 *   2. Moves (each nets to zero per vendor). The application tables carry
 *      no date of their own, so an application is dated by its bill
 *      payment; a void deletes the rows, so a voided payment never counts:
 *        - bill_payment_applications: amount + discount_amount moves from
 *          the payment to the bill, in effect when the payment and the bill
 *          are posted and GREATEST(payment date, bill date) <= asOf;
 *        - vendor_credit_applications: amount moves from the vendor credit
 *          to the bill (the payment's own A/P lines already net the credit
 *          part), in effect when payment, credit and bill are posted and
 *          GREATEST(payment, credit, bill date) <= asOf;
 *        - deposit_lines whose source is a vendor credit (a vendor refund,
 *          U-54): amount moves from the deposit's A/P item to the credit,
 *          in effect when the deposit is posted and GREATEST(deposit date,
 *          credit date) <= asOf.
 *   3. Items whose exact open is zero are dropped. Every figure is exact
 *      (unrounded Decimal at the stored scale); totals are Decimal sums.
 *
 * Company scope is strict (t.company_id = companyId), as the Trial Balance
 * and the other A/P reports, so the total ties to the A/P account.
 */

import { sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/index.js';
import { ReportDecimal as Decimal, dec, exactStr, type Dec } from './report-exact.js';
import { bucketFor, daysBetween, type AgingBucketKey } from './ar-open-items.js';

export type ApOpenItemKind = 'bill' | 'credit' | 'charge' | 'other';

export interface ApOpenItem {
  /** null: A/P lines with no vendor (shown as "(no vendor)"). */
  contactId: string | null;
  txnId: string;
  txnType: string;
  number: string | null;
  vendorInvoiceNumber: string | null;
  date: string;
  /** Bills: the due date, else the bill date. Others: null. */
  dueDate: string | null;
  /** The transaction's own A/P amount for the vendor (credit positive), exact. */
  originalExact: string;
  /** Open as of asOf, exact. */
  openExact: string;
  /** Bills: cash paid, discounts taken and vendor credits applied as of asOf, exact. Others: "0.0000". */
  paidExact: string;
  discountExact: string;
  creditsExact: string;
  kind: ApOpenItemKind;
}

export interface ApOpenItemsQuery {
  tenantId: string;
  companyId?: string | null;
  asOf: string;
  contactIds?: string[];
  /** Header-level tag filter (ADR §5.2): keep items whose transaction has a line with one of these tags. */
  tagIds?: string[];
}

interface Work {
  contactId: string | null;
  txnId: string;
  txnType: string;
  number: string | null;
  vendorInvoiceNumber: string | null;
  date: string;
  dueDate: string | null;
  original: Dec;
  open: Dec;
  paid: Dec;
  discount: Dec;
  credits: Dec;
}

function kindOf(txnType: string, open: Dec): ApOpenItemKind {
  if (txnType === 'bill') return 'bill';
  if (txnType === 'vendor_credit' || txnType === 'bill_payment') return 'credit';
  if (txnType === 'deposit') return 'charge';
  return open.isNegative() ? 'credit' : 'other';
}

const ids = (list: string[]) => sql.join(list.map((id) => sql`${id}::uuid`), sql`, `);

/**
 * The open A/P items as of `asOf` (see the module comment), ordered by
 * vendor, then date, then number, then id.
 */
export async function apOpenItemsAsOf(executor: DbOrTx, q: ApOpenItemsQuery): Promise<ApOpenItem[]> {
  const { tenantId, asOf } = q;
  const scope = q.companyId ? sql`AND t.company_id = ${q.companyId}` : sql``;
  const contactFilter = q.contactIds && q.contactIds.length > 0
    ? sql`AND COALESCE(jl.contact_id, t.contact_id) IN (${ids(q.contactIds)})`
    : sql``;

  // 1. Items from the ledger.
  const itemRes = await executor.execute(sql`
    SELECT COALESCE(jl.contact_id, t.contact_id) AS contact_id, t.contact_id AS txn_contact_id, t.id, t.txn_type,
      t.txn_number, t.reference_number, t.vendor_invoice_number,
      to_char(t.txn_date, 'YYYY-MM-DD') AS date, to_char(t.due_date, 'YYYY-MM-DD') AS due_date,
      SUM(jl.credit - jl.debit)::numeric(19,4)::text AS open
    FROM journal_lines jl
    JOIN transactions t ON t.id = jl.transaction_id AND t.tenant_id = jl.tenant_id
    JOIN accounts a ON a.id = jl.account_id AND a.tenant_id = jl.tenant_id
    WHERE jl.tenant_id = ${tenantId} AND t.status = 'posted' AND a.system_tag = 'accounts_payable'
      AND t.txn_date <= ${asOf}::date ${scope} ${contactFilter}
    GROUP BY 1, t.id
  `);
  const items = new Map<string, Work>();
  const byTxn = new Map<string, Work>();
  const allByTxn = new Map<string, Work[]>();
  const keyOf = (contactId: string | null, txnId: string) => `${contactId ?? ''}|${txnId}`;
  for (const r of itemRes.rows as Array<Record<string, unknown>>) {
    const contactId = (r['contact_id'] as string | null) ?? null;
    const txnType = String(r['txn_type']);
    const open = dec(String(r['open'] ?? '0'));
    const w: Work = {
      contactId,
      txnId: String(r['id']),
      txnType,
      number: (r['txn_number'] as string | null) ?? (r['reference_number'] as string | null) ?? null,
      vendorInvoiceNumber: (r['vendor_invoice_number'] as string | null) ?? null,
      date: String(r['date']),
      dueDate: txnType === 'bill' ? ((r['due_date'] as string | null) ?? String(r['date'])) : null,
      original: open,
      open,
      paid: new Decimal(0),
      discount: new Decimal(0),
      credits: new Decimal(0),
    };
    items.set(keyOf(contactId, w.txnId), w);
    allByTxn.set(w.txnId, [...(allByTxn.get(w.txnId) ?? []), w]);
    // With several A/P vendors on one transaction (a journal entry), its
    // primary item is the transaction's own vendor's, else the first seen.
    const txnContactId = (r['txn_contact_id'] as string | null) ?? null;
    const prev = byTxn.get(w.txnId);
    if (!prev || (w.contactId === txnContactId && prev.contactId !== txnContactId)) byTxn.set(w.txnId, w);
  }
  if (items.size === 0) return [];

  // 2. Moves in effect on asOf.
  const moveRes = await executor.execute(sql`
    SELECT 'payment' AS kind, bpa.payment_id AS source_id, bpa.bill_id AS target_id,
      bpa.amount::text AS cash, bpa.discount_amount::text AS discount
    FROM bill_payment_applications bpa
    JOIN transactions p ON p.id = bpa.payment_id AND p.tenant_id = bpa.tenant_id AND p.status = 'posted'
    JOIN transactions b ON b.id = bpa.bill_id AND b.tenant_id = bpa.tenant_id AND b.status = 'posted'
    WHERE bpa.tenant_id = ${tenantId} AND GREATEST(p.txn_date, b.txn_date) <= ${asOf}::date
    UNION ALL
    SELECT 'credit', vca.credit_id, vca.bill_id, vca.amount::text, '0'
    FROM vendor_credit_applications vca
    JOIN transactions p ON p.id = vca.payment_id AND p.tenant_id = vca.tenant_id AND p.status = 'posted'
    JOIN transactions c ON c.id = vca.credit_id AND c.tenant_id = vca.tenant_id AND c.status = 'posted'
    JOIN transactions b ON b.id = vca.bill_id AND b.tenant_id = vca.tenant_id AND b.status = 'posted'
    WHERE vca.tenant_id = ${tenantId} AND GREATEST(p.txn_date, c.txn_date, b.txn_date) <= ${asOf}::date
    UNION ALL
    SELECT 'refund', dl.deposit_id, dl.source_transaction_id, dl.amount::text, '0'
    FROM deposit_lines dl
    JOIN transactions d ON d.id = dl.deposit_id AND d.tenant_id = ${tenantId} AND d.status = 'posted'
    JOIN transactions c ON c.id = dl.source_transaction_id AND c.tenant_id = ${tenantId}
      AND c.status = 'posted' AND c.txn_type = 'vendor_credit'
    WHERE GREATEST(d.txn_date, c.txn_date) <= ${asOf}::date
  `);
  for (const r of moveRes.rows as Array<Record<string, unknown>>) {
    let src = byTxn.get(String(r['source_id']));
    let dst = byTxn.get(String(r['target_id']));
    // Both ends are items unless one was filtered out (by vendor, or dated
    // after asOf, which the SQL already excludes).
    if (!src || !dst) continue;
    if (src.contactId !== dst.contactId) {
      const s0 = src;
      const d0 = dst;
      const pairDst = allByTxn.get(d0.txnId)!.find((x) => x.contactId === s0.contactId);
      const pairSrc = allByTxn.get(s0.txnId)!.find((x) => x.contactId === d0.contactId);
      if (pairDst) dst = pairDst;
      else if (pairSrc) src = pairSrc;
    }
    const cash = dec(String(r['cash'] ?? '0'));
    const discount = dec(String(r['discount'] ?? '0'));
    const settled = cash.plus(discount);
    const kind = String(r['kind']);
    if (kind === 'refund') {
      // The refund deposit's A/P credit uses up the vendor credit.
      dst.open = dst.open.plus(settled);
      src.open = src.open.minus(settled);
      continue;
    }
    dst.open = dst.open.minus(settled);
    src.open = src.open.plus(settled);
    if (kind === 'payment') {
      dst.paid = dst.paid.plus(cash);
      dst.discount = dst.discount.plus(discount);
    } else {
      dst.credits = dst.credits.plus(cash);
    }
  }

  // 3. Tag filter, zero items dropped.
  let tagged: Set<string> | null = null;
  if (q.tagIds && q.tagIds.length > 0) {
    const txnIds = [...new Set([...items.values()].map((w) => w.txnId))];
    const res = await executor.execute(sql`
      SELECT DISTINCT jl.transaction_id AS id FROM journal_lines jl
      WHERE jl.tenant_id = ${tenantId} AND jl.tag_id IN (${ids(q.tagIds)})
        AND jl.transaction_id IN (${ids(txnIds)})
    `);
    tagged = new Set((res.rows as Array<{ id: string }>).map((r) => String(r.id)));
  }
  const out: ApOpenItem[] = [];
  for (const w of items.values()) {
    if (tagged && !tagged.has(w.txnId)) continue;
    if (w.open.isZero()) continue;
    out.push({
      contactId: w.contactId,
      txnId: w.txnId,
      txnType: w.txnType,
      number: w.number,
      vendorInvoiceNumber: w.vendorInvoiceNumber,
      date: w.date,
      dueDate: w.dueDate,
      originalExact: exactStr(w.original),
      openExact: exactStr(w.open),
      paidExact: exactStr(w.paid),
      discountExact: exactStr(w.discount),
      creditsExact: exactStr(w.credits),
      kind: kindOf(w.txnType, w.open),
    });
  }
  out.sort((a, b) => (a.contactId ?? '').localeCompare(b.contactId ?? '') || a.date.localeCompare(b.date)
    || (a.number ?? '').localeCompare(b.number ?? '') || a.txnId.localeCompare(b.txnId));
  return out;
}

export interface ExactBuckets { current: string; days1to30: string; days31to60: string; days61to90: string; over90: string }

export interface ExactAgedItem { days: number; bucket: AgingBucketKey }

/**
 * Exact aging of open items (A/R or A/P) as of `asOf`: days = asOf - (due
 * date, else date); buckets current (<= 0), 1-30, 31-60, 61-90, over 90
 * (Q-105). Bucket and total figures are unrounded Decimal sums of the
 * items' openExact.
 */
export function ageExact<T extends { dueDate: string | null; date: string; openExact: string }>(items: T[], asOf: string) {
  const sums: Record<AgingBucketKey, Dec> = {
    current: new Decimal(0), days1to30: new Decimal(0), days31to60: new Decimal(0), days61to90: new Decimal(0), over90: new Decimal(0),
  };
  let total = new Decimal(0);
  const aged = items.map((it) => {
    const days = daysBetween(it.dueDate ?? it.date, asOf);
    const bucket = bucketFor(days);
    sums[bucket] = sums[bucket].plus(it.openExact);
    total = total.plus(it.openExact);
    return { ...it, days, bucket };
  });
  const buckets: ExactBuckets = {
    current: exactStr(sums.current), days1to30: exactStr(sums.days1to30), days31to60: exactStr(sums.days31to60),
    days61to90: exactStr(sums.days61to90), over90: exactStr(sums.over90),
  };
  return { items: aged, buckets, totalExact: exactStr(total) };
}
