// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { sql } from 'drizzle-orm';
import type { CloseStatus } from '@kis-books/shared';
import { db } from '../../db/index.js';
import { AppError } from '../../utils/errors.js';
import { auditLog } from '../../middleware/audit.js';

// Month-end close record for one company + month: status and the
// preparer → reviewer sign-off chain.
//
//   not_started ── first completed check run ──► in_progress
//   in_progress ── preparer signs ──────────────► prepared
//   prepared ───── reviewer signs ──────────────► closed
//   Undo walks back one step (reviewer first).

export interface CloseRecord {
  companyId: string | null;
  periodStart: string;
  periodEnd: string;
  status: CloseStatus;
  preparedBy: string | null;
  preparedByName: string | null;
  preparedAt: string | null;
  preparedNote: string | null;
  reviewedBy: string | null;
  reviewedByName: string | null;
  reviewedAt: string | null;
  reviewedNote: string | null;
  openFindings: number;
  hasRun: boolean;
}

const ZERO = '00000000-0000-0000-0000-000000000000';
const d = (v: string) => v.slice(0, 10);

function companyMatch(companyId: string | null) {
  return sql`COALESCE(c.company_id, ${ZERO}::uuid) = COALESCE(${companyId}::uuid, ${ZERO}::uuid)`;
}

async function ensureRow(tenantId: string, companyId: string | null, periodStart: string, periodEnd: string) {
  await db.execute(sql`
    INSERT INTO closes (tenant_id, company_id, period_start, period_end)
    VALUES (${tenantId}, ${companyId}, ${d(periodStart)}::date, ${d(periodEnd)}::date)
    ON CONFLICT (tenant_id, COALESCE(company_id, '00000000-0000-0000-0000-000000000000'::uuid), period_start)
    DO NOTHING
  `);
}

/** Called when a check run for the month completes. */
export async function markInProgress(tenantId: string, companyId: string | null, periodStart: string, periodEnd: string): Promise<void> {
  await ensureRow(tenantId, companyId, periodStart, periodEnd);
  await db.execute(sql`
    UPDATE closes c SET status = 'in_progress', updated_at = now()
    WHERE c.tenant_id = ${tenantId} AND ${companyMatch(companyId)}
      AND c.period_start = ${d(periodStart)}::date AND c.status = 'not_started'
  `);
}

export async function getClose(
  tenantId: string,
  companyId: string | null,
  periodStart: string,
  periodEnd: string,
): Promise<CloseRecord> {
  const rows = await db.execute<{
    status: string; prepared_by: string | null; prepared_at: string | null; prepared_note: string | null;
    reviewed_by: string | null; reviewed_at: string | null; reviewed_note: string | null;
    prepared_name: string | null; reviewed_name: string | null;
  }>(sql`
    SELECT c.status, c.prepared_by, c.prepared_at, c.prepared_note,
      c.reviewed_by, c.reviewed_at, c.reviewed_note,
      COALESCE(pu.display_name, pu.email) AS prepared_name,
      COALESCE(ru.display_name, ru.email) AS reviewed_name
    FROM closes c
    LEFT JOIN users pu ON pu.id = c.prepared_by
    LEFT JOIN users ru ON ru.id = c.reviewed_by
    WHERE c.tenant_id = ${tenantId} AND ${companyMatch(companyId)}
      AND c.period_start = ${d(periodStart)}::date
    LIMIT 1
  `);
  const r = rows.rows[0] as undefined | {
    status: string; prepared_by: string | null; prepared_at: string | null; prepared_note: string | null;
    reviewed_by: string | null; reviewed_at: string | null; reviewed_note: string | null;
    prepared_name: string | null; reviewed_name: string | null;
  };
  const companyCond = companyId ? sql`AND company_id = ${companyId}` : sql``;
  const counts = await db.execute<{ open: string; runs: string }>(sql`
    SELECT
      (SELECT COUNT(*) FROM findings WHERE tenant_id = ${tenantId} ${companyCond}
         AND status IN ('open', 'assigned', 'in_review')
         AND period_start >= ${d(periodStart)}::date AND period_start < ${d(periodEnd)}::date) AS open,
      (SELECT COUNT(*) FROM check_runs WHERE tenant_id = ${tenantId} ${companyCond}
         AND completed_at IS NOT NULL AND period_start = ${d(periodStart)}::date) AS runs
  `);
  const c = counts.rows[0] as { open: string; runs: string } | undefined;
  const iso = (v: string | null) => (v ? new Date(v).toISOString() : null);
  return {
    companyId,
    periodStart: d(periodStart),
    periodEnd: d(periodEnd),
    status: (r?.status ?? 'not_started') as CloseStatus,
    preparedBy: r?.prepared_by ?? null,
    preparedByName: r?.prepared_name ?? null,
    preparedAt: iso(r?.prepared_at ?? null),
    preparedNote: r?.prepared_note ?? null,
    reviewedBy: r?.reviewed_by ?? null,
    reviewedByName: r?.reviewed_name ?? null,
    reviewedAt: iso(r?.reviewed_at ?? null),
    reviewedNote: r?.reviewed_note ?? null,
    openFindings: Number(c?.open ?? 0),
    hasRun: Number(c?.runs ?? 0) > 0,
  };
}

export async function sign(
  tenantId: string,
  companyId: string | null,
  periodStart: string,
  periodEnd: string,
  role: 'preparer' | 'reviewer',
  userId: string,
  note: string | null,
): Promise<CloseRecord> {
  const current = await getClose(tenantId, companyId, periodStart, periodEnd);
  if (role === 'preparer') {
    if (!current.hasRun) throw AppError.badRequest('Run the checks for this month before signing it off.', 'CLOSE_NOT_REVIEWED');
    if (current.status === 'prepared' || current.status === 'closed') {
      throw AppError.badRequest('This month is already signed off by the preparer.', 'CLOSE_ALREADY_PREPARED');
    }
    await ensureRow(tenantId, companyId, periodStart, periodEnd);
    await db.execute(sql`
      UPDATE closes c SET status = 'prepared', prepared_by = ${userId}, prepared_at = now(),
        prepared_note = ${note}, updated_at = now()
      WHERE c.tenant_id = ${tenantId} AND ${companyMatch(companyId)} AND c.period_start = ${d(periodStart)}::date
    `);
  } else {
    if (current.status !== 'prepared') {
      throw AppError.badRequest(
        current.status === 'closed' ? 'This month is already closed.' : 'The preparer has to sign off before the reviewer.',
        'CLOSE_NOT_PREPARED',
      );
    }
    await db.execute(sql`
      UPDATE closes c SET status = 'closed', reviewed_by = ${userId}, reviewed_at = now(),
        reviewed_note = ${note}, updated_at = now()
      WHERE c.tenant_id = ${tenantId} AND ${companyMatch(companyId)} AND c.period_start = ${d(periodStart)}::date
    `);
  }
  await auditLog(tenantId, 'update', 'close', null, { status: current.status },
    { action: `sign_${role}`, companyId, periodStart: d(periodStart), note }, userId);
  return getClose(tenantId, companyId, periodStart, periodEnd);
}

export async function unsign(
  tenantId: string,
  companyId: string | null,
  periodStart: string,
  periodEnd: string,
  userId: string,
): Promise<CloseRecord> {
  const current = await getClose(tenantId, companyId, periodStart, periodEnd);
  if (current.status === 'closed') {
    await db.execute(sql`
      UPDATE closes c SET status = 'prepared', reviewed_by = NULL, reviewed_at = NULL, reviewed_note = NULL, updated_at = now()
      WHERE c.tenant_id = ${tenantId} AND ${companyMatch(companyId)} AND c.period_start = ${d(periodStart)}::date
    `);
  } else if (current.status === 'prepared') {
    await db.execute(sql`
      UPDATE closes c SET status = 'in_progress', prepared_by = NULL, prepared_at = NULL, prepared_note = NULL, updated_at = now()
      WHERE c.tenant_id = ${tenantId} AND ${companyMatch(companyId)} AND c.period_start = ${d(periodStart)}::date
    `);
  } else {
    throw AppError.badRequest('There is no sign-off to undo for this month.', 'CLOSE_NOTHING_TO_UNDO');
  }
  await auditLog(tenantId, 'update', 'close', null, { status: current.status },
    { action: 'undo_signoff', companyId, periodStart: d(periodStart) }, userId);
  return getClose(tenantId, companyId, periodStart, periodEnd);
}

/** Close status per company for one month (Practice → Clients column). */
export async function statusesForMonth(tenantIds: string[], periodStart: string): Promise<Map<string, CloseStatus>> {
  const out = new Map<string, CloseStatus>();
  if (tenantIds.length === 0) return out;
  const rows = await db.execute<{ tenant_id: string; status: string }>(sql`
    SELECT tenant_id, status FROM closes
    WHERE tenant_id IN (${sql.join(tenantIds.map((t) => sql`${t}::uuid`), sql`, `)})
      AND period_start = ${d(periodStart)}::date
  `);
  const rank: Record<string, number> = { not_started: 0, in_progress: 1, prepared: 2, closed: 3 };
  for (const r of rows.rows as Array<{ tenant_id: string; status: string }>) {
    // A tenant with several companies shows its least-advanced close.
    const prev = out.get(r.tenant_id);
    if (!prev || rank[r.status]! < rank[prev]!) out.set(r.tenant_id, r.status as CloseStatus);
  }
  return out;
}
