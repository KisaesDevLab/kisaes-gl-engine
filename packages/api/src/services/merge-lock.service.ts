// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Closed-period guard for merges (U-47, merge-closing-date-v1). A contact or
// tag merge rewrites transactions of every date (their contact or tag), so
// when one of them is dated on or before the closing date the merge is a
// closed-period edit like any other: it goes through checkLockDate and needs
// the closing-date password (U-15) or, where a company has none, the staff
// override. The guard runs inside the merge's own database transaction,
// before anything is rewritten, and locks the affected transaction rows so
// a concurrent edit cannot slip a date past it.

import { sql, type SQL } from 'drizzle-orm';
import type { DbOrTx } from '../db/index.js';
import { auditLog } from '../middleware/audit.js';
import { checkLockDate, type LockOverride } from './ledger.service.js';

/** At most this many transaction ids are listed in one merge audit row. */
export const MERGE_AUDIT_ID_CAP = 500;

export type MergeKind = 'contact_merge' | 'tag_merge';

/** A capped id list for an audit image: the ids, the full count, and whether ids were cut off. */
export interface AuditIdList {
  count: number;
  ids: string[];
  truncated: boolean;
}

/** What the merge changed in a closed period, for the audit row. */
export interface MergeClosedPeriodOverride extends AuditIdList {
  method: LockOverride['method'];
  lockDates: Array<{ companyId: string | null; lockDate: string }>;
}

export interface MergeAffected {
  transactions: AuditIdList;
  closedPeriodOverride: MergeClosedPeriodOverride | null;
}

function capped(ids: string[]): AuditIdList {
  return {
    count: ids.length,
    ids: ids.slice(0, MERGE_AUDIT_ID_CAP),
    truncated: ids.length > MERGE_AUDIT_ID_CAP,
  };
}

/**
 * Finds the transactions a merge is about to rewrite (`affectedIds`, a
 * subquery returning transaction ids), locks them FOR UPDATE, and applies
 * the closing date to the ones dated on or before it: one checkLockDate per
 * company, so a missing or wrong password throws (423 TB_PERIOD_LOCKED /
 * 403 CLOSING_PASSWORD_INVALID) and the caller's transaction rolls back
 * before anything changed. A permitted override writes one
 * closing_date_override row per company, in the same transaction.
 */
export async function guardMergeTransactions(
  tx: DbOrTx,
  tenantId: string,
  affectedIds: SQL,
  merge: { kind: MergeKind; sourceId: string; targetId: string; userId?: string },
): Promise<MergeAffected> {
  // A transaction without a company falls under the strictest closing date
  // of the tenant, exactly as checkLockDate treats a scope-less posting.
  const result = await tx.execute(sql`
    SELECT t.id, t.company_id, t.txn_date::text AS txn_date,
           (CASE WHEN t.company_id IS NULL
                 THEN (SELECT MAX(lock_date) FROM companies WHERE tenant_id = ${tenantId})
                 ELSE c.lock_date END)::text AS lock_date
    FROM transactions t
    LEFT JOIN companies c ON c.id = t.company_id AND c.tenant_id = t.tenant_id
    WHERE t.tenant_id = ${tenantId} AND t.id IN (${affectedIds})
    ORDER BY t.txn_date, t.id
    FOR UPDATE OF t
  `);
  const rows = result.rows as Array<{ id: string; company_id: string | null; txn_date: string; lock_date: string | null }>;

  const closed = rows.filter((r) => r.lock_date !== null && r.txn_date <= r.lock_date);
  const transactions = capped(rows.map((r) => r.id));
  if (closed.length === 0) return { transactions, closedPeriodOverride: null };

  // Earliest closed date per company (rows are date-ordered, so the first
  // seen). Every closed row of a company shares its lock date, so one check
  // per company covers them all; the password is compared once per hash.
  const byCompany = new Map<string | null, { txnDate: string; count: number }>();
  for (const r of closed) {
    const seen = byCompany.get(r.company_id);
    if (seen) seen.count += 1;
    else byCompany.set(r.company_id, { txnDate: r.txn_date, count: 1 });
  }

  const overrides: Array<{ override: LockOverride; count: number }> = [];
  for (const [companyId, { txnDate, count }] of byCompany) {
    const override = await checkLockDate(tx, tenantId, txnDate, companyId, undefined, { deferAudit: true });
    if (override) overrides.push({ override, count });
  }
  if (overrides.length === 0) return { transactions, closedPeriodOverride: null };

  for (const { override, count } of overrides) {
    await auditLog(tenantId, 'override', 'closing_date_override', override.companyId ?? tenantId,
      { lockDate: override.lockDate, lockDateSetBy: override.lockDateSetBy, lockDateSetAt: override.lockDateSetAt },
      {
        txnDate: override.txnDate,
        method: override.method,
        overrideConfirmed: override.method === 'confirmed',
        transactionId: null,
        oldDate: null,
        newDate: null,
        companyId: override.companyId,
        context: merge.kind,
        mergeSourceId: merge.sourceId,
        mergeTargetId: merge.targetId,
        transactionCount: count,
      },
      merge.userId, tx);
  }

  // 'password' wins when both methods were used across companies.
  const method: LockOverride['method'] = overrides.some((o) => o.override.method === 'password') ? 'password' : 'confirmed';
  return {
    transactions,
    closedPeriodOverride: {
      ...capped(closed.map((r) => r.id)),
      method,
      lockDates: overrides.map((o) => ({ companyId: o.override.companyId, lockDate: String(o.override.lockDate) })),
    },
  };
}
