// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Books readiness (MODULE.md "Books readiness"). Warnings only — never blocks.
//
// LAST CLOSED MONTH RULE:
//   * Reconcilable accounts = the company's (or tenant-level) asset accounts
//     with a bank detail type (report.service BANK_ACCOUNT_DETAIL_TYPES) and
//     liability accounts with a credit-card / line-of-credit detail type
//     (RECONCILABLE_LIABILITY_DETAIL_TYPES) — the Bank Reconciliation Summary set.
//   * An account counts only if it has GL activity (either side) in
//     [tax-year start, through] on the company — dormant accounts never block.
//   * An account is closed through the month of its latest COMPLETED
//     reconciliation's statement_date when that date is the month's last day,
//     otherwise through the PREVIOUS month (a statement ending Sep 27 does
//     not cover Sep 28-30). In-progress reconciliations do not count.
//   * Last closed month = the earliest closed-through month across the
//     counted accounts (null when any counted account was never reconciled),
//     capped at the tax year's last month.

import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import type { BooksReadiness, ReadinessAccount, TaxEstimatorWarning } from '@kis-books/shared';
import DecimalLib from 'decimal.js';
import { db } from '../../db/index.js';
import { accounts, reconciliations } from '../../db/schema/index.js';
import {
  BANK_ACCOUNT_DETAIL_TYPES, RECONCILABLE_LIABILITY_DETAIL_TYPES, buildAccountDetailReport,
} from '../report.service.js';
import { getSuspenseSummary } from '../suspense.service.js';
import { previewSuspenseConsolidation } from '../system-accounts.service.js';
import { taxYearOf } from '../tb/tax-profile.service.js';
import type { FirmScope } from './firm-scope.service.js';
import { assertEntityInScope, resolveForCompany } from './entity-type.service.js';
import { getTaxBasisPl, monthEnd, resolveThroughMonth, taxYearWindow } from './pl-provider.service.js';

const Decimal = DecimalLib.default || DecimalLib;

export interface ReadinessRequest {
  tenantId: string;
  companyId: string;
  /** Defaults to the tax year containing `throughMonth`, else the current year. */
  taxYear?: number;
  throughMonth?: string;
}

/** Month covered by a completed reconciliation's statement date. Exported for tests. */
export function closedThroughMonthOf(statementDate: string): string {
  const ym = statementDate.slice(0, 7);
  if (statementDate.slice(0, 10) === monthEnd(ym)) return ym;
  const [y, m] = ym.split('-').map(Number) as [number, number];
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

const asDateString = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
};

export async function getReadiness(scope: FirmScope, req: ReadinessRequest): Promise<BooksReadiness> {
  // D1: scope guard BEFORE any books query.
  const company = await assertEntityInScope(scope, req.tenantId, req.companyId);
  const resolved = await resolveForCompany(company);
  const { tenantId, companyId } = req;
  const fy = resolved.entityType === 'c_corp' ? resolved.fiscalYearStartMonth : 1;
  const taxYear = req.taxYear
    ?? (req.throughMonth ? taxYearOf(`${req.throughMonth}-01`, fy) : new Date().getUTCFullYear());
  const window = taxYearWindow(taxYear, resolved.entityType, resolved.fiscalYearStartMonth);
  const throughMonth = resolveThroughMonth(window, req.throughMonth);
  const throughDate = monthEnd(throughMonth);
  const warnings: TaxEstimatorWarning[] = [...resolved.warnings];

  // ── Reconciliation status ──
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

  const ids = recAccounts.map((a) => a.id);
  const active = new Set<string>();
  const recRows = ids.length === 0 ? [] : await db.select({
    accountId: reconciliations.accountId, status: reconciliations.status, statementDate: reconciliations.statementDate,
  }).from(reconciliations)
    .where(and(eq(reconciliations.tenantId, tenantId), inArray(reconciliations.accountId, ids)));
  if (ids.length > 0) {
    // Activity on either side in range (existing report builder; summary mode).
    for (const side of ['debit', 'credit'] as const) {
      const r = await buildAccountDetailReport(tenantId, window.start, throughDate, {
        title: 'tax-estimator-readiness', accountTypes: ['asset', 'liability'], normalSide: side,
        companyId, accountIds: ids,
      });
      for (const row of r.data as unknown as Array<{ account_id: string }>) active.add(row.account_id);
    }
  }

  const reconcilableAccounts: ReadinessAccount[] = recAccounts.map((a) => {
    const mine = recRows.filter((r) => r.accountId === a.id);
    const completed = mine
      .filter((r) => r.status === 'complete')
      .map((r) => asDateString(r.statementDate))
      .filter((d): d is string => !!d)
      .sort();
    const latest = completed.length > 0 ? completed[completed.length - 1]! : null;
    return {
      accountId: a.id,
      accountNumber: a.accountNumber,
      name: a.name,
      kind: a.accountType === 'asset' ? 'bank' : 'credit_card',
      reconciledThrough: latest,
      closedThroughMonth: latest ? closedThroughMonthOf(latest) : null,
      hasInProgressReconciliation: mine.some((r) => r.status !== 'complete'),
      hasActivityInRange: active.has(a.id),
    };
  });

  const counted = reconcilableAccounts.filter((a) => a.hasActivityInRange);
  let lastClosedMonth: string | null = null;
  if (counted.length > 0 && counted.every((a) => a.closedThroughMonth !== null)) {
    lastClosedMonth = counted.map((a) => a.closedThroughMonth!).sort()[0]!;
    if (lastClosedMonth > window.endMonth) lastClosedMonth = window.endMonth;
  }
  const unreconciledAccounts = counted.filter((a) => !a.closedThroughMonth || a.closedThroughMonth < throughMonth);
  const throughIsOpen = lastClosedMonth === null || throughMonth > lastClosedMonth;

  if (counted.length === 0) {
    warnings.push({
      code: 'TE_NO_RECONCILABLE_ACTIVITY', severity: 'info',
      message: 'No bank or credit-card account has activity in the range, so no closed month can be derived.',
    });
  }
  if (unreconciledAccounts.length > 0) {
    warnings.push({
      code: 'TE_UNRECONCILED_ACCOUNTS', severity: 'warning',
      message: `${unreconciledAccounts.length} bank/credit-card account(s) are not reconciled through ${throughMonth}.`,
      details: { accounts: unreconciledAccounts.map((a) => ({ accountId: a.accountId, name: a.name, closedThroughMonth: a.closedThroughMonth })) },
    });
  }
  if (throughIsOpen && counted.length > 0) {
    warnings.push({
      code: 'TE_RANGE_INCLUDES_OPEN_MONTH', severity: 'warning',
      message: lastClosedMonth
        ? `The range runs through ${throughMonth}, after the last closed month (${lastClosedMonth}).`
        : `The range runs through ${throughMonth}, but no month is closed yet.`,
    });
  }

  // ── Suspense / uncategorized / ask-my-accountant (existing helpers) ──
  const [summary, lookalikes] = await Promise.all([
    getSuspenseSummary(tenantId, companyId),
    previewSuspenseConsolidation(tenantId),
  ]);
  const lookalikeAccounts = lookalikes.candidates
    .filter((c) => !new Decimal(c.balance || 0).isZero())
    .map((c) => ({ accountId: c.id, name: c.name, balance: new Decimal(c.balance || 0).toFixed(4) }));
  const suspenseBalance = new Decimal(summary.balance || 0);
  if (!suspenseBalance.isZero() || lookalikeAccounts.length > 0) {
    warnings.push({
      code: 'TE_SUSPENSE_BALANCE', severity: 'warning',
      message: 'Suspense / uncategorized / ask-my-accountant accounts carry a balance; those amounts are not classified for tax.',
      details: { suspenseBalance: suspenseBalance.toFixed(4), lookalikeAccounts },
    });
  }
  if (summary.unpostedCount > 0) {
    warnings.push({
      code: 'TE_UNPOSTED_BANK_FEED', severity: 'warning',
      message: `${summary.unpostedCount} bank-feed transaction(s) are not posted yet.`,
    });
  }

  // ── Mapping gaps (from the provider so readiness and the estimate agree) ──
  const pl = await getTaxBasisPl(scope, { tenantId, companyId, taxYear, throughMonth });
  const unmappedAccounts = pl.accounts
    .filter((a) => a.characterSource === 'unassigned' && !a.treatment)
    .map((a) => ({ accountId: a.accountId, accountNumber: a.accountNumber, name: a.name, bookAmount: a.bookAmount }));
  const unmappedWarning = pl.warnings.find((w) => w.code === 'TE_UNMAPPED_ACCOUNTS');
  if (unmappedWarning) warnings.push(unmappedWarning);

  return {
    tenantId,
    companyId,
    taxYear,
    periodStart: window.start,
    throughMonth,
    lastClosedMonth,
    throughIsOpen,
    closingDate: resolved.closingDate,
    reconcilableAccounts,
    unreconciledAccounts,
    suspense: {
      suspenseAccountId: summary.suspenseAccountId,
      balance: suspenseBalance.toFixed(4),
      transactionCount: summary.transactionCount,
      unpostedFeedCount: summary.unpostedCount,
      lookalikeAccounts,
    },
    unmappedAccounts,
    entity: resolved,
    warnings,
  };
}
