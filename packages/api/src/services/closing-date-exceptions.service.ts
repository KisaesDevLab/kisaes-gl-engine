// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

/**
 * Closing Date Exceptions (U-204, closing-exceptions-v1; ClientLedger P28,
 * Q-P28c, Q-P28q): every create, edit, void or delete of a transaction whose
 * old or new date was on or before the closing date in effect when the change
 * was made, plus every closing_date_override row. Read-only, from the audit
 * trail:
 *
 *  - The closing-date timeline comes from the audit rows of closing-date
 *    changes (`closing_date` from PUT /tb/closing-date, `company` rows whose
 *    lockDate changed from the company settings) plus the current setting
 *    (companies.lock_date / lock_date_set_at) when no audit row carries it.
 *    Before the first entry there is no closing date, so nothing is listed.
 *  - Transaction changes are the ledger's `transaction` audit rows (action
 *    create, update, void, delete). auditLog() stores row images as JSON
 *    text, so both forms are read. The date and amount before a change are
 *    its before-image; after a change they are the next change's
 *    before-image, else the live row, else the after-image (a create row
 *    written before this change has no date). Amounts are read as text and
 *    never pass through a JS number.
 *  - An override row written in the same database transaction (same
 *    created_at) as a transaction row gives that row its `method`; any other
 *    override row is listed on its own with action `override`.
 */

import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { exactStr } from './report-exact.js';

export const CLOSING_EXCEPTIONS_MAX_ROWS = 10_000;

export interface ClosingDateExceptionRow {
  auditId: number;
  at: string;
  userId: string | null;
  userName: string | null;
  action: 'create' | 'update' | 'void' | 'delete' | 'override';
  transactionId: string | null;
  txnType: string | null;
  txnNumber: string | null;
  txnDateBefore: string | null;
  txnDateAfter: string | null;
  closingDate: string;
  method: 'password' | 'confirmed' | null;
  amountBeforeExact: string | null;
  amountAfterExact: string | null;
}

export interface ClosingTimelineEntry {
  at: string;
  closingDate: string | null;
}

export interface ClosingDateExceptionsResult {
  data: ClosingDateExceptionRow[];
  total: number;
  truncated: boolean;
  closingDate: string | null;
  timeline: ClosingTimelineEntry[];
}

/** The JSON object of an audit image column (a JSON text scalar, or an object written by a migration). */
const doc = (col: string) => sql.raw(`(CASE WHEN jsonb_typeof(${col}) = 'string' THEN (${col} #>> '{}')::jsonb ELSE ${col} END)`);

/** 'YYYY-MM-DD' from a stored date or timestamp text; null otherwise. */
function day(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(v);
  return m ? m[1]! : null;
}

function money(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v);
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  return exactStr(s);
}

interface TimelinePoint { atMicros: string; atIso: string; closingDate: string | null }

/** created_at as sortable text with microseconds (rows of one database transaction share it). */
const TS_KEY = sql.raw(`to_char(a.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')`);
const TS_ISO = sql.raw(`to_char(a.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`);

async function loadTimeline(tenantId: string, companyId: string): Promise<{ points: TimelinePoint[]; current: string | null }> {
  const companyRes = await db.execute(sql`
    SELECT to_char(lock_date, 'YYYY-MM-DD') AS lock_date,
           to_char(lock_date_set_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') AS set_key,
           to_char(lock_date_set_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS set_iso
    FROM companies WHERE tenant_id = ${tenantId} AND id = ${companyId}`);
  const company = (companyRes.rows as Array<{ lock_date: string | null; set_key: string | null; set_iso: string | null }>)[0];
  const res = await db.execute(sql`
    SELECT ${TS_KEY} AS k, ${TS_ISO} AS iso, a.id, a.entity_type,
           j.x ? 'closingDate' AS has_closing, j.x->>'closingDate' AS closing,
           j.x ? 'lockDate' AS has_lock, j.x->>'lockDate' AS lock_after,
           j.b ? 'lockDate' AS had_lock, j.b->>'lockDate' AS lock_before
    FROM audit_log a, LATERAL (SELECT ${doc('a.before_data')} AS b, ${doc('a.after_data')} AS x) j
    WHERE a.tenant_id = ${tenantId} AND a.entity_id = ${companyId}
      AND a.entity_type IN ('closing_date', 'company') AND a.action = 'update'
    ORDER BY a.created_at, a.id`);
  const points: TimelinePoint[] = [];
  for (const r of res.rows as Array<{
    k: string; iso: string; entity_type: string; has_closing: boolean | null; closing: string | null;
    has_lock: boolean | null; lock_after: string | null; had_lock: boolean | null; lock_before: string | null;
  }>) {
    if (r.entity_type === 'closing_date') {
      if (!r.has_closing) continue;
      points.push({ atMicros: r.k, atIso: r.iso, closingDate: day(r.closing) });
    } else {
      if (!r.has_lock) continue;
      const next = day(r.lock_after);
      if (r.had_lock && day(r.lock_before) === next) continue;
      points.push({ atMicros: r.k, atIso: r.iso, closingDate: next });
    }
  }
  const current = company?.lock_date ?? null;
  // The current setting, when no audit row carries it (set before closing
  // dates were audited, or by a path that writes no row).
  const last = points[points.length - 1];
  if (current && company?.set_key && (!last || last.closingDate !== current)) {
    points.push({ atMicros: company.set_key, atIso: company.set_iso!, closingDate: current });
    points.sort((p, q) => (p.atMicros < q.atMicros ? -1 : p.atMicros > q.atMicros ? 1 : 0));
  }
  return { points, current };
}

function closingAt(points: TimelinePoint[], atMicros: string): string | null {
  let value: string | null = null;
  for (const p of points) {
    if (p.atMicros > atMicros) break;
    value = p.closingDate;
  }
  return value;
}

interface AuditTxnRow {
  id: string | number;
  k: string;
  iso: string;
  /** The day of the change in the database session's time zone (as GET /audit-log filters). */
  d: string;
  user_id: string | null;
  user_name: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  /** The before-image keys this report reads, as text; null when the image has no txnDate (override rows: always set). */
  b: Record<string, string | null> | null;
  /** The after-image keys this report reads, as text. */
  x: Record<string, string | null> | null;
  live_date: string | null;
  live_total: string | null;
  live_type: string | null;
  live_number: string | null;
  live_status: string | null;
}

export async function buildClosingDateExceptions(
  tenantId: string,
  companyId: string,
  opts: { startDate?: string; endDate?: string; limit?: number } = {},
): Promise<ClosingDateExceptionsResult> {
  const { points, current } = await loadTimeline(tenantId, companyId);
  const timeline = points.map((p) => ({ at: p.atIso, closingDate: p.closingDate }));
  // Transaction rows count from the first closing date on; override rows
  // carry their own closing date and are always read.
  const first = points.find((p) => p.closingDate !== null);

  // A row belongs to the company of its transaction (or, for a transaction
  // row that is gone, the companyId of its images); rows with no company at
  // all are kept, as the company-scoped reports keep company_id IS NULL.
  const res = await db.execute(sql`
    SELECT a.id, ${TS_KEY} AS k, ${TS_ISO} AS iso, to_char(a.created_at, 'YYYY-MM-DD') AS d, a.user_id, a.action, a.entity_type, a.entity_id,
           -- Only the keys read here, as text: amounts never become JS numbers
           -- and whole row images (lines included) are not loaded.
           CASE WHEN j.b ? 'txnDate' OR a.entity_type = 'closing_date_override' THEN jsonb_build_object(
             'txnDate', j.b->>'txnDate', 'total', j.b->>'total', 'txnType', j.b->>'txnType',
             'txnNumber', j.b->>'txnNumber', 'lockDate', j.b->>'lockDate') END AS b,
           jsonb_build_object(
             'txnDate', j.x->>'txnDate', 'total', j.x->>'total', 'txnType', j.x->>'txnType',
             'transactionId', j.x->>'transactionId', 'method', j.x->>'method',
             'oldDate', j.x->>'oldDate', 'newDate', j.x->>'newDate') AS x,
           (SELECT COALESCE(NULLIF(u.display_name, ''), u.email) FROM users u WHERE u.id = a.user_id) AS user_name,
           to_char(t.txn_date, 'YYYY-MM-DD') AS live_date, t.total::text AS live_total, t.txn_type AS live_type,
           t.txn_number AS live_number, t.status AS live_status
    FROM audit_log a
    CROSS JOIN LATERAL (SELECT ${doc('a.before_data')} AS b, ${doc('a.after_data')} AS x) j
    LEFT JOIN transactions t ON t.tenant_id = a.tenant_id AND t.id = COALESCE(
      CASE WHEN a.entity_type = 'closing_date_override'
        THEN NULLIF(j.x->>'transactionId', '')::uuid END,
      a.entity_id)
    WHERE a.tenant_id = ${tenantId}
      AND ((a.entity_type = 'transaction' AND a.action IN ('create', 'update', 'void', 'delete')
            AND a.created_at >= ${first?.atIso ?? null}::timestamptz - interval '1 millisecond')
        OR (a.entity_type = 'closing_date_override' AND a.action = 'override'))
      AND COALESCE(a.company_id::text, t.company_id::text,
            j.x->>'companyId', j.b->>'companyId', ${companyId}::text) = ${companyId}::text
    ORDER BY a.entity_id, a.created_at, a.id`);
  const all = res.rows as unknown as AuditTxnRow[];
  const txnRows = all.filter((r) => r.entity_type === 'transaction');
  const overrides = all.filter((r) => r.entity_type === 'closing_date_override');

  // One change can leave two rows for the same transaction (a service
  // annotating the ledger's row); keep one per transaction, action and instant.
  const byTxn = new Map<string, AuditTxnRow[]>();
  for (const r of txnRows) {
    const list = byTxn.get(r.entity_id ?? '') ?? [];
    const dup = list.find((o) => o.k === r.k && o.action === r.action);
    if (dup) {
      if (!dup.b && r.b) list[list.indexOf(dup)] = r;
      continue;
    }
    list.push(r);
    byTxn.set(r.entity_id ?? '', list);
  }

  const out: Array<ClosingDateExceptionRow & { k: string; d: string }> = [];
  const used = new Set<AuditTxnRow>();

  const overrideFor = (txnId: string | null, k: string): AuditTxnRow | undefined => {
    const exact = overrides.find((o) => !used.has(o) && o.k === k
      && (o.x?.['transactionId'] === txnId || o.entity_id === txnId));
    if (exact) return exact;
    const sameInstant = overrides.filter((o) => !used.has(o) && o.k === k && !o.x?.['transactionId']);
    return sameInstant.length === 1 ? sameInstant[0] : undefined;
  };

  for (const [txnId, rows] of byTxn) {
    const state = (r: AuditTxnRow | undefined) => (r?.b ? { date: day(r.b['txnDate']), total: money(r.b['total']) } : null);
    let prevAfter: { date: string | null; total: string | null } | null = null;
    rows.forEach((r, i) => {
      const own = state(r);
      // The state after this change: the next before-image, else the live row.
      let after: { date: string | null; total: string | null } | null = null;
      for (let j = i + 1; j < rows.length && !after; j++) after = state(rows[j]);
      if (!after && r.live_status !== null && r.live_date) after = { date: r.live_date, total: money(r.live_total) };
      if (!after) after = { date: day(r.x?.['txnDate']), total: money(r.x?.['total']) };

      let dateBefore: string | null = null;
      let totalBefore: string | null = null;
      let dateAfter: string | null = after.date;
      let totalAfter: string | null = after.total;
      if (r.action === 'create') {
        // The create row (since U-204) carries its date; older ones do not.
        dateAfter = day(r.x?.['txnDate']) ?? after.date;
        totalAfter = money(r.x?.['total']) ?? after.total;
      } else {
        const before = own ?? prevAfter ?? after;
        dateBefore = before.date;
        totalBefore = before.total;
        if (r.action === 'void') { dateAfter = dateBefore; totalAfter = null; }
        if (r.action === 'delete') { dateAfter = null; totalAfter = null; }
      }
      prevAfter = { date: dateAfter ?? dateBefore, total: totalAfter };

      const cd = closingAt(points, r.k);
      if (!cd) return;
      const o = overrideFor(txnId, r.k);
      const inClosed = (dateBefore !== null && dateBefore <= cd) || (dateAfter !== null && dateAfter <= cd);
      if (!inClosed && !o) return;
      if (o) used.add(o);
      const method = o ? (o.x?.['method'] === 'password' || o.x?.['method'] === 'confirmed' ? o.x['method'] as 'password' | 'confirmed' : null) : null;
      out.push({
        k: r.k,
        d: r.d,
        auditId: Number(r.id),
        at: r.iso,
        userId: r.user_id,
        userName: r.user_name,
        action: r.action as ClosingDateExceptionRow['action'],
        transactionId: txnId || null,
        txnType: (r.live_type ?? (r.b?.['txnType'] as string | undefined) ?? (r.x?.['txnType'] as string | undefined)) ?? null,
        txnNumber: (r.live_number ?? (r.b?.['txnNumber'] as string | undefined)) ?? null,
        txnDateBefore: dateBefore,
        txnDateAfter: dateAfter,
        closingDate: cd,
        method,
        amountBeforeExact: totalBefore,
        amountAfterExact: totalAfter,
      });
    });
  }

  // Override rows no transaction row claimed (merge locks, an override
  // audited on its own): listed as they are.
  for (const o of overrides) {
    if (used.has(o)) continue;
    const lock = day(o.b?.['lockDate']) ?? closingAt(points, o.k);
    if (!lock) continue;
    const method = o.x?.['method'];
    out.push({
      k: o.k,
      d: o.d,
      auditId: Number(o.id),
      at: o.iso,
      userId: o.user_id,
      userName: o.user_name,
      action: 'override',
      transactionId: (o.x?.['transactionId'] as string | null | undefined) ?? null,
      txnType: o.live_type,
      txnNumber: o.live_number,
      txnDateBefore: day(o.x?.['oldDate']) ?? null,
      txnDateAfter: day(o.x?.['newDate']) ?? (o.x?.['oldDate'] ? null : day(o.x?.['txnDate'])),
      closingDate: lock,
      method: method === 'password' || method === 'confirmed' ? method : null,
      amountBeforeExact: null,
      amountAfterExact: null,
    });
  }

  const inRange = out.filter((r) => {
    const d = r.d;
    if (opts.startDate && d < opts.startDate) return false;
    if (opts.endDate && d > opts.endDate) return false;
    return true;
  });
  inRange.sort((p, q) => (p.k < q.k ? -1 : p.k > q.k ? 1 : p.auditId - q.auditId));
  const limit = Math.min(Math.max(opts.limit ?? 5000, 1), CLOSING_EXCEPTIONS_MAX_ROWS);
  const data = inRange.slice(0, limit).map(({ k: _k, d: _d, ...row }) => row);
  return { data, total: inRange.length, truncated: inRange.length > limit, closingDate: current, timeline };
}
