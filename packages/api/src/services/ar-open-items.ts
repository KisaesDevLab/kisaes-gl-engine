// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * A/R open items as of a date (U-142, U-121 A/R half; ar-open-items-asof-v1).
 *
 * Built from the ledger, not from document headers, so the items of a
 * client always add up to its A/R balance (contacts.service getBalances'
 * definition: posted transactions, A/R lines by COALESCE(line contact,
 * transaction contact)):
 *
 *   1. Items: every posted transaction dated on or before asOf with A/R
 *      lines, per client and transaction; open = Σ(debit - credit).
 *   2. Moves: every application in effect on asOf moves its settled amount
 *      (cash or credit + discount + write-off) from its source's item to its
 *      invoice's item. In effect: not voided; GREATEST(applied date or the
 *      source's date, the source's date, the invoice's date) <= asOf; not
 *      reversed, or reversed by a bounce dated after asOf. Legacy payments
 *      that only carry applied_to_invoice_id (no application rows) move
 *      their total the same way. Moves net to zero per client.
 *   3. Display netting (never changes a client's total): a live refund drawn
 *      on a payment or credit memo nets into that source; a Stripe refund
 *      pointing at an invoice nets onto the invoice; a bounced payment, its
 *      returned_payment and the draws on a bounced held deposit net away
 *      when they add up to zero.
 *   4. Each item shows round2 half up of its exact open; zero items are
 *      dropped. Totals are exact sums; the cent figures may differ from them
 *      only by legacy sub-cent residue (`difference`).
 *
 * Holds have no A/R line; a draw's A/R credit is moved by its own
 * applications. Unapplies and payment edits are undated (Q-P22i): a voided
 * application row is never in effect.
 */

import { sql } from 'drizzle-orm';
import DecimalLib from 'decimal.js';
import type { DbOrTx } from '../db/index.js';

const Decimal = DecimalLib.default || DecimalLib;
type DecimalValue = InstanceType<typeof Decimal>;

export type OpenItemKind = 'invoice' | 'credit' | 'charge' | 'other';

export interface OpenItem {
  /** null: A/R lines with no client (shown as "(no client)"). */
  contactId: string | null;
  txnId: string;
  txnType: string;
  number: string | null;
  date: string;
  /** Invoices: the due date, else the invoice date. Others: null. */
  dueDate: string | null;
  /** The transaction's own A/R amount for the client (debit positive), 2 places. */
  original: string;
  /** Open as of asOf, round2 half up, 2 places (never 0.00). */
  open: string;
  /** Open as of asOf, exact (4 places). */
  openExact: string;
  kind: OpenItemKind;
  /** U-141: true for a finance-charge invoice. */
  isFinanceCharge: boolean;
}

export interface OpenItemsQuery {
  tenantId: string;
  companyId?: string | null;
  asOf: string;
  contactIds?: string[];
  /** Header-level tag filter (ADR §5.2): keep items whose transaction has a line with one of these tags. */
  tagIds?: string[];
}

const ZERO = () => new Decimal(0);
const r2 = (d: DecimalValue) => d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

interface Work {
  contactId: string | null;
  txnId: string;
  txnType: string;
  number: string | null;
  date: string;
  dueDate: string | null;
  original: DecimalValue;
  open: DecimalValue;
  sourceTxnId: string | null;
  sourcePaymentId: string | null;
  appliedToInvoiceId: string | null;
  fromDepositId: string | null;
  isFinanceCharge: boolean;
}

function kindOf(txnType: string, open: DecimalValue): OpenItemKind {
  if (txnType === 'invoice') return 'invoice';
  if (txnType === 'credit_memo' || txnType === 'customer_payment') return 'credit';
  if (txnType === 'returned_payment' || txnType === 'customer_refund') return 'charge';
  return open.isNegative() ? 'credit' : 'other';
}

/**
 * The open A/R items as of `asOf` (see the module comment), ordered by
 * client, then date, then number, then id.
 */
export async function arOpenItemsAsOf(executor: DbOrTx, q: OpenItemsQuery): Promise<OpenItem[]> {
  const { tenantId, asOf } = q;
  const scope = q.companyId ? sql`AND (t.company_id = ${q.companyId} OR t.company_id IS NULL)` : sql``;
  const contactFilter = q.contactIds && q.contactIds.length > 0
    ? sql`AND COALESCE(jl.contact_id, t.contact_id) IN (${sql.join(q.contactIds.map((id) => sql`${id}::uuid`), sql`, `)})`
    : sql``;

  // 1. Items from the ledger.
  const itemRes = await executor.execute(sql`
    SELECT COALESCE(jl.contact_id, t.contact_id) AS contact_id, t.id, t.txn_type, t.txn_number, t.reference_number,
      to_char(t.txn_date, 'YYYY-MM-DD') AS date, to_char(t.due_date, 'YYYY-MM-DD') AS due_date,
      t.source_txn_id, t.source_payment_id, t.applied_to_invoice_id, t.from_deposit_id,
      false AS is_finance_charge,
      SUM(jl.debit - jl.credit)::numeric(19,4)::text AS open
    FROM journal_lines jl
    JOIN transactions t ON t.id = jl.transaction_id AND t.tenant_id = jl.tenant_id
    JOIN accounts a ON a.id = jl.account_id AND a.tenant_id = jl.tenant_id
    WHERE jl.tenant_id = ${tenantId} AND t.status = 'posted' AND a.system_tag = 'accounts_receivable'
      AND t.txn_date <= ${asOf}::date ${scope} ${contactFilter}
    GROUP BY 1, t.id
  `);
  const items = new Map<string, Work>();
  const byTxn = new Map<string, Work>();
  const keyOf = (contactId: string | null, txnId: string) => `${contactId ?? ''}|${txnId}`;
  for (const r of itemRes.rows as Array<Record<string, unknown>>) {
    const contactId = (r['contact_id'] as string | null) ?? null;
    const txnType = String(r['txn_type']);
    const open = new Decimal(String(r['open'] ?? '0'));
    const w: Work = {
      contactId,
      txnId: String(r['id']),
      txnType,
      number: (r['txn_number'] as string | null) ?? (r['reference_number'] as string | null) ?? null,
      date: String(r['date']),
      dueDate: txnType === 'invoice' ? ((r['due_date'] as string | null) ?? String(r['date'])) : null,
      original: open,
      open,
      sourceTxnId: (r['source_txn_id'] as string | null) ?? null,
      sourcePaymentId: (r['source_payment_id'] as string | null) ?? null,
      appliedToInvoiceId: (r['applied_to_invoice_id'] as string | null) ?? null,
      fromDepositId: (r['from_deposit_id'] as string | null) ?? null,
      isFinanceCharge: r['is_finance_charge'] === true,
    };
    items.set(keyOf(contactId, w.txnId), w);
    // A transaction normally has one A/R client; with several (a journal
    // entry), moves use the one of the transaction's own client.
    if (!byTxn.has(w.txnId) || w.contactId === null) byTxn.set(w.txnId, w);
  }
  if (items.size === 0) return [];

  // 2. Moves of the applications in effect on asOf (and legacy pointer payments).
  const moveRes = await executor.execute(sql`
    SELECT pa.payment_id AS source_id, pa.invoice_id,
      (pa.amount + pa.discount_amount + pa.write_off_amount)::text AS settled
    FROM payment_applications pa
    JOIN transactions s ON s.id = pa.payment_id AND s.tenant_id = pa.tenant_id AND s.status = 'posted'
    JOIN transactions i ON i.id = pa.invoice_id AND i.tenant_id = pa.tenant_id AND i.status = 'posted'
    WHERE pa.tenant_id = ${tenantId} AND pa.voided_at IS NULL
      AND GREATEST(COALESCE(pa.applied_date, s.txn_date), s.txn_date, i.txn_date) <= ${asOf}::date
      AND (pa.reversed_by_txn_id IS NULL OR EXISTS (
        SELECT 1 FROM transactions rp WHERE rp.id = pa.reversed_by_txn_id AND rp.tenant_id = pa.tenant_id
          AND rp.status = 'posted' AND rp.txn_date > ${asOf}::date))
    UNION ALL
    SELECT tp.id, tp.applied_to_invoice_id, tp.total::text
    FROM transactions tp
    JOIN transactions i ON i.id = tp.applied_to_invoice_id AND i.tenant_id = tp.tenant_id AND i.status = 'posted'
    WHERE tp.tenant_id = ${tenantId} AND tp.txn_type = 'customer_payment' AND tp.status = 'posted'
      AND tp.applied_to_invoice_id IS NOT NULL AND tp.total IS NOT NULL
      AND GREATEST(tp.txn_date, i.txn_date) <= ${asOf}::date
      AND NOT EXISTS (SELECT 1 FROM payment_applications pa2 WHERE pa2.tenant_id = tp.tenant_id AND pa2.payment_id = tp.id)
  `);
  for (const r of moveRes.rows as Array<Record<string, unknown>>) {
    const src = byTxn.get(String(r['source_id']));
    const inv = byTxn.get(String(r['invoice_id']));
    // Both ends are in the item set unless one was filtered out by client
    // (a move between two clients' items never happens: the source and the
    // invoice belong to one client).
    if (!src || !inv) continue;
    const settled = new Decimal(String(r['settled'] ?? '0'));
    inv.open = inv.open.minus(settled);
    src.open = src.open.plus(settled);
  }

  // 3. Display netting.
  const drop = (w: Work) => { items.delete(keyOf(w.contactId, w.txnId)); };
  for (const w of [...items.values()]) {
    if (w.txnType !== 'customer_refund') continue;
    const target = w.sourcePaymentId ? byTxn.get(w.sourcePaymentId) : w.appliedToInvoiceId ? byTxn.get(w.appliedToInvoiceId) : undefined;
    if (target && target !== w && target.contactId === w.contactId && items.has(keyOf(target.contactId, target.txnId))) {
      target.open = target.open.plus(w.open);
      drop(w);
    }
  }
  for (const w of [...items.values()]) {
    if (w.txnType !== 'returned_payment' || !w.sourceTxnId) continue;
    const group = [...items.values()].filter((x) => x.contactId === w.contactId
      && (x === w || x.txnId === w.sourceTxnId || (x.txnType === 'customer_payment' && x.fromDepositId === w.sourceTxnId)));
    const sum = group.reduce((s, x) => s.plus(x.open), ZERO());
    if (group.length > 1 && sum.isZero()) group.forEach(drop);
  }

  // 4. Cent figures; zero items dropped.
  let tagged: Set<string> | null = null;
  if (q.tagIds && q.tagIds.length > 0) {
    const ids = [...items.values()].map((w) => w.txnId);
    const res = ids.length === 0 ? { rows: [] } : await executor.execute(sql`
      SELECT DISTINCT jl.transaction_id AS id FROM journal_lines jl
      WHERE jl.tenant_id = ${tenantId} AND jl.tag_id IN (${sql.join(q.tagIds.map((id) => sql`${id}::uuid`), sql`, `)})
        AND jl.transaction_id IN (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})
    `);
    tagged = new Set((res.rows as Array<{ id: string }>).map((r) => String(r.id)));
  }
  const out: OpenItem[] = [];
  for (const w of items.values()) {
    if (tagged && !tagged.has(w.txnId)) continue;
    const cents = r2(w.open);
    if (cents.isZero()) continue;
    out.push({
      contactId: w.contactId,
      txnId: w.txnId,
      txnType: w.txnType,
      number: w.number,
      date: w.date,
      dueDate: w.dueDate,
      original: r2(w.original).toFixed(2),
      open: cents.toFixed(2),
      openExact: w.open.toFixed(4),
      kind: kindOf(w.txnType, w.open),
      isFinanceCharge: w.isFinanceCharge,
    });
  }
  out.sort((a, b) => (a.contactId ?? '').localeCompare(b.contactId ?? '') || a.date.localeCompare(b.date)
    || (a.number ?? '').localeCompare(b.number ?? '') || a.txnId.localeCompare(b.txnId));
  return out;
}

export interface AgingBuckets { current: string; days1to30: string; days31to60: string; days61to90: string; over90: string }
export type AgingBucketKey = keyof AgingBuckets;

export interface AgedItem extends OpenItem { days: number; bucket: AgingBucketKey }

export interface Aging {
  items: AgedItem[];
  /** Σ of the items' cent figures per bucket (2 places). */
  buckets: AgingBuckets;
  /** Σ of the items' cent figures. */
  total: string;
  /** Exact Σ of the items' open (4 places). */
  totalExact: string;
  /** totalExact - total, 2 places after round2 of the exact total; 0.00 except with legacy sub-cent residue. */
  difference: string;
}

/** Whole days from `from` to `to` (calendar dates, UTC). */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86400000);
}

export function bucketFor(days: number): AgingBucketKey {
  if (days <= 0) return 'current';
  if (days <= 30) return 'days1to30';
  if (days <= 60) return 'days31to60';
  if (days <= 90) return 'days61to90';
  return 'over90';
}

/**
 * Ages open items as of `asOf`: days = asOf - (dueDate, else date); credits
 * and other items age by their own date. Buckets: current (<= 0), 1-30,
 * 31-60, 61-90, over 90. Exact Decimal sums.
 */
export function ageOpenItems(items: OpenItem[], asOf: string): Aging {
  const sums: Record<AgingBucketKey, DecimalValue> = {
    current: ZERO(), days1to30: ZERO(), days31to60: ZERO(), days61to90: ZERO(), over90: ZERO(),
  };
  let exact = ZERO();
  const aged = items.map((it) => {
    const days = daysBetween(it.dueDate ?? it.date, asOf);
    const bucket = bucketFor(days);
    sums[bucket] = sums[bucket].plus(it.open);
    exact = exact.plus(it.openExact);
    return { ...it, days, bucket };
  });
  const total = Object.values(sums).reduce((s, x) => s.plus(x), ZERO());
  return {
    items: aged,
    buckets: {
      current: sums.current.toFixed(2), days1to30: sums.days1to30.toFixed(2), days31to60: sums.days31to60.toFixed(2),
      days61to90: sums.days61to90.toFixed(2), over90: sums.over90.toFixed(2),
    },
    total: total.toFixed(2),
    totalExact: exact.toFixed(4),
    difference: r2(exact).minus(total).toFixed(2),
  };
}
