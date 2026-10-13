// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Books readiness (MODULE.md "Books readiness"). Warnings only — never blocks.
//
// The LAST CLOSED MONTH rule lives in closed-month.service.ts (shared with the
// P&L provider's default range end, R1 F5): bank + credit-card accounts with
// activity, latest COMPLETED reconciliation's statement month (previous month
// when the statement does not end on a month end), never-reconciled accounts
// opened during the year closed through the month before their first activity
// (R1 F11), earliest across accounts.
//
// RANGE END: a requested `through` wins; otherwise the last closed month,
// else the last complete calendar month — never the current partial month.

import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import type { BooksReadiness, TaxEstimatorWarning } from '@kis-books/shared';
import DecimalLib from 'decimal.js';
import { db } from '../../db/index.js';
import { accounts } from '../../db/schema/index.js';
import { getSuspenseSummary } from '../suspense.service.js';
import { previewSuspenseConsolidation } from '../system-accounts.service.js';
import { taxYearOf } from '../tb/tax-profile.service.js';
import type { FirmScope } from './firm-scope.service.js';
import { assertEntityInScope, resolveForCompany } from './entity-type.service.js';
import { getTaxBasisPl } from './pl-provider.service.js';
import { chooseThroughMonth, closedThroughMonthOf, reconciliationStatus } from './closed-month.service.js';
import { lastCompleteMonth, taxYearWindow } from './periods.js';

export { closedThroughMonthOf };

const Decimal = DecimalLib.default || DecimalLib;

/** Provider warnings about the tax-treatment map that readiness repeats. */
const MAPPING_WARNING_CODES = new Set([
  'TE_UNMAPPED_ACCOUNTS', 'TE_GP_CODE_WITHOUT_TREATMENT', 'TE_M1_CODE_ON_PL_ACCOUNT', 'TE_OWNER_PERSON_MISSING',
  'TE_TREATMENT_NOT_FOR_ENTITY', 'TE_FARM_INCOME_ASSUMED', 'TE_FARM_INCOME_UNASSIGNED',
  // Q50: owner splits / unlinked treatment targets.
  'TE_TARGET_NOT_LINKED', 'TE_SPLIT_REMAINDER', 'TE_SPLIT_AMOUNT_YEAR_MISSING',
]);

export interface ReadinessRequest {
  tenantId: string;
  companyId: string;
  /** Defaults to the tax year containing `throughMonth`, else the one containing the last complete month. */
  taxYear?: number;
  throughMonth?: string;
}

export async function getReadiness(
  scope: FirmScope, req: ReadinessRequest, opts: { today?: Date } = {},
): Promise<BooksReadiness> {
  // D1: scope guard BEFORE any books query.
  const company = await assertEntityInScope(scope, req.tenantId, req.companyId);
  const resolved = await resolveForCompany(company);
  const { tenantId, companyId } = req;
  const today = opts.today ?? new Date();
  const fy = resolved.entityType === 'c_corp' ? resolved.fiscalYearStartMonth : 1;
  const taxYear = req.taxYear
    ?? taxYearOf(`${req.throughMonth ?? lastCompleteMonth(today)}-01`, fy);
  const window = taxYearWindow(taxYear, resolved.entityType, resolved.fiscalYearStartMonth);
  const choice = await chooseThroughMonth(tenantId, companyId, window, req.throughMonth, today);
  const throughMonth = choice.throughMonth;
  const warnings: TaxEstimatorWarning[] = [...resolved.warnings];

  // ── Reconciliation status (closed-month rule) ──
  const status = choice.status ?? await reconciliationStatus(tenantId, companyId, window, throughMonth);
  const reconcilableAccounts = status.accounts;
  const { lastClosedMonth } = status;
  const counted = reconcilableAccounts.filter((a) => a.hasActivityInRange);
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
  // R1 F12: the look-alike scan is tenant-wide; keep this company's accounts
  // and tenant-level (company_id NULL) ones only.
  const candidateIds = lookalikes.candidates.map((c) => c.id);
  const companyCandidates = new Set(candidateIds.length === 0 ? [] : (await db.select({ id: accounts.id }).from(accounts)
    .where(and(
      eq(accounts.tenantId, tenantId),
      inArray(accounts.id, candidateIds),
      or(eq(accounts.companyId, companyId), isNull(accounts.companyId)),
    ))).map((r) => r.id));
  const lookalikeAccounts = lookalikes.candidates
    .filter((c) => companyCandidates.has(c.id))
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
  const pl = await getTaxBasisPl(scope, { tenantId, companyId, taxYear, throughMonth }, { today });
  const unmappedAccounts = pl.accounts
    .filter((a) => a.characterSource === 'unassigned' && !a.treatment)
    .map((a) => ({ accountId: a.accountId, accountNumber: a.accountNumber, name: a.name, bookAmount: a.bookAmount }));
  for (const w of pl.warnings) if (MAPPING_WARNING_CODES.has(w.code)) warnings.push(w);

  return {
    tenantId,
    companyId,
    taxYear,
    periodStart: window.start,
    throughMonth,
    throughMonthSource: choice.source,
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
