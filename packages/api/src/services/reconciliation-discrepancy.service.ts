// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

/**
 * Reconciliation discrepancy report (U-191, reconcile-discrepancy-v1):
 * what changed in an account's reconciled history since each reconciliation
 * was finished. GET /reports/reconciliation-discrepancy?account_id=
 *
 * Rows come from three places:
 *   changed / voided / deleted  audit rows (update, void, delete; the
 *        reconciled-entry partial edit included) on an entry with a line
 *        cleared in a completed reconciliation of the account, written after
 *        that reconciliation was finished;
 *   added_after  entries posted on the account, dated on or before a
 *        completed reconciliation's statement date but entered after it was
 *        finished, and not cleared in any completed reconciliation (the
 *        posted_into_reconciled_range review check, every reconciliation);
 *   reconciliation_undone  the undo audit rows (U-190).
 *
 * Amounts are decimal strings in the account's books sign. `fields` lists the
 * names of what changed, never the values (no memo text). `effect` is the
 * change to the reconciled amount ('0.0000' for a category-only edit).
 */

import { sql } from 'drizzle-orm';
import DecimalLib from 'decimal.js';
const Decimal = DecimalLib.default || DecimalLib;
type Dec = InstanceType<typeof Decimal>;
import { db } from '../db/index.js';
import { AppError } from '../utils/errors.js';
import { latestCompletedDrift } from './reconciliation.service.js';

export type DiscrepancyKind = 'changed' | 'voided' | 'deleted' | 'added_after' | 'reconciliation_undone';

export interface DiscrepancyRow {
  kind: DiscrepancyKind;
  reconciliationId: string;
  statementDate: string | null;
  transactionId: string | null;
  txnDate: string | null;
  txnType: string | null;
  number: string | null;
  payee: string | null;
  reconciledAmount: string | null;
  effect: string;
  changedAt: string;
  changedBy: string | null;
  fields: string[];
  /** reconciliation_undone only: clear_checks | keep_checks | discard. */
  undoMode?: string;
}

type Json = Record<string, unknown>;

/** Audit images are stored as jsonb; older writers stored a JSON string. */
function image(v: unknown): Json | null {
  if (v == null) return null;
  if (typeof v === 'string') {
    try { return JSON.parse(v) as Json; } catch { return null; }
  }
  return v as Json;
}

function day(v: unknown): string | null {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
}

function iso(v: unknown): string {
  return v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString();
}

const d4 = (v: unknown) => new Decimal(v == null || v === '' ? '0' : String(v)).toFixed(4);

interface LineImage { accountId: string; debit: unknown; credit: unknown; description?: unknown; tagId?: unknown; isVoidReversal?: unknown }

function linesOf(img: Json | null): LineImage[] {
  const lines = (img?.['lines'] ?? []) as LineImage[];
  return lines.filter((l) => l && l.isVoidReversal !== true);
}

function onAccount(lines: LineImage[], accountId: string): Dec {
  return lines.filter((l) => l.accountId === accountId)
    .reduce((acc, l) => acc.plus(d4(l.debit)).minus(d4(l.credit)), new Decimal(0));
}

function bag(values: string[]): string {
  return [...values].sort().join('\n');
}

/** Names of what differs between two images of an entry (header + lines). */
function changedFields(before: Json, after: Json, accountId: string): string[] {
  const fields: string[] = [];
  const header: Array<[string, string]> = [
    ['txnDate', 'date'], ['contactId', 'payee'], ['payeeNameOnCheck', 'payee'], ['memo', 'memo'],
    ['txnNumber', 'number'], ['checkNumber', 'number'], ['status', 'status'],
  ];
  for (const [key, name] of header) {
    const a = key === 'txnDate' ? day(before[key]) : before[key] ?? null;
    const b = key === 'txnDate' ? day(after[key]) : after[key] ?? null;
    if (String(a ?? '') !== String(b ?? '') && !fields.includes(name)) fields.push(name);
  }
  const bl = linesOf(before);
  const al = linesOf(after);
  if (!onAccount(bl, accountId).equals(onAccount(al, accountId))) fields.push('amount');
  const other = (ls: LineImage[]) => bag(ls.filter((l) => l.accountId !== accountId).map((l) => `${l.accountId}|${d4(l.debit)}|${d4(l.credit)}`));
  if (other(bl) !== other(al)) fields.push('category');
  const desc = (ls: LineImage[]) => bag(ls.map((l) => String(l.description ?? '')));
  if (desc(bl) !== desc(al)) fields.push('line_description');
  const tags = (ls: LineImage[]) => bag(ls.map((l) => String(l.tagId ?? '')));
  if (tags(bl) !== tags(al)) fields.push('tags');
  return fields;
}

export async function buildReconciliationDiscrepancy(tenantId: string, accountId: string) {
  const acct = await db.execute(sql`SELECT id FROM accounts WHERE tenant_id = ${tenantId} AND id = ${accountId}`);
  if ((acct.rows as unknown[]).length === 0) throw AppError.notFound('Account not found');

  const rows: DiscrepancyRow[] = [];

  // ── changed / voided / deleted ──
  const audited = await db.execute(sql`
    WITH rec_txn AS (
      SELECT r.id AS reconciliation_id, r.statement_date, r.completed_at, jl.transaction_id,
        SUM(jl.debit - jl.credit)::text AS reconciled_amount
      FROM reconciliations r
      JOIN reconciliation_lines rl ON rl.reconciliation_id = r.id AND rl.is_cleared = true
      JOIN journal_lines jl ON jl.id = rl.journal_line_id
      WHERE r.tenant_id = ${tenantId} AND r.account_id = ${accountId} AND r.status = 'complete'
      GROUP BY r.id, r.statement_date, r.completed_at, jl.transaction_id
    )
    SELECT rt.reconciliation_id, rt.statement_date::text AS statement_date, rt.transaction_id, rt.reconciled_amount,
      a.id AS audit_id, a.action, a.before_data, a.after_data, a.created_at AS changed_at,
      u.display_name AS changed_by
    FROM rec_txn rt
    JOIN audit_log a ON a.tenant_id = ${tenantId} AND a.entity_type = 'transaction'
      AND a.entity_id = rt.transaction_id AND a.action IN ('update', 'void', 'delete')
      AND a.created_at > rt.completed_at
    LEFT JOIN users u ON u.id = a.user_id
    ORDER BY a.created_at, a.id
  `);
  const auditRows = audited.rows as Array<{
    reconciliation_id: string; statement_date: string; transaction_id: string; reconciled_amount: string;
    audit_id: number; action: string; before_data: unknown; after_data: unknown; changed_at: unknown; changed_by: string | null;
  }>;

  const txnIds = [...new Set(auditRows.map((r) => r.transaction_id))];
  // Each entry's later images: the before-image of the next audit row, else
  // the entry as it stands now.
  const later = new Map<string, Array<{ id: number; before: Json | null }>>();
  const current = new Map<string, Json>();
  if (txnIds.length > 0) {
    const ids = `{${txnIds.join(',')}}`;
    const allAudit = await db.execute(sql`
      SELECT id, entity_id, before_data FROM audit_log
      WHERE tenant_id = ${tenantId} AND entity_type = 'transaction'
        AND entity_id = ANY(${ids}::uuid[]) AND action IN ('update', 'void', 'delete')
      ORDER BY created_at, id
    `);
    for (const r of allAudit.rows as Array<{ id: number; entity_id: string; before_data: unknown }>) {
      const list = later.get(r.entity_id) ?? [];
      list.push({ id: Number(r.id), before: image(r.before_data) });
      later.set(r.entity_id, list);
    }
    const txns = await db.execute(sql`
      SELECT t.id, t.txn_date::text AS txn_date, t.txn_type, t.txn_number, t.check_number, t.contact_id,
        t.payee_name_on_check, t.memo, t.status, c.display_name AS contact_name
      FROM transactions t LEFT JOIN contacts c ON c.id = t.contact_id
      WHERE t.tenant_id = ${tenantId} AND t.id = ANY(${ids}::uuid[])
    `);
    const lines = await db.execute(sql`
      SELECT transaction_id, account_id, debit::text AS debit, credit::text AS credit, description, tag_id, is_void_reversal
      FROM journal_lines WHERE tenant_id = ${tenantId} AND transaction_id = ANY(${ids}::uuid[])
    `);
    const linesBy = new Map<string, LineImage[]>();
    for (const l of lines.rows as Array<{ transaction_id: string; account_id: string; debit: string; credit: string; description: string | null; tag_id: string | null; is_void_reversal: boolean }>) {
      const list = linesBy.get(l.transaction_id) ?? [];
      list.push({ accountId: l.account_id, debit: l.debit, credit: l.credit, description: l.description, tagId: l.tag_id, isVoidReversal: l.is_void_reversal });
      linesBy.set(l.transaction_id, list);
    }
    for (const t of txns.rows as Array<{ id: string; txn_date: string; txn_type: string; txn_number: string | null; check_number: number | null; contact_id: string | null; payee_name_on_check: string | null; memo: string | null; status: string; contact_name: string | null }>) {
      current.set(t.id, {
        txnDate: t.txn_date, txnType: t.txn_type, txnNumber: t.txn_number, checkNumber: t.check_number,
        contactId: t.contact_id, payeeNameOnCheck: t.payee_name_on_check, memo: t.memo, status: t.status,
        contactName: t.contact_name, lines: linesBy.get(t.id) ?? [],
      });
    }
  }

  for (const r of auditRows) {
    const before = image(r.before_data) ?? {};
    const cur = current.get(r.transaction_id) ?? {};
    const chain = later.get(r.transaction_id) ?? [];
    const idx = chain.findIndex((c) => c.id === Number(r.audit_id));
    const nextImage = (idx >= 0 && idx + 1 < chain.length ? chain[idx + 1]!.before : null) ?? cur;
    const reconciled = new Decimal(r.reconciled_amount);
    let kind: DiscrepancyKind;
    let effect: Dec;
    let fields: string[];
    if (r.action === 'void' || r.action === 'delete') {
      kind = r.action === 'void' ? 'voided' : 'deleted';
      effect = reconciled.negated();
      fields = ['status'];
    } else {
      kind = 'changed';
      effect = onAccount(linesOf(nextImage), accountId).minus(onAccount(linesOf(before), accountId));
      fields = changedFields(before, nextImage, accountId);
      if (fields.length === 0 && effect.isZero()) continue;
    }
    rows.push({
      kind,
      reconciliationId: r.reconciliation_id,
      statementDate: day(r.statement_date),
      transactionId: r.transaction_id,
      txnDate: day(before['txnDate'] ?? cur['txnDate']),
      txnType: (before['txnType'] ?? cur['txnType'] ?? null) as string | null,
      number: numberOf(cur, before),
      payee: (cur['contactName'] ?? cur['payeeNameOnCheck'] ?? null) as string | null,
      reconciledAmount: reconciled.toFixed(4),
      effect: effect.toFixed(4),
      changedAt: iso(r.changed_at),
      changedBy: r.changed_by ?? null,
      fields,
    });
  }

  // ── added_after ──
  const added = await db.execute(sql`
    SELECT DISTINCT ON (t.id) t.id, t.txn_date::text AS txn_date, t.txn_type, t.txn_number, t.check_number,
      t.payee_name_on_check, c.display_name AS contact_name, t.created_at,
      r.id AS reconciliation_id, r.statement_date::text AS statement_date,
      (SELECT SUM(x.debit - x.credit)::text FROM journal_lines x
        WHERE x.transaction_id = t.id AND x.account_id = ${accountId} AND x.is_void_reversal = false) AS amount,
      (SELECT u.display_name FROM audit_log al LEFT JOIN users u ON u.id = al.user_id
        WHERE al.tenant_id = ${tenantId} AND al.entity_type = 'transaction' AND al.entity_id = t.id AND al.action = 'create'
        ORDER BY al.created_at LIMIT 1) AS created_by
    FROM transactions t
    JOIN journal_lines jl ON jl.transaction_id = t.id AND jl.tenant_id = ${tenantId} AND jl.account_id = ${accountId}
    JOIN reconciliations r ON r.tenant_id = ${tenantId} AND r.account_id = ${accountId} AND r.status = 'complete'
      AND t.txn_date <= r.statement_date AND t.created_at > r.completed_at
    LEFT JOIN contacts c ON c.id = t.contact_id
    WHERE t.tenant_id = ${tenantId} AND t.status = 'posted'
      AND NOT EXISTS (
        SELECT 1 FROM reconciliation_lines rl
        JOIN reconciliations r2 ON r2.id = rl.reconciliation_id
        WHERE rl.journal_line_id = jl.id AND rl.is_cleared = true AND r2.status = 'complete'
      )
    ORDER BY t.id, r.statement_date ASC
  `);
  for (const t of added.rows as Array<{ id: string; txn_date: string; txn_type: string; txn_number: string | null; check_number: number | null; payee_name_on_check: string | null; contact_name: string | null; created_at: unknown; reconciliation_id: string; statement_date: string; amount: string | null; created_by: string | null }>) {
    rows.push({
      kind: 'added_after',
      reconciliationId: t.reconciliation_id,
      statementDate: day(t.statement_date),
      transactionId: t.id,
      txnDate: day(t.txn_date),
      txnType: t.txn_type,
      number: t.txn_number ?? (t.check_number != null ? String(t.check_number) : null),
      payee: t.contact_name ?? t.payee_name_on_check ?? null,
      reconciledAmount: null,
      effect: d4(t.amount),
      changedAt: iso(t.created_at),
      changedBy: t.created_by ?? null,
      fields: [],
    });
  }

  // ── reconciliation_undone ──
  const undos = await db.execute(sql`
    SELECT a.entity_id, a.before_data, a.after_data, a.created_at, u.display_name AS changed_by
    FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
    WHERE a.tenant_id = ${tenantId} AND a.entity_type = 'reconciliation' AND a.action = 'update'
      AND (CASE WHEN jsonb_typeof(a.after_data) = 'string' THEN (a.after_data #>> '{}')::jsonb ELSE a.after_data END) ? 'undo'
      AND (CASE WHEN jsonb_typeof(a.before_data) = 'string' THEN (a.before_data #>> '{}')::jsonb ELSE a.before_data END)
        ->> 'accountId' = ${accountId}
    ORDER BY a.created_at, a.id
  `);
  for (const u of undos.rows as Array<{ entity_id: string; before_data: unknown; after_data: unknown; created_at: unknown; changed_by: string | null }>) {
    const before = image(u.before_data) ?? {};
    const after = image(u.after_data) ?? {};
    const ids: string[] = Array.isArray(before['clearedLineIds']) ? (before['clearedLineIds'] as string[]) : [];
    let net = new Decimal(0);
    if (ids.length > 0) {
      const res = await db.execute(sql`
        SELECT COALESCE(SUM(debit - credit), 0)::text AS net FROM journal_lines
        WHERE tenant_id = ${tenantId} AND id = ANY(${`{${ids.join(',')}}`}::uuid[])
      `);
      net = new Decimal((res.rows as Array<{ net: string }>)[0]?.net ?? '0');
    }
    rows.push({
      kind: 'reconciliation_undone',
      reconciliationId: u.entity_id,
      statementDate: day(before['statementDate']),
      transactionId: null,
      txnDate: null,
      txnType: null,
      number: null,
      payee: null,
      reconciledAmount: net.toFixed(4),
      effect: net.negated().toFixed(4),
      changedAt: iso(u.created_at),
      changedBy: u.changed_by ?? null,
      fields: [],
      undoMode: String((after['undo'] as { mode?: string } | undefined)?.mode ?? 'clear_checks'),
    });
  }

  rows.sort((a, b) => (b.statementDate ?? '').localeCompare(a.statementDate ?? '') || a.changedAt.localeCompare(b.changedAt));
  const drift = await latestCompletedDrift(tenantId, accountId);
  return { accountId, rows, drift };
}

function numberOf(cur: Json, before: Json): string | null {
  const n = cur['txnNumber'] ?? before['txnNumber'];
  if (n != null && n !== '') return String(n);
  const c = cur['checkNumber'] ?? before['checkNumber'];
  return c != null ? String(c) : null;
}
