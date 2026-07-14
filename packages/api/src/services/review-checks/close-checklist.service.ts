// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Close checklist — the ordered month-end workflow a reviewer walks
// top to bottom: reconcile every bank/credit-card account, clear the
// bank-feed backlog, clear the findings queue, then final-review the
// statements. Task states are DERIVED live from the ledger; only the
// human acts (manual sign-offs + notes) persist in
// close_checklist_signoffs. An auto task that isn't satisfied can
// still be signed off manually ("reconciled outside the app") — the
// sign-off records who accepted it and why.

import { and, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { closeChecklistSignoffs } from '../../db/schema/index.js';
import { BANK_ACCOUNT_DETAIL_TYPES } from '../report.service.js';

export interface CloseChecklistTask {
  key: string;
  section: 'reconciliations' | 'transactions' | 'review' | 'final';
  label: string;
  auto: boolean;
  done: boolean;
  detail: string | null;
  manuallyCompleted: boolean;
  completedAt: string | null;
  note: string | null;
}

function companyCond(companyId: string | null) {
  return companyId ? sql`AND (company_id = ${companyId} OR company_id IS NULL)` : sql``;
}

export async function getCloseChecklist(
  tenantId: string,
  companyId: string | null,
  periodStart: string,
  periodEnd: string,
): Promise<CloseChecklistTask[]> {
  const signoffRows = await db.select().from(closeChecklistSignoffs).where(and(
    eq(closeChecklistSignoffs.tenantId, tenantId),
    companyId ? eq(closeChecklistSignoffs.companyId, companyId) : isNull(closeChecklistSignoffs.companyId),
    eq(closeChecklistSignoffs.periodStart, periodStart),
  ));
  const signoff = new Map(signoffRows.map((r) => [r.taskKey, r]));

  const tasks: CloseChecklistTask[] = [];
  const withSignoff = (t: Omit<CloseChecklistTask, 'manuallyCompleted' | 'completedAt' | 'note'>): CloseChecklistTask => {
    const s = signoff.get(t.key);
    return {
      ...t,
      done: t.done || !!s,
      manuallyCompleted: !!s,
      completedAt: s ? String(s.completedAt) : null,
      note: s?.note ?? null,
    };
  };

  // ── 1. Reconciliations: one task per active bank / credit-card
  //       account, satisfied when a completed reconciliation covers
  //       the period end.
  const detailList = sql.join(BANK_ACCOUNT_DETAIL_TYPES.map((d) => sql`${d}`), sql`, `);
  const accts = await db.execute<{ id: string; name: string; last_reconciled: string | null }>(sql`
    SELECT a.id, a.name, (
      SELECT MAX(r.statement_date) FROM reconciliations r
      WHERE r.tenant_id = ${tenantId} AND r.account_id = a.id AND r.status = 'complete'
    ) AS last_reconciled
    FROM accounts a
    WHERE a.tenant_id = ${tenantId}
      ${companyId ? sql`AND (a.company_id = ${companyId} OR a.company_id IS NULL)` : sql``}
      AND a.is_active = TRUE
      AND (
        (a.account_type = 'asset' AND a.detail_type IN (${detailList}))
        OR a.detail_type = 'credit_card'
      )
    ORDER BY a.name
    LIMIT 50
  `);
  // periodEnd is exclusive (first of next month) — the statement that
  // closes the period is dated on/after the period's last day.
  const lastDay = new Date(`${periodEnd}T00:00:00Z`);
  lastDay.setUTCDate(lastDay.getUTCDate() - 1);
  const periodLastDay = lastDay.toISOString().slice(0, 10);
  for (const a of accts.rows as Array<{ id: string; name: string; last_reconciled: string | null }>) {
    const covered = a.last_reconciled != null && a.last_reconciled >= periodLastDay;
    tasks.push(withSignoff({
      key: `reconcile:${a.id}`,
      section: 'reconciliations',
      label: `Reconcile ${a.name}`,
      auto: true,
      done: covered,
      detail: a.last_reconciled
        ? `Reconciled through ${a.last_reconciled}`
        : 'Never reconciled',
    }));
  }

  // ── 2. Bank-feed backlog: everything dated in/before the period
  //       should be categorized or excluded before closing.
  const feed = await db.execute<{ n: string }>(sql`
    SELECT COUNT(*) AS n FROM bank_feed_items
    WHERE tenant_id = ${tenantId}
      ${companyCond(companyId)}
      AND status IN ('pending', 'assigned')
      AND feed_date < ${periodEnd}
  `);
  const feedCount = Number((feed.rows[0] as { n: string } | undefined)?.n ?? 0);
  tasks.push(withSignoff({
    key: 'bank_feed',
    section: 'transactions',
    label: 'Clear the bank feed',
    auto: true,
    done: feedCount === 0,
    detail: feedCount === 0
      ? 'No bank-feed items awaiting action'
      : `${feedCount} bank-feed item${feedCount === 1 ? '' : 's'} dated in or before this period still need categorizing or approval`,
  }));

  // ── 3. Findings queue: run the checks, then clear what they raise.
  const open = await db.execute<{ n: string }>(sql`
    SELECT COUNT(*) AS n FROM findings
    WHERE tenant_id = ${tenantId}
      ${companyCond(companyId)}
      AND status IN ('open', 'assigned', 'in_review')
  `);
  const openCount = Number((open.rows[0] as { n: string } | undefined)?.n ?? 0);
  tasks.push(withSignoff({
    key: 'findings',
    section: 'review',
    label: 'Clear review-check findings',
    auto: true,
    done: openCount === 0,
    detail: openCount === 0
      ? 'No open findings'
      : `${openCount} finding${openCount === 1 ? '' : 's'} still open — run the checks for this period if you haven't`,
  }));

  // ── 4. Final review: statements read by a human. Manual by nature.
  tasks.push(withSignoff({
    key: 'final_review',
    section: 'final',
    label: 'Final review of the financial statements',
    auto: false,
    done: false,
    detail: 'Read the P&L, Balance Sheet, and A/R–A/P agings for the period; investigate anything that looks off before publishing.',
  }));

  return tasks;
}

export interface ChecklistSignoff {
  taskKey: string;
  note: string | null;
  completedBy: string | null;
  completedAt: string;
}

/** The current sign-off row (if any) — used for audit before-state. */
export async function getSignoff(
  tenantId: string,
  companyId: string | null,
  periodStart: string,
  taskKey: string,
): Promise<ChecklistSignoff | null> {
  const [row] = await db.select().from(closeChecklistSignoffs).where(and(
    eq(closeChecklistSignoffs.tenantId, tenantId),
    companyId ? eq(closeChecklistSignoffs.companyId, companyId) : isNull(closeChecklistSignoffs.companyId),
    eq(closeChecklistSignoffs.periodStart, periodStart),
    eq(closeChecklistSignoffs.taskKey, taskKey),
  )).limit(1);
  if (!row) return null;
  return { taskKey: row.taskKey, note: row.note, completedBy: row.completedBy, completedAt: String(row.completedAt) };
}

export async function completeChecklistTask(
  tenantId: string,
  companyId: string | null,
  periodStart: string,
  taskKey: string,
  note: string | null,
  userId?: string,
): Promise<void> {
  // True upsert against the expression-based unique index (COALESCE on
  // the nullable company) — a delete+insert pair races itself when two
  // reviewers sign off the same task concurrently.
  await db.execute(sql`
    INSERT INTO close_checklist_signoffs (tenant_id, company_id, period_start, task_key, note, completed_by)
    VALUES (${tenantId}, ${companyId}, ${periodStart}, ${taskKey}, ${note}, ${userId ?? null})
    ON CONFLICT (tenant_id, COALESCE(company_id, '00000000-0000-0000-0000-000000000000'::uuid), period_start, task_key)
    DO UPDATE SET note = EXCLUDED.note, completed_by = EXCLUDED.completed_by, completed_at = now()
  `);
}

export async function reopenChecklistTask(
  tenantId: string,
  companyId: string | null,
  periodStart: string,
  taskKey: string,
): Promise<void> {
  await db.delete(closeChecklistSignoffs).where(and(
    eq(closeChecklistSignoffs.tenantId, tenantId),
    companyId ? eq(closeChecklistSignoffs.companyId, companyId) : isNull(closeChecklistSignoffs.companyId),
    eq(closeChecklistSignoffs.periodStart, periodStart),
    eq(closeChecklistSignoffs.taskKey, taskKey),
  ));
}
