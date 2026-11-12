// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

/**
 * Equity earnings (U-119, ClientLedger A07 PR-B): the income no ledger line
 * holds on a Balance Sheet or Trial Balance — prior years' net income
 * (retained earnings) and this fiscal year's net income — computed once,
 * the way every caller needs it:
 *
 *   - line mode (Balance Sheet, its column layout, the Report Builder's
 *     balance_sheet earnings): one lineSums pass over the income-statement
 *     accounts per as-of date, split at that date's fiscal year start
 *     (splitDate). Net income = credit - debit over every income-statement
 *     line, with the report's basis, company, adjusting and line lens (a
 *     line-level tag). buildBalanceSheet used two full Profit and Loss runs
 *     for the same two figures; the result is the same lines and sums.
 *   - transaction mode (the Trial Balance with a tag filter, U-213 S2):
 *     prior years' income of every line of each transaction that has a line
 *     with one of the tags, so the tagged Trial Balance balances. A
 *     line-level Profit and Loss can't reproduce it (the one drill exemption
 *     of the Report Builder).
 *
 * `exec` runs the queries in a caller's transaction (the Report Builder's
 * READ ONLY snapshot); default: the pool. All arithmetic is Decimal.
 */

import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { dec, type Dec } from './report-exact.js';
import { lineSums, type LineLens, type LineSum, type SumDimension, type SqlExecutor } from './report-lens.js';
import { adjustingCond, cashBasisLinesWith, executeCashBasisIn, tagIn, type AdjustingFilter } from './report.service.js';

export const PL_ACCOUNT_TYPES = ['revenue', 'cogs', 'expense', 'other_revenue', 'other_expense'] as const;

const isPl = (t: string) => (PL_ACCOUNT_TYPES as readonly string[]).includes(t);

export interface EarningsSplit {
  /** Prior years' net income, per dimension key (null without a dimension). */
  priorYears: Map<string | null, Dec>;
  /** This fiscal year's net income through the as-of date, per key. */
  currentYear: Map<string | null, Dec>;
}

/**
 * Splits lineSums rows of income-statement accounts into prior years and the
 * current year (rows of other accounts are ignored). Rows must come from a
 * lineSums call with splitDate (or windows with splitDate) at the fiscal
 * year start. Pass `window` to take one window's rows.
 */
export function earningsFromSums(rows: readonly LineSum[], window?: number): EarningsSplit {
  const priorYears = new Map<string | null, Dec>();
  const currentYear = new Map<string | null, Dec>();
  for (const r of rows) {
    if (!isPl(r.accountType)) continue;
    if (window !== undefined && r.window !== window) continue;
    const m = r.pre ? priorYears : currentYear;
    m.set(r.key, (m.get(r.key) ?? dec(0)).plus(r.credit.minus(r.debit)));
  }
  return { priorYears, currentYear };
}

/** The sum of a split's map over every key. */
export function earningsTotal(m: Map<string | null, Dec>): Dec {
  let acc = dec(0);
  for (const v of m.values()) acc = acc.plus(v);
  return acc;
}

export interface EarningsOptions {
  basis: 'accrual' | 'cash';
  companyId: string | null;
  adjusting: AdjustingFilter | null;
  /** One entry per as-of date with the start of the fiscal year containing it. */
  asOfs: ReadonlyArray<{ asOf: string; fiscalYearStart: string }>;
  /** Line-level filter (a line-level tag on the Balance Sheet). */
  lens?: LineLens | null;
  dimension?: SumDimension;
  exec?: SqlExecutor;
}

/** Line mode: prior years' and current-year net income at each as-of date, in one ledger pass. */
export async function equityEarnings(tenantId: string, o: EarningsOptions): Promise<EarningsSplit[]> {
  if (o.asOfs.length === 0) return [];
  const rows = await lineSums(tenantId, {
    basis: o.basis, companyId: o.companyId, adjusting: o.adjusting, from: null, to: o.asOfs[0]!.asOf,
    accountTypes: PL_ACCOUNT_TYPES, lens: o.lens ?? null, dimension: o.dimension,
    windows: o.asOfs.map((a) => ({ from: '0001-01-01', to: a.asOf, splitDate: a.fiscalYearStart })),
    exec: o.exec,
  });
  return o.asOfs.map((_, i) => earningsFromSums(rows, i));
}

/**
 * Transaction mode (the Trial Balance with a tag filter): prior years' net
 * income before `fiscalYearStart` over every line of the transactions that
 * have a line with one of the tags (`tagId` is the reports' comma-separated
 * list), on the report's basis, the ledger read through `endDate` (the
 * Trial Balance's date: a payment's virtual lines can carry later dates).
 * The same set buildTrialBalance sums its rows from.
 */
export async function priorYearsIncomeByTransactionTag(tenantId: string, o: {
  basis: 'accrual' | 'cash'; companyId: string | null; adjusting: AdjustingFilter | null;
  fiscalYearStart: string; tagId: string; endDate: string; exec?: SqlExecutor;
}): Promise<Dec> {
  const exec = o.exec ?? db;
  const types = sql.join(PL_ACCOUNT_TYPES.map((t) => sql`${t}`), sql`, `);
  const res = o.basis === 'cash'
    ? await executeCashBasisIn(exec, sql`
        WITH ${cashBasisLinesWith(tenantId, null, o.endDate, o.companyId, o.adjusting)}
        SELECT COALESCE(SUM(cb.credit - cb.debit), 0) AS n
        FROM cb_lines cb
        JOIN accounts a ON a.id = cb.account_id AND a.tenant_id = ${tenantId}
        WHERE a.account_type IN (${types}) AND cb.txn_date < ${o.fiscalYearStart}
          AND EXISTS (SELECT 1 FROM cb_lines cb2 WHERE cb2.transaction_id = cb.transaction_id AND cb2.tag_id IN ${tagIn(o.tagId)})`)
    : await exec.execute(sql`
        SELECT COALESCE(SUM(jl.credit - jl.debit), 0) AS n
        FROM journal_lines jl
        JOIN transactions t ON t.id = jl.transaction_id AND t.tenant_id = ${tenantId}
        JOIN accounts a ON a.id = jl.account_id AND a.tenant_id = ${tenantId}
        WHERE jl.tenant_id = ${tenantId} AND t.status = 'posted' AND t.basis <> 'cash'
          AND t.txn_date < ${o.fiscalYearStart}
          AND ${o.companyId ? sql`t.company_id = ${o.companyId}` : sql`TRUE`}
          AND ${adjustingCond(o.adjusting, 't.is_adjusting')}
          AND a.account_type IN (${types})
          AND EXISTS (SELECT 1 FROM journal_lines jl2 WHERE jl2.transaction_id = t.id AND jl2.tenant_id = ${tenantId} AND jl2.tag_id IN ${tagIn(o.tagId)})`);
  return dec(String((res.rows[0] as { n: string | number } | undefined)?.n ?? 0));
}
