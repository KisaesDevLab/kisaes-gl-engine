// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

/**
 * As-of open balances for the exact reports (U-121 A/P half and as-of
 * balances; ap-aging-exact-v1, open-balances-asof-v1; ClientLedger P28
 * PR-D). Only the `?exact=1` routes use these builders; the legacy
 * responses keep their own builders and shapes.
 *
 * Every figure comes from the open-item helpers (ar-open-items.ts,
 * ap-open-items.ts): a document is open as of a date by the payments,
 * credits, discounts and refunds dated on or before it (Q-307), so a past
 * date shows what was really owed then, and each report's total equals
 * the A/R or A/P account balance on that date. All amounts are exact
 * decimal strings; every total is a Decimal sum of its rows.
 */

import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { arOpenItemsAsOf, type OpenItem } from './ar-open-items.js';
import { apOpenItemsAsOf, ageExact, type ApOpenItem, type ExactBuckets } from './ap-open-items.js';
import { ReportDecimal as Decimal, dec, dsum, exactStr, legacyNum, type Dec } from './report-exact.js';

const NO_CLIENT = '(no client)';
const NO_VENDOR = '(no vendor)';

const splitIds = (tagId: string | null | undefined) =>
  tagId ? tagId.split(',').map((s) => s.trim()).filter(Boolean) : undefined;

async function contactNames(tenantId: string, contactIds: Array<string | null>): Promise<Map<string, string>> {
  const list = [...new Set(contactIds.filter((x): x is string => x !== null))];
  const names = new Map<string, string>();
  if (list.length === 0) return names;
  const res = await db.execute(sql`
    SELECT id, display_name FROM contacts WHERE tenant_id = ${tenantId}
      AND id IN (${sql.join(list.map((id) => sql`${id}::uuid`), sql`, `)})
  `);
  for (const r of res.rows as Array<{ id: string; display_name: string }>) names.set(r.id, r.display_name);
  return names;
}

function groupBy<T extends { contactId: string | null }>(items: T[]): Map<string | null, T[]> {
  const out = new Map<string | null, T[]>();
  for (const it of items) out.set(it.contactId, [...(out.get(it.contactId) ?? []), it]);
  return out;
}

/** Name order, the no-contact row last. */
function byName(a: { id: string | null; display_name: string }, b: { id: string | null; display_name: string }) {
  if (a.id === null) return 1;
  if (b.id === null) return -1;
  return a.display_name.localeCompare(b.display_name);
}

/** Today's legacy bucket keys of the A/P aging (#33 shape). */
const AP_BUCKET: Record<keyof ExactBuckets, '1_30' | '31_60' | '61_90' | 'over_90' | 'current'> = {
  current: 'current', days1to30: '1_30', days31to60: '31_60', days61to90: '61_90', over90: 'over_90',
};

// ─── A/P aging (ap-aging-exact-v1) ───────────────────────────────

/**
 * A/P Aging Summary / Detail as of `asOf`, exact. The #33 exact shape with
 * as-of amounts: vendors[] {contact_id, vendor_name, currentExact,
 * bucket1to30Exact, bucket31to60Exact, bucket61to90Exact,
 * bucketOver90Exact, totalExact}, totalsExact (same keys), details[] {bill_id
 * (the transaction id of any open item), txn_type, kind, totalExact (its
 * own A/P amount), paidExact (settled as of the date: cash, discounts and
 * credits), balanceExact (open as of the date), days_overdue, bucket}.
 * Open vendor credits and unapplied payments are rows too (negative), and
 * A/P lines without a vendor are a "(no vendor)" row, so totalsExact.total
 * is the A/P balance on the date. The legacy number fields are derived
 * from the exact values.
 */
export async function buildApAgingAsOf(tenantId: string, asOf: string, companyId: string | null, tagId: string | null) {
  const items = await apOpenItemsAsOf(db, { tenantId, companyId, asOf, tagIds: splitIds(tagId) });
  const names = await contactNames(tenantId, items.map((i) => i.contactId));
  const nameOf = (id: string | null) => (id ? (names.get(id) ?? 'Unknown') : NO_VENDOR);

  const all = ageExact(items, asOf);
  const details = all.items.map((it) => ({
    contact_id: it.contactId,
    vendor_name: nameOf(it.contactId),
    bill_id: it.txnId,
    txn_type: it.txnType,
    kind: it.kind,
    txn_number: it.number,
    vendor_invoice_number: it.vendorInvoiceNumber,
    txn_date: it.date,
    due_date: it.dueDate,
    days_overdue: Math.max(0, it.days),
    total: legacyNum(it.originalExact),
    paid: legacyNum(dec(it.originalExact).minus(it.openExact)),
    balance: legacyNum(it.openExact),
    bucket: AP_BUCKET[it.bucket],
    totalExact: it.originalExact,
    paidExact: exactStr(dec(it.originalExact).minus(it.openExact)),
    balanceExact: it.openExact,
  })).sort((a, b) => byName({ id: a.contact_id, display_name: a.vendor_name }, { id: b.contact_id, display_name: b.vendor_name })
    || String(a.due_date ?? a.txn_date).localeCompare(String(b.due_date ?? b.txn_date)));

  const vendors = [...groupBy(items).entries()].map(([contactId, rows]) => {
    const a = ageExact(rows, asOf);
    return {
      contact_id: contactId,
      vendor_name: nameOf(contactId),
      current: legacyNum(a.buckets.current),
      bucket1to30: legacyNum(a.buckets.days1to30),
      bucket31to60: legacyNum(a.buckets.days31to60),
      bucket61to90: legacyNum(a.buckets.days61to90),
      bucketOver90: legacyNum(a.buckets.over90),
      total: legacyNum(a.totalExact),
      currentExact: a.buckets.current,
      bucket1to30Exact: a.buckets.days1to30,
      bucket31to60Exact: a.buckets.days31to60,
      bucket61to90Exact: a.buckets.days61to90,
      bucketOver90Exact: a.buckets.over90,
      totalExact: a.totalExact,
    };
  }).sort((a, b) => byName({ id: a.contact_id, display_name: a.vendor_name }, { id: b.contact_id, display_name: b.vendor_name }));

  const sumKey = (k: 'currentExact' | 'bucket1to30Exact' | 'bucket31to60Exact' | 'bucket61to90Exact' | 'bucketOver90Exact' | 'totalExact') =>
    dsum(vendors.map((v) => v[k]));
  const totalsExact = {
    current: exactStr(sumKey('currentExact')),
    bucket1to30: exactStr(sumKey('bucket1to30Exact')),
    bucket31to60: exactStr(sumKey('bucket31to60Exact')),
    bucket61to90: exactStr(sumKey('bucket61to90Exact')),
    bucketOver90: exactStr(sumKey('bucketOver90Exact')),
    total: exactStr(sumKey('totalExact')),
  };
  const totals = Object.fromEntries(Object.entries(totalsExact).map(([k, v]) => [k, legacyNum(v)]));
  return { title: 'AP Aging Summary', asOfDate: asOf, vendors, totals, totalsExact, details };
}

// ─── Unpaid Bills (as of) ────────────────────────────────────────

export interface UnpaidBillsAsOfFilters { contactId?: string; dueOnOrBefore?: string; overdueOnly?: boolean }

/**
 * Unpaid Bills as of `asOf`: each bill still open on the date, with the
 * cash paid, discounts taken and credits applied by then. data[] {id,
 * contact_id, vendor_name, txn_number, vendor_invoice_number, txn_date,
 * due_date, bill_status (partial | unpaid as of the date), days_overdue,
 * total, amount_paid, discount_amount, credits_applied, balance_due} as
 * exact strings; overdue_only means due before the as-of date.
 */
export async function buildUnpaidBillsAsOf(tenantId: string, asOf: string, filters: UnpaidBillsAsOfFilters, companyId: string | null) {
  const items = (await apOpenItemsAsOf(db, { tenantId, companyId, asOf, ...(filters.contactId ? { contactIds: [filters.contactId] } : {}) }))
    .filter((i) => i.txnType === 'bill' && dec(i.openExact).gt(0))
    .filter((i) => !filters.dueOnOrBefore || (i.dueDate ?? i.date) <= filters.dueOnOrBefore)
    .filter((i) => !filters.overdueOnly || (i.dueDate ?? i.date) < asOf);
  const names = await contactNames(tenantId, items.map((i) => i.contactId));
  const aged = ageExact(items, asOf).items;
  const data = aged.map((it) => {
    const settled = dec(it.paidExact).plus(it.discountExact).plus(it.creditsExact);
    return {
      id: it.txnId,
      contact_id: it.contactId,
      vendor_name: it.contactId ? (names.get(it.contactId) ?? 'Unknown') : NO_VENDOR,
      txn_number: it.number,
      vendor_invoice_number: it.vendorInvoiceNumber,
      txn_date: it.date,
      due_date: it.dueDate,
      bill_status: settled.isZero() ? 'unpaid' : 'partial',
      days_overdue: Math.max(0, it.days),
      total: it.originalExact,
      amount_paid: it.paidExact,
      discount_amount: it.discountExact,
      credits_applied: it.creditsExact,
      balance_due: it.openExact,
    };
  }).sort((a, b) => String(a.due_date).localeCompare(String(b.due_date)) || a.vendor_name.localeCompare(b.vendor_name));
  return { title: 'Unpaid Bills', asOfDate: asOf, data };
}

// ─── Open Invoices (as of) ───────────────────────────────────────

/**
 * Open Invoices as of `asOf` (invoice-list?open=1): each invoice still
 * open on the date. data[] {id, contact_id, customer_name, txn_number,
 * txn_date, due_date, invoice_status, status, days_overdue, total,
 * amount_paid (settled by the date: payments, credits, discounts,
 * write-offs), balance_due (open on the date)} as exact strings.
 */
export async function buildOpenInvoicesAsOf(
  tenantId: string, asOf: string, filters: { startDate?: string; endDate?: string; tagId?: string | null }, companyId: string | null,
) {
  const items = (await arOpenItemsAsOf(db, { tenantId, companyId, asOf, tagIds: splitIds(filters.tagId) }))
    .filter((i) => i.txnType === 'invoice' && dec(i.openExact).gt(0))
    .filter((i) => (!filters.startDate || i.date >= filters.startDate) && (!filters.endDate || i.date <= filters.endDate));
  const names = await contactNames(tenantId, items.map((i) => i.contactId));
  const docs = new Map<string, Record<string, unknown>>();
  if (items.length > 0) {
    const res = await db.execute(sql`
      SELECT id, total, invoice_status, status FROM transactions WHERE tenant_id = ${tenantId}
        AND id IN (${sql.join(items.map((i) => sql`${i.txnId}::uuid`), sql`, `)})
    `);
    for (const r of res.rows as Array<Record<string, unknown>>) docs.set(String(r['id']), r);
  }
  const aged = ageExact(items, asOf).items;
  const data = aged.map((it) => {
    const doc = docs.get(it.txnId) ?? {};
    const total = dec(it.originalExact);
    return {
      id: it.txnId,
      contact_id: it.contactId,
      customer_name: it.contactId ? (names.get(it.contactId) ?? null) : NO_CLIENT,
      txn_number: it.number,
      txn_date: it.date,
      due_date: it.dueDate,
      invoice_status: (doc['invoice_status'] as string | null) ?? null,
      status: (doc['status'] as string | null) ?? null,
      days_overdue: Math.max(0, it.days),
      total: exactStr(total),
      amount_paid: exactStr(total.minus(it.openExact)),
      balance_due: it.openExact,
    };
  }).sort((a, b) => b.txn_date.localeCompare(a.txn_date) || String(b.txn_number ?? '').localeCompare(String(a.txn_number ?? '')));
  return { title: 'Open Invoices', asOfDate: asOf, data };
}

// ─── Customer / Vendor balances (as of) ──────────────────────────

interface BalanceDoc {
  txnId: string; txnType: string; kind: string; number: string | null; date: string; dueDate: string | null;
  amountExact: string; openExact: string; runningBalanceExact: string;
}

function balanceRows<T extends OpenItem | ApOpenItem>(
  items: T[], names: Map<string, string>, noContact: string, withDocs: boolean,
) {
  const rows = [...groupBy(items).entries()].map(([contactId, list]) => {
    let running: Dec = new Decimal(0);
    const docs: BalanceDoc[] = list.map((it) => {
      running = running.plus(it.openExact);
      return {
        txnId: it.txnId, txnType: it.txnType, kind: it.kind, number: it.number, date: it.date, dueDate: it.dueDate,
        amountExact: exactStr(it.originalExact), openExact: exactStr(it.openExact), runningBalanceExact: exactStr(running),
      };
    });
    return {
      id: contactId,
      display_name: contactId ? (names.get(contactId) ?? 'Unknown') : noContact,
      balance: exactStr(running),
      ...(withDocs ? { items: docs } : {}),
    };
  });
  return rows.sort(byName);
}

/**
 * Customer Balance Summary / Detail as of `asOf`: each client's open A/R
 * (open invoices less open credits and unapplied payments) on the date.
 * data[] {id, display_name, balance} (+ items[] {txnId, txnType, kind,
 * number, date, dueDate, amountExact, openExact, runningBalanceExact} on
 * Detail: the open documents in date order). A client whose documents net
 * to zero is left out of the Summary and kept on the Detail. A/R lines
 * without a client are a "(no client)" row. The total is the A/R balance
 * on the date and equals the A/R aging total.
 */
export async function buildCustomerBalanceAsOf(
  tenantId: string, asOf: string, companyId: string | null, tagId: string | null, detail: boolean,
) {
  const items = await arOpenItemsAsOf(db, { tenantId, companyId, asOf, tagIds: splitIds(tagId) });
  const names = await contactNames(tenantId, items.map((i) => i.contactId));
  const rows = balanceRows(items, names, NO_CLIENT, detail).filter((r) => detail || !dec(r.balance).isZero());
  return { title: detail ? 'Customer Balance Detail' : 'Customer Balance Summary', asOfDate: asOf, data: rows };
}

/**
 * Vendor Balance Summary / Detail as of `asOf`: each vendor's open A/P
 * (open bills less open vendor credits) on the date, the A/P twin of the
 * customer balance report. data[] {id, display_name, balance} (+ items[]
 * on Detail). The total is the A/P balance on the date.
 */
export async function buildVendorBalanceAsOf(tenantId: string, asOf: string, companyId: string | null, tagId: string | null, detail: boolean) {
  const items = await apOpenItemsAsOf(db, { tenantId, companyId, asOf, tagIds: splitIds(tagId) });
  const names = await contactNames(tenantId, items.map((i) => i.contactId));
  const rows = balanceRows(items, names, NO_VENDOR, detail).filter((r) => detail || !dec(r.balance).isZero());
  return { title: detail ? 'Vendor Balance Detail' : 'Vendor Balance Summary', asOfDate: asOf, data: rows };
}
