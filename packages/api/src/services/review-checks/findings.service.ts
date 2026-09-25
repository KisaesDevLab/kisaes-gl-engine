// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { aliasedTable, and, desc, eq, gte, inArray, isNull, lt, sql } from 'drizzle-orm';
import type { Finding, FindingDraft, FindingSeverity, FindingStatus } from '@kis-books/shared';
import { FINDING_SEVERITIES, FINDING_STATUSES } from '@kis-books/shared';
import { db } from '../../db/index.js';
import { findings, findingEvents, transactions, contacts } from '../../db/schema/index.js';
import { auditLog } from '../../middleware/audit.js';

// Phase 6 §6.4 — finding writer + reader. Dedupe key per plan
// §D4: (tenant_id, check_key, transaction_id, vendor_id,
// COALESCE(payload->>'dedupe_key', '')). The orchestrator
// already-active findings before re-inserting; this service
// owns the "check whether duplicate" + "insert + audit"
// transaction boundaries.

export interface BulkInsertResult {
  inserted: number;
  duplicates: number;
}

// Inserts a batch of finding drafts, skipping duplicates of any
// existing finding regardless of status. The dedupe set
// intentionally includes `resolved` and `ignored` — once a
// human has acted on a finding, re-running checks must not
// re-create an identical row, otherwise resolve/ignore would be
// useless. To re-surface a previously closed finding, transition
// it back to `open` instead of relying on a fresh insert.
export async function bulkInsert(
  tenantId: string,
  companyId: string | null,
  drafts: FindingDraft[],
  defaultSeverityByCheck: Record<string, FindingSeverity>,
  userId?: string,
  // Close-period window this batch belongs to (from the run). Stamped
  // onto every inserted finding so the Findings list can filter by
  // period. Null bounds (all-time run) leave the columns null.
  period?: { periodStart: string | null; periodEnd: string | null },
): Promise<BulkInsertResult> {
  if (drafts.length === 0) return { inserted: 0, duplicates: 0 };

  // Compute the dedupe key for each candidate.
  const keyed = drafts.map((d) => ({
    draft: d,
    key: dedupeKey(d),
  }));

  // Pull existing findings (any status) with matching check keys to
  // dedupe against — within the SAME company and close period. A finding
  // belongs to one period: re-running a period is idempotent, but the
  // same issue surfacing in a later period is a new item to review there.
  const checkKeys = Array.from(new Set(keyed.map((k) => k.draft.checkKey)));
  const periodStart = period?.periodStart ?? null;
  const existing = await db
    .select({
      checkKey: findings.checkKey,
      transactionId: findings.transactionId,
      vendorId: findings.vendorId,
      payload: findings.payload,
    })
    .from(findings)
    .where(
      and(
        eq(findings.tenantId, tenantId),
        inArray(findings.checkKey, checkKeys),
        companyId === null ? isNull(findings.companyId) : eq(findings.companyId, companyId),
        periodStart === null ? isNull(findings.periodStart) : eq(findings.periodStart, periodStart),
      ),
    );

  const existingKeys = new Set(
    existing.map((r) => existingDedupeKey(r.checkKey, r.transactionId, r.vendorId, r.payload as Record<string, unknown> | null)),
  );

  const fresh = keyed.filter((k) => !existingKeys.has(k.key));
  if (fresh.length === 0) {
    return { inserted: 0, duplicates: drafts.length };
  }

  const rows = fresh.map((k) => ({
    tenantId,
    companyId,
    checkKey: k.draft.checkKey,
    transactionId: k.draft.transactionId ?? null,
    vendorId: k.draft.vendorId ?? null,
    severity: (k.draft.severity ?? defaultSeverityByCheck[k.draft.checkKey] ?? 'med') as FindingSeverity,
    payload: k.draft.payload,
    periodStart: period?.periodStart ?? null,
    periodEnd: period?.periodEnd ?? null,
  }));

  const inserted = await db.insert(findings).values(rows).returning({ id: findings.id });

  // Per-finding audit emit (plan §D7). Best-effort; audit
  // failure shouldn't roll back the finding insert (the audit
  // helper already swallows non-critical errors via the same
  // pattern other services use).
  await Promise.all(
    inserted.map((r, i) =>
      auditLog(
        tenantId,
        'create',
        'finding',
        r.id,
        null,
        { checkKey: rows[i]!.checkKey, severity: rows[i]!.severity, payload: rows[i]!.payload },
        userId,
      ).catch(() => undefined),
    ),
  );

  return { inserted: inserted.length, duplicates: drafts.length - fresh.length };
}

function dedupeKey(d: FindingDraft): string {
  const dk = (d.payload as { dedupe_key?: string } | undefined)?.dedupe_key ?? d.dedupeKey ?? '';
  return [d.checkKey, d.transactionId ?? '', d.vendorId ?? '', dk].join('|');
}

function existingDedupeKey(
  checkKey: string,
  transactionId: string | null,
  vendorId: string | null,
  payload: Record<string, unknown> | null,
): string {
  const dk = (payload as { dedupe_key?: string } | null)?.dedupe_key ?? '';
  return [checkKey, transactionId ?? '', vendorId ?? '', dk].join('|');
}

// ─── Reader API ───────────────────────────────────────────────

export interface FindingsListInput {
  status?: FindingStatus;
  severity?: FindingSeverity;
  checkKey?: string;
  companyId?: string;
  // Scope to a close period. Findings whose stamped period_start falls
  // in [periodStart, periodEnd) are returned. periodEnd is exclusive
  // (first-of-next-month) per ClosePeriodSelector. Pre-migration
  // findings with a null period_start are excluded from a scoped view.
  periodStart?: string;
  periodEnd?: string;
  cursor?: string;
  limit?: number;
}

export async function list(
  tenantId: string,
  input: FindingsListInput,
): Promise<{ rows: Finding[]; nextCursor: string | null }> {
  const limit = Math.min(input.limit ?? 50, 200);
  const conditions = [eq(findings.tenantId, tenantId)];
  if (input.status) conditions.push(eq(findings.status, input.status));
  if (input.severity) conditions.push(eq(findings.severity, input.severity));
  if (input.checkKey) conditions.push(eq(findings.checkKey, input.checkKey));
  if (input.companyId) conditions.push(eq(findings.companyId, input.companyId));
  // Period scope: findings stamped with a run period inside
  // [periodStart, periodEnd). Bounds are normalized to date-only so the
  // date column comparison is deterministic regardless of any time part
  // the caller sends. Exclusive upper bound keeps a month's window from
  // bleeding into the next month's first-of-month stamp.
  if (input.periodStart) conditions.push(gte(findings.periodStart, input.periodStart.slice(0, 10)));
  if (input.periodEnd) conditions.push(lt(findings.periodStart, input.periodEnd.slice(0, 10)));
  // Composite keyset cursor "createdAtISO|id" matching the
  // (created_at DESC, id DESC) sort. A created_at-only cursor loses
  // every row sharing the boundary timestamp — and one bulkInsert
  // stamps its whole batch with a single now(), so a run inserting
  // more findings than the page size made the tail unreachable.
  // created_at is compared at millisecond precision (the ISO cursor's
  // resolution) via date_trunc so Postgres microseconds don't wedge
  // the seam. Legacy cursors without an id part degrade to the old
  // timestamp-only behavior.
  if (input.cursor) {
    const [ts, cursorId] = input.cursor.split('|');
    const cursorDate = new Date(ts!);
    if (cursorId) {
      conditions.push(sql`(
        date_trunc('milliseconds', ${findings.createdAt}) < ${cursorDate}
        OR (date_trunc('milliseconds', ${findings.createdAt}) = ${cursorDate} AND ${findings.id} < ${cursorId}::uuid)
      )`);
    } else {
      conditions.push(lt(findings.createdAt, cursorDate));
    }
  }

  // Left-join the underlying transaction + its contact and the
  // standalone vendor reference so the Findings table can show a
  // meaningful Context column (vendor name, amount, date, memo)
  // instead of a truncated UUID. The contacts table is aliased
  // twice — once for transaction.contact_id, once for
  // finding.vendor_id.
  const txnContact = aliasedTable(contacts, 'txn_contact');
  const vendorContact = aliasedTable(contacts, 'vendor_contact');

  const rows = await db
    .select({
      f: findings,
      txnDate: transactions.txnDate,
      txnTotal: transactions.total,
      txnType: transactions.txnType,
      txnNumber: transactions.txnNumber,
      txnMemo: transactions.memo,
      txnContactName: txnContact.displayName,
      vendorContactName: vendorContact.displayName,
    })
    .from(findings)
    .leftJoin(transactions, eq(transactions.id, findings.transactionId))
    .leftJoin(txnContact, eq(txnContact.id, transactions.contactId))
    .leftJoin(vendorContact, eq(vendorContact.id, findings.vendorId))
    .where(and(...conditions))
    .orderBy(desc(findings.createdAt), desc(findings.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  return {
    rows: page.map(mapJoinedRow),
    nextCursor: hasMore && last ? `${last.f.createdAt.toISOString()}|${last.f.id}` : null,
  };
}

// Maps the JOINed row into a Finding with payload decorated by
// fields the FindingsTable Context column already knows how to
// render (vendorName, description, amount, date). The original
// payload wins so handlers that already supply richer data
// aren't overwritten.
type JoinedRow = {
  f: typeof findings.$inferSelect;
  txnDate: string | null;
  txnTotal: string | null;
  txnType: string | null;
  txnNumber: string | null;
  txnMemo: string | null;
  txnContactName: string | null;
  vendorContactName: string | null;
};

function mapJoinedRow(r: JoinedRow): Finding {
  const basePayload = (r.f.payload ?? {}) as Record<string, unknown>;
  const decorated: Record<string, unknown> = { ...basePayload };

  // vendorName: prefer the transaction's contact, fall back to
  // the standalone vendor_id (set by handlers like 1099).
  if (decorated['vendorName'] === undefined) {
    const v = r.txnContactName ?? r.vendorContactName;
    if (v) decorated['vendorName'] = v;
  }
  // description: human memo if there is one, otherwise the
  // transaction reference (#1234) or the type (e.g. "expense").
  if (decorated['description'] === undefined) {
    const desc = r.txnMemo
      || (r.txnNumber ? `${r.txnType ?? 'txn'} #${r.txnNumber}` : null)
      || r.txnType;
    if (desc) decorated['description'] = desc;
  }
  // amount: Drizzle returns numeric/decimal columns as strings;
  // coerce so the frontend's currency formatter picks it up via
  // the `amount` field.
  if (decorated['amount'] === undefined) {
    const total = r.txnTotal ?? (typeof basePayload['total'] === 'string' ? basePayload['total'] : null);
    if (total != null) {
      const n = Number(total);
      if (Number.isFinite(n)) decorated['amount'] = n;
    }
  }
  if (decorated['date'] === undefined) {
    const d = r.txnDate ?? (typeof basePayload['txnDate'] === 'string' ? basePayload['txnDate'] : null);
    if (d) decorated['date'] = d;
  }

  return {
    id: r.f.id,
    tenantId: r.f.tenantId,
    companyId: r.f.companyId,
    checkKey: r.f.checkKey,
    transactionId: r.f.transactionId,
    vendorId: r.f.vendorId,
    severity: r.f.severity as FindingSeverity,
    status: r.f.status as FindingStatus,
    assignedTo: r.f.assignedTo,
    payload: decorated,
    createdAt: r.f.createdAt.toISOString(),
    resolvedAt: r.f.resolvedAt ? r.f.resolvedAt.toISOString() : null,
    resolutionNote: r.f.resolutionNote,
  };
}

export async function getById(tenantId: string, id: string): Promise<Finding | null> {
  const [row] = await db
    .select()
    .from(findings)
    .where(and(eq(findings.tenantId, tenantId), eq(findings.id, id)))
    .limit(1);
  return row ? mapFindingRow(row) : null;
}

// State transition with event log. Used by Phase 7 inline
// resolve / assign / ignore actions. Single-row entry point;
// see `bulkTransition` for the multi-row variant.
export async function transition(
  tenantId: string,
  findingId: string,
  toStatus: FindingStatus,
  opts: { userId?: string; note?: string; assignedTo?: string | null; resolutionNote?: string },
): Promise<Finding> {
  const before = await getById(tenantId, findingId);
  if (!before) throw new Error(`Finding ${findingId} not found`);

  const set: Partial<typeof findings.$inferInsert> = { status: toStatus };
  if (toStatus === 'resolved') {
    set.resolvedAt = new Date();
    if (opts.resolutionNote) set.resolutionNote = opts.resolutionNote;
  }
  // 'assigned' carries an assigneeId. 'in_review' may also stamp one.
  // Other transitions can clear it via assignedTo: null.
  if (opts.assignedTo !== undefined) set.assignedTo = opts.assignedTo;

  const [updated] = await db
    .update(findings)
    .set(set)
    .where(and(eq(findings.tenantId, tenantId), eq(findings.id, findingId)))
    .returning();

  await db.insert(findingEvents).values({
    findingId,
    fromStatus: before.status,
    toStatus,
    userId: opts.userId ?? null,
    note: opts.note ?? null,
  });

  await auditLog(tenantId, 'update', 'finding', findingId, { status: before.status }, { status: toStatus }, opts.userId).catch(() => undefined);

  return mapFindingRow(updated!);
}

// Bulk variant — same options apply to every finding in `ids`.
// Returns the per-finding outcome so the caller can surface
// partial success (a finding belonging to a sibling tenant or
// already-resolved still appears in `failed`).
export async function bulkTransition(
  tenantId: string,
  ids: string[],
  toStatus: FindingStatus,
  opts: { userId?: string; note?: string; assignedTo?: string | null; resolutionNote?: string },
): Promise<{ updated: string[]; failed: Array<{ id: string; reason: string }> }> {
  if (ids.length === 0) return { updated: [], failed: [] };
  const updated: string[] = [];
  const failed: Array<{ id: string; reason: string }> = [];
  for (const id of ids) {
    try {
      await transition(tenantId, id, toStatus, opts);
      updated.push(id);
    } catch (err) {
      failed.push({
        id,
        reason: err instanceof Error ? err.message : 'unknown_error',
      });
    }
  }
  return { updated, failed };
}

// Reader for the per-finding event log — powers the drawer
// history pane in Phase 7.
export interface FindingEventRow {
  id: string;
  findingId: string;
  fromStatus: FindingStatus | null;
  toStatus: FindingStatus;
  userId: string | null;
  note: string | null;
  createdAt: string;
}

export async function listEvents(tenantId: string, findingId: string): Promise<FindingEventRow[]> {
  // Verify the finding belongs to this tenant before exposing
  // the events — finding_events has no tenant_id column of its
  // own, so the join through findings is the tenant gate.
  const owner = await getById(tenantId, findingId);
  if (!owner) return [];
  const rows = await db
    .select()
    .from(findingEvents)
    .where(eq(findingEvents.findingId, findingId))
    .orderBy(findingEvents.createdAt);
  return rows.map((r) => ({
    id: r.id,
    findingId: r.findingId,
    fromStatus: (r.fromStatus as FindingStatus | null) ?? null,
    toStatus: r.toStatus as FindingStatus,
    userId: r.userId,
    note: r.note,
    createdAt: r.createdAt.toISOString(),
  }));
}

// Severity + status rollup for the summary cards. Scoped by the SAME
// company + period filter as list(), so a card count always matches the
// rows the list can show. byStatus counts every status; bySeverity counts
// only still-active findings (open / assigned / in review) — resolved and
// ignored items are not work to do.
const ACTIVE_STATUSES = new Set<FindingStatus>(['open', 'assigned', 'in_review']);
export async function summaryByStatusSeverity(
  tenantId: string,
  companyId?: string | null,
  period?: { periodStart?: string; periodEnd?: string },
): Promise<{
  byStatus: Record<FindingStatus, number>;
  bySeverity: Record<FindingSeverity, number>;
  total: number;
}> {
  const conditions = [eq(findings.tenantId, tenantId)];
  if (companyId) conditions.push(eq(findings.companyId, companyId));
  if (period?.periodStart) conditions.push(gte(findings.periodStart, period.periodStart.slice(0, 10)));
  if (period?.periodEnd) conditions.push(lt(findings.periodStart, period.periodEnd.slice(0, 10)));
  const rows = await db
    .select({
      status: findings.status,
      severity: findings.severity,
      count: sql<number>`count(*)::int`,
    })
    .from(findings)
    .where(and(...conditions))
    .groupBy(findings.status, findings.severity);

  const byStatus = Object.fromEntries(
    FINDING_STATUSES.map((s) => [s, 0]),
  ) as Record<FindingStatus, number>;
  const bySeverity = Object.fromEntries(
    FINDING_SEVERITIES.map((s) => [s, 0]),
  ) as Record<FindingSeverity, number>;
  let total = 0;
  for (const r of rows) {
    const c = Number(r.count);
    byStatus[r.status as FindingStatus] = (byStatus[r.status as FindingStatus] ?? 0) + c;
    if (ACTIVE_STATUSES.has(r.status as FindingStatus)) {
      bySeverity[r.severity as FindingSeverity] = (bySeverity[r.severity as FindingSeverity] ?? 0) + c;
    }
    total += c;
  }
  return { byStatus, bySeverity, total };
}

function mapFindingRow(row: typeof findings.$inferSelect): Finding {
  return {
    id: row.id,
    tenantId: row.tenantId,
    companyId: row.companyId,
    checkKey: row.checkKey,
    transactionId: row.transactionId,
    vendorId: row.vendorId,
    severity: row.severity as FindingSeverity,
    status: row.status as FindingStatus,
    assignedTo: row.assignedTo,
    payload: row.payload as Record<string, unknown> | null,
    createdAt: row.createdAt.toISOString(),
    resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
    resolutionNote: row.resolutionNote,
  };
}

// sql tag retained for future raw-SQL needs.
export const _sqlRef = sql`SELECT 1`;

// Per-report counts for the close workspace: one row per check key with
// open (open / assigned / in review), accepted (resolved) and excluded
// (ignored) totals for the company + period.
export async function countsByCheck(
  tenantId: string,
  companyId: string | null,
  period: { periodStart: string; periodEnd: string },
): Promise<Array<{ checkKey: string; open: number; accepted: number; excluded: number }>> {
  const conditions = [
    eq(findings.tenantId, tenantId),
    gte(findings.periodStart, period.periodStart.slice(0, 10)),
    lt(findings.periodStart, period.periodEnd.slice(0, 10)),
  ];
  if (companyId) conditions.push(eq(findings.companyId, companyId));
  const rows = await db
    .select({
      checkKey: findings.checkKey,
      open: sql<number>`count(*) FILTER (WHERE ${findings.status} IN ('open','assigned','in_review'))::int`,
      accepted: sql<number>`count(*) FILTER (WHERE ${findings.status} = 'resolved')::int`,
      excluded: sql<number>`count(*) FILTER (WHERE ${findings.status} = 'ignored')::int`,
    })
    .from(findings)
    .where(and(...conditions))
    .groupBy(findings.checkKey);
  return rows.map((r) => ({ checkKey: r.checkKey, open: Number(r.open), accepted: Number(r.accepted), excluded: Number(r.excluded) }));
}

// How this finding's payee has been coded over the 12 months before the
// finding's period: one row per account with count and total. Shown in the
// detail drawer so the reviewer can see "usually Office Supplies (18 of 20)"
// before recoding. Empty when the finding has no payee.
export async function payeeCodingHistory(
  tenantId: string,
  findingId: string,
): Promise<{ payeeId: string | null; payeeName: string | null; rows: Array<{ accountId: string; accountName: string; count: number; total: string }> }> {
  const f = await getById(tenantId, findingId);
  if (!f) return { payeeId: null, payeeName: null, rows: [] };
  let payeeId = f.vendorId ?? null;
  if (!payeeId && f.transactionId) {
    const t = await db.execute<{ contact_id: string | null }>(sql`
      SELECT contact_id FROM transactions WHERE tenant_id = ${tenantId} AND id = ${f.transactionId} LIMIT 1
    `);
    payeeId = (t.rows[0] as { contact_id: string | null } | undefined)?.contact_id ?? null;
  }
  if (!payeeId) return { payeeId: null, payeeName: null, rows: [] };
  const [pRow] = await db.select({ periodStart: findings.periodStart }).from(findings)
    .where(and(eq(findings.tenantId, tenantId), eq(findings.id, findingId))).limit(1);
  const anchor = String(pRow?.periodStart ?? new Date().toISOString()).slice(0, 10);
  const res = await db.execute<{ account_id: string; account_name: string; n: string; total: string; payee: string | null }>(sql`
    SELECT a.id AS account_id, a.name AS account_name, COUNT(*) AS n,
      SUM(COALESCE(jl.debit, 0) - COALESCE(jl.credit, 0))::TEXT AS total,
      MAX(c.display_name) AS payee
    FROM transactions t
    JOIN journal_lines jl ON jl.transaction_id = t.id
    JOIN accounts a ON a.id = jl.account_id
      AND a.account_type IN ('expense', 'cogs', 'other_expense', 'revenue', 'other_revenue')
    LEFT JOIN contacts c ON c.id = t.contact_id
    WHERE t.tenant_id = ${tenantId}
      AND t.contact_id = ${payeeId}
      AND t.status = 'posted'
      AND t.txn_date >= (${anchor}::date - INTERVAL '12 months')
      AND t.txn_date < ${anchor}::date
    GROUP BY a.id, a.name
    ORDER BY COUNT(*) DESC
    LIMIT 10
  `);
  const rows = res.rows as Array<{ account_id: string; account_name: string; n: string; total: string; payee: string | null }>;
  let payeeName = rows[0]?.payee ?? null;
  if (!payeeName) {
    const c = await db.execute<{ display_name: string }>(sql`SELECT display_name FROM contacts WHERE id = ${payeeId} AND tenant_id = ${tenantId} LIMIT 1`);
    payeeName = (c.rows[0] as { display_name: string } | undefined)?.display_name ?? null;
  }
  return {
    payeeId,
    payeeName,
    rows: rows.map((r) => ({ accountId: r.account_id, accountName: r.account_name, count: Number(r.n), total: r.total })),
  };
}
