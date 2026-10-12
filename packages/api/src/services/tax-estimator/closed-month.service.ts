// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// The LAST CLOSED MONTH rule (MODULE.md "Books readiness"), shared by the
// readiness service and the P&L provider's default range end (R1 F5). Callers
// run the D1 scope guard first; every query here is pinned to that tenant and
// company.
//
//   * Reconcilable accounts = the company's (or tenant-level) asset accounts
//     with a bank detail type (report.service BANK_ACCOUNT_DETAIL_TYPES) and
//     liability accounts with a credit-card / line-of-credit detail type
//     (RECONCILABLE_LIABILITY_DETAIL_TYPES) — the Bank Reconciliation Summary set.
//   * An account counts only if it has GL activity (either side) in
//     [tax-year start, range end] on the company — dormant accounts never block.
//   * An account is closed through the month of its latest COMPLETED
//     reconciliation's statement_date when that date is the month's last day,
//     otherwise through the PREVIOUS month (a statement ending Sep 27 does
//     not cover Sep 28-30). In-progress reconciliations do not count.
//   * R1 F11: an account NEVER reconciled, with no activity before the tax
//     year, did not exist before its first activity — it is closed through the
//     month BEFORE its first activity month (a card opened Sep 20 does not
//     reopen Jan-Aug). One never reconciled but active before the tax year is
//     not closed at all.
//   * Last closed month = the earliest closed-through month across the counted
//     accounts, capped at the tax year's last month; null when any counted
//     account is not closed or the result falls before the tax year.

import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import type { ReadinessAccount, ThroughMonthSource } from '@kis-books/shared';
import { db } from '../../db/index.js';
import { accounts, reconciliations } from '../../db/schema/index.js';
import {
  BANK_ACCOUNT_DETAIL_TYPES, RECONCILABLE_LIABILITY_DETAIL_TYPES, buildAccountDetailReport,
} from '../report.service.js';
import { monthEnd, prevMonth, resolveThroughMonth, type TaxYearWindow } from './periods.js';

/** Month covered by a completed reconciliation's statement date. */
export function closedThroughMonthOf(statementDate: string): string {
  const ym = statementDate.slice(0, 7);
  if (statementDate.slice(0, 10) === monthEnd(ym)) return ym;
  return prevMonth(ym);
}

const asDateString = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
};

const dayBefore = (iso: string) => new Date(new Date(`${iso}T00:00:00Z`).getTime() - 86_400_000).toISOString().slice(0, 10);

export interface ReconciliationStatus {
  accounts: ReadinessAccount[];
  lastClosedMonth: string | null;
}

/** Reconciliation status of the company's bank / card accounts for [window.start, rangeEndMonth]. */
export async function reconciliationStatus(
  tenantId: string, companyId: string, window: TaxYearWindow, rangeEndMonth: string,
): Promise<ReconciliationStatus> {
  const rangeEnd = monthEnd(rangeEndMonth);
  const recAccounts = await db.select({
    id: accounts.id, accountNumber: accounts.accountNumber, name: accounts.name,
    accountType: accounts.accountType, detailType: accounts.detailType,
  }).from(accounts)
    .where(and(
      eq(accounts.tenantId, tenantId),
      or(eq(accounts.companyId, companyId), isNull(accounts.companyId)),
      or(
        and(eq(accounts.accountType, 'asset'), inArray(accounts.detailType, BANK_ACCOUNT_DETAIL_TYPES)),
        and(eq(accounts.accountType, 'liability'), inArray(accounts.detailType, RECONCILABLE_LIABILITY_DETAIL_TYPES)),
      ),
    ))
    .orderBy(accounts.accountNumber, accounts.name);
  if (recAccounts.length === 0) return { accounts: [], lastClosedMonth: null };

  const ids = recAccounts.map((a) => a.id);
  const recRows = await db.select({
    accountId: reconciliations.accountId, status: reconciliations.status, statementDate: reconciliations.statementDate,
  }).from(reconciliations)
    .where(and(eq(reconciliations.tenantId, tenantId), inArray(reconciliations.accountId, ids)));

  // Activity dates in range (existing report builder, detail mode, both sides).
  const datesByAccount = new Map<string, string[]>();
  const detail = await buildAccountDetailReport(tenantId, window.start, rangeEnd, {
    title: 'tax-estimator-readiness', accountTypes: ['asset', 'liability'], normalSide: 'debit',
    companyId, accountIds: ids, detail: true,
  });
  if ('groups' in detail) {
    for (const g of detail.groups) {
      const dates = g.lines.map((l) => asDateString(l.date)).filter((d): d is string => !!d).sort();
      if (dates.length > 0) datesByAccount.set(g.accountId, dates);
    }
  }

  const status = recAccounts.map((a) => {
    const mine = recRows.filter((r) => r.accountId === a.id);
    const completed = mine
      .filter((r) => r.status === 'complete')
      .map((r) => asDateString(r.statementDate))
      .filter((d): d is string => !!d)
      .sort();
    const latest = completed.length > 0 ? completed[completed.length - 1]! : null;
    const dates = datesByAccount.get(a.id) ?? [];
    return { a, mine, latest, firstActivity: dates[0] ?? null };
  });

  // Never-reconciled accounts with activity: did they exist before the tax year?
  const neverReconciled = status.filter((s) => !s.latest && s.firstActivity).map((s) => s.a.id);
  const activeBefore = new Set<string>();
  if (neverReconciled.length > 0) {
    for (const side of ['debit', 'credit'] as const) {
      const r = await buildAccountDetailReport(tenantId, '1900-01-01', dayBefore(window.start), {
        title: 'tax-estimator-readiness-prior', accountTypes: ['asset', 'liability'], normalSide: side,
        companyId, accountIds: neverReconciled,
      });
      for (const row of r.data as unknown as Array<{ account_id: string }>) activeBefore.add(row.account_id);
    }
  }

  const out: ReadinessAccount[] = status.map(({ a, mine, latest, firstActivity }) => {
    let closedThroughMonth: string | null = null;
    let closedThroughSource: ReadinessAccount['closedThroughSource'] = null;
    if (latest) {
      closedThroughMonth = closedThroughMonthOf(latest);
      closedThroughSource = 'reconciliation';
    } else if (firstActivity && !activeBefore.has(a.id)) {
      closedThroughMonth = prevMonth(firstActivity.slice(0, 7));
      closedThroughSource = 'before_first_activity';
    }
    return {
      accountId: a.id,
      accountNumber: a.accountNumber,
      name: a.name,
      kind: a.accountType === 'asset' ? 'bank' : 'credit_card',
      reconciledThrough: latest,
      closedThroughMonth,
      closedThroughSource,
      firstActivityMonth: firstActivity ? firstActivity.slice(0, 7) : null,
      hasInProgressReconciliation: mine.some((r) => r.status !== 'complete'),
      hasActivityInRange: !!firstActivity,
    };
  });

  const counted = out.filter((a) => a.hasActivityInRange);
  let lastClosedMonth: string | null = null;
  if (counted.length > 0 && counted.every((a) => a.closedThroughMonth !== null)) {
    lastClosedMonth = counted.map((a) => a.closedThroughMonth!).sort()[0]!;
    if (lastClosedMonth > window.endMonth) lastClosedMonth = window.endMonth;
    if (lastClosedMonth < window.startMonth) lastClosedMonth = null;
  }
  return { accounts: out, lastClosedMonth };
}

export interface ThroughChoice {
  throughMonth: string;
  source: ThroughMonthSource;
  reason: string;
  /** The status the choice was based on (absent for a requested month). */
  status?: ReconciliationStatus;
}

/**
 * Range end (R1 F5): a requested month wins (validated against the window);
 * otherwise the entity's LAST CLOSED month, else the last COMPLETE calendar
 * month — both capped to the window — and never the current partial month.
 */
export async function chooseThroughMonth(
  tenantId: string, companyId: string, window: TaxYearWindow, requested: string | undefined, today = new Date(),
): Promise<ThroughChoice> {
  if (requested) {
    return { throughMonth: resolveThroughMonth(window, requested, today), source: 'requested', reason: 'Range end requested explicitly.' };
  }
  const cap = resolveThroughMonth(window, undefined, today); // last complete month, capped; 422 when none
  const status = await reconciliationStatus(tenantId, companyId, window, cap);
  if (status.lastClosedMonth) {
    const m = status.lastClosedMonth > cap ? cap : status.lastClosedMonth;
    return {
      throughMonth: m, source: 'last_closed_month', status,
      reason: `Last closed month: every bank and credit-card account with activity is reconciled through ${status.lastClosedMonth}.`,
    };
  }
  const why = status.accounts.some((a) => a.hasActivityInRange)
    ? 'no month is closed yet (a bank or credit-card account with activity is not reconciled)'
    : 'no bank or credit-card account has activity, so no month can be closed';
  return {
    throughMonth: cap, source: 'last_complete_month', status,
    reason: `Last complete calendar month (${cap}): ${why}.`,
  };
}
