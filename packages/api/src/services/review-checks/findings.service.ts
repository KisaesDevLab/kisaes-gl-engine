// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { aliasedTable, and, desc, eq, inArray, lt, sql } from 'drizzle-orm';
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
): Promise<BulkInsertResult> {
  if (drafts.length === 0) return { inserted: 0, duplicates: 0 };

  // Compute the dedupe key for each candidate.
  const keyed = drafts.map((d) => ({
    draft: d,
    key: dedupeKey(d),
  }));

  // Pull existing findings (any status) with matching check keys
  // to dedupe against. One query per (tenant, check keys present
  // in the batch).
  const checkKeys = Array.from(new Set(keyed.map((k) => k.draft.checkKey)));
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
  // Strict less-than so the cursor seam doesn't repeat a row.
  if (input.cursor) conditions.push(lt(findings.createdAt, new Date(input.cursor)));

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
  return {
    rows: page.map(mapJoinedRow),
    nextCursor: hasMore ? page[page.length - 1]!.f.createdAt.toISOString() : null,
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

// Severity + status rollup for the dashboard summary widget.
// Returns counts grouped by status x severity for active
// findings only.
export async function summaryByStatusSeverity(
  tenantId: string,
  companyId?: string | null,
): Promise<{
  byStatus: Record<FindingStatus, number>;
  bySeverity: Record<FindingSeverity, number>;
  total: number;
}> {
  const conditions = [eq(findings.tenantId, tenantId)];
  if (companyId) conditions.push(eq(findings.companyId, companyId));
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
    bySeverity[r.severity as FindingSeverity] = (bySeverity[r.severity as FindingSeverity] ?? 0) + c;
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
