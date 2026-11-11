// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

import { eq, and, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { budgets, budgetLines, accounts } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import { auditLog } from '../middleware/audit.js';
import * as reportService from './report.service.js';
import { env } from '../config/env.js';
import * as exact from './budget-exact.service.js';
import { claimAndRecord } from './idempotency.service.js';

// U-203 (budgets-exact-v1): the read/write paths take an optional company
// (the budgets router passes the request's; MyBooks Online callers without
// one keep the tenant-wide view) and every write runs in one transaction
// with the version check, Idempotency-Key claim and audit row. The exact
// line math lives in budget-exact.service.ts.

export async function list(tenantId: string, opts?: { limit?: number; offset?: number; companyId?: string | null }) {
  const where = exact.budgetScope(tenantId, opts?.companyId ?? null);
  const limit = Math.min(Math.max(opts?.limit ?? 100, 1), 500);
  const offset = Math.max(opts?.offset ?? 0, 0);

  const data = await db.select().from(budgets).where(where)
    .orderBy(sql`${budgets.fiscalYear} DESC`)
    .limit(limit).offset(offset);

  const totalRows = await db.select({ total: sql<number>`COUNT(*)::int` }).from(budgets).where(where);
  return { data, total: totalRows[0]?.total ?? 0, limit, offset };
}

export async function getById(tenantId: string, id: string, companyId: string | null = null) {
  return exact.budgetForAccess(tenantId, companyId, id);
}

export interface CreateBudgetInput {
  name: string;
  fiscalYear: number;
  // ADR 0XW additions — all optional; legacy callers still work.
  tagId?: string | null;
  description?: string | null;
  periodType?: 'monthly' | 'quarterly' | 'annual';
  status?: 'draft' | 'active' | 'archived';
  fiscalYearStart?: string | null;
}

export async function create(tenantId: string, input: CreateBudgetInput, userId?: string, companyId: string | null = null) {
  // The fiscal year is still unique per tenant (idx_budgets_tenant_year).
  const existing = await db.query.budgets.findFirst({
    where: and(eq(budgets.tenantId, tenantId), eq(budgets.fiscalYear, input.fiscalYear)),
  });
  if (existing) throw AppError.conflict('A budget for this fiscal year already exists');

  // Derive fiscal_year_start from the COMPANY's fiscal year when the
  // caller didn't supply one. The old default (Jan 1 of the integer
  // year) made every budget a calendar-year budget even for July-FY
  // companies, so Budget vs. Actuals compared against a different
  // 12-month window than the P&L. Budget "FY N" starts in calendar
  // year N at the company's fiscal start month — the same convention
  // fillFromActuals already used for its prior-year window.
  let fiscalYearStart = input.fiscalYearStart ?? null;
  if (!fiscalYearStart) {
    const fyRow = await db.execute(sql`
      SELECT fiscal_year_start_month FROM companies
      WHERE tenant_id = ${tenantId} ${companyId ? sql`AND id = ${companyId}` : sql``} ORDER BY created_at LIMIT 1
    `);
    const fyMonth = Number((fyRow.rows as Array<{ fiscal_year_start_month: number | null }>)[0]?.fiscal_year_start_month || 1);
    fiscalYearStart = `${input.fiscalYear}-${String(fyMonth).padStart(2, '0')}-01`;
  }

  return db.transaction(async (tx) => {
    const [budget] = await tx.insert(budgets).values({
      tenantId,
      companyId,
      name: input.name,
      fiscalYear: input.fiscalYear,
      tagId: input.tagId ?? null,
      description: input.description ?? null,
      periodType: input.periodType ?? 'monthly',
      status: input.status ?? 'active',
      fiscalYearStart,
      createdBy: userId ?? null,
    }).returning();
    await claimAndRecord(tx, 'budget', budget!.id);
    await auditLog(tenantId, 'create', 'budget', budget!.id, null, budget, userId, tx);
    return budget;
  });
}

export interface UpdateBudgetInput {
  name?: string;
  isActive?: boolean;
  tagId?: string | null;
  description?: string | null;
  status?: 'draft' | 'active' | 'archived';
  /** The version read (U-203): 409 STALE_VERSION when the budget changed since; absent = last write wins. */
  version?: number;
}

export async function update(tenantId: string, id: string, input: UpdateBudgetInput, userId?: string, companyId: string | null = null) {
  const { version, ...fields } = input;
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(budgets)
      .where(and(exact.budgetScope(tenantId, companyId), eq(budgets.id, id))).for('update').limit(1);
    if (!before) throw AppError.notFound('Budget not found');
    if (version !== undefined && before.version !== version) throw exact.stale(before.version);
    const [updated] = await tx.update(budgets).set({ ...fields, version: before.version + 1, updatedAt: new Date() })
      .where(and(eq(budgets.tenantId, tenantId), eq(budgets.id, id))).returning();
    await claimAndRecord(tx, 'budget', id);
    await auditLog(tenantId, 'update', 'budget', updated!.id, before, updated, userId, tx);
    return updated!;
  });
}

export async function remove(tenantId: string, id: string, userId?: string, companyId: string | null = null) {
  // `budget_lines` has no tenant_id column — it's scoped transitively
  // via `budget_id → budgets.tenant_id`. We verify ownership before
  // deleting the lines so a malformed id can't wipe another tenant's
  // budget lines, and we wrap both deletes in a transaction so a
  // partial failure doesn't leave dangling lines.
  let removedBudget: typeof budgets.$inferSelect | undefined;
  await db.transaction(async (tx) => {
    const [budget] = await tx.select().from(budgets)
      .where(and(exact.budgetScope(tenantId, companyId), eq(budgets.id, id))).limit(1);
    if (!budget) throw AppError.notFound('Budget not found');
    removedBudget = budget;

    await tx.delete(budgetLines).where(eq(budgetLines.budgetId, id));
    await tx.delete(budgets).where(and(eq(budgets.tenantId, tenantId), eq(budgets.id, id)));
  });
  if (removedBudget) {
    await auditLog(tenantId, 'delete', 'budget', id, removedBudget, null, userId);
  }
}

export async function getLines(tenantId: string, budgetId: string, companyId: string | null = null) {
  await getById(tenantId, budgetId, companyId);
  const lines = await db.execute(sql`
    SELECT bl.*, a.name as account_name, a.account_number, a.account_type
    FROM budget_lines bl
    JOIN accounts a ON a.id = bl.account_id
    WHERE bl.budget_id = ${budgetId}
    ORDER BY a.account_type, a.account_number, a.name
  `);
  return lines.rows;
}

/**
 * Saves lines (each replaces its account's twelve periods). Validated
 * (U-203): P&L accounts of the company only, cells with at most 2 decimal
 * places, periods month1..month12; else 400 BUDGET_LINE_INVALID.
 */
export async function updateLines(tenantId: string, budgetId: string, lines: unknown,
  opts: { companyId?: string | null; version?: number; userId?: string } = {}) {
  await exact.putLines(tenantId, opts.companyId ?? null, budgetId, { version: opts.version, lines: exact.parseLines(lines) }, opts.userId);
}

export async function fillFromActuals(tenantId: string, budgetId: string,
  opts: { companyId?: string | null; version?: number; basis?: 'accrual' | 'cash'; userId?: string } = {}) {
  await exact.fillFromActuals(tenantId, opts.companyId ?? null, budgetId, { version: opts.version, basis: opts.basis }, opts.userId);
}

export async function copyFromBudget(tenantId: string, targetBudgetId: string, sourceBudgetId: string,
  opts: { companyId?: string | null; version?: number; userId?: string } = {}) {
  await exact.copyFromBudget(tenantId, opts.companyId ?? null, targetBudgetId, sourceBudgetId, { version: opts.version }, opts.userId);
}

export async function adjustByPercent(tenantId: string, budgetId: string, percent: unknown,
  opts: { companyId?: string | null; version?: number; userId?: string } = {}) {
  await exact.adjustByPercent(tenantId, opts.companyId ?? null, budgetId, { version: opts.version, percent: exact.parsePercent(percent) }, opts.userId);
}

export async function buildBudgetVsActual(tenantId: string, budgetId: string, startDate: string, endDate: string, companyId: string | null = null) {
  const budget = await getById(tenantId, budgetId);
  const lines = await getLines(tenantId, budgetId);
  const pl = await reportService.buildProfitAndLoss(tenantId, startDate, endDate, 'accrual', companyId);

  const plItemsByType: Record<string, any[]> = {
    revenue: pl.revenue,
    cogs: pl.cogs,
    expense: pl.expenses,
    other_revenue: pl.otherRevenue,
    other_expense: pl.otherExpenses,
  };

  // Prorate the budget to the requested range: only budget months whose
  // calendar window overlaps [startDate, endDate] count. The old version
  // summed all 12 months regardless, so the dashboard compared one
  // month of actuals against the FULL-YEAR budget (every account showed
  // a huge "unfavorable" variance by construction). Budget month m maps
  // to the m-th calendar month after the budget's fiscal_year_start.
  const fyStartStr = String((budget as { fiscalYearStart?: string | null }).fiscalYearStart ?? `${budget.fiscalYear}-01-01`).slice(0, 10);
  const fyY = parseInt(fyStartStr.slice(0, 4), 10);
  const fyM = parseInt(fyStartStr.slice(5, 7), 10) || 1;
  const includedMonths: number[] = [];
  for (let m = 0; m < 12; m++) {
    const y = fyY + Math.floor((fyM - 1 + m) / 12);
    const mo = ((fyM - 1 + m) % 12) + 1;
    const mStart = `${y}-${String(mo).padStart(2, '0')}-01`;
    const mEnd = new Date(Date.UTC(y, mo, 0)).toISOString().split('T')[0]!;
    if (mStart <= endDate && mEnd >= startDate) includedMonths.push(m + 1);
  }

  function buildRow(line: any) {
    const monthTotal = includedMonths.reduce((s, m) => s + parseFloat(line[`month_${m}`] || '0'), 0);
    const plItems = plItemsByType[line.account_type] ?? [];
    const actual = plItems.find((i: any) => i.name === line.account_name)?.amount || 0;
    const varianceDollar = actual - monthTotal;
    const variancePercent = monthTotal === 0 ? null : (varianceDollar / Math.abs(monthTotal)) * 100;
    return {
      accountId: line.account_id,
      accountName: line.account_name,
      accountNumber: line.account_number,
      accountType: line.account_type,
      budget: monthTotal,
      actual,
      varianceDollar,
      variancePercent,
    };
  }

  const allRows = (lines as any[]).map(buildRow).filter((r) => r.budget !== 0 || r.actual !== 0);
  const revenue = allRows.filter((r) => r.accountType === 'revenue');
  const cogs = allRows.filter((r) => r.accountType === 'cogs');
  const expenses = allRows.filter((r) => r.accountType === 'expense');
  const otherRevenue = allRows.filter((r) => r.accountType === 'other_revenue');
  const otherExpenses = allRows.filter((r) => r.accountType === 'other_expense');

  const sumBudget = (rs: any[]) => rs.reduce((s, r) => s + r.budget, 0);
  const sumActual = (rs: any[]) => rs.reduce((s, r) => s + r.actual, 0);
  const totalRevenueBudget = sumBudget(revenue);
  const totalRevenueActual = sumActual(revenue);
  const totalCogsBudget = sumBudget(cogs);
  const totalCogsActual = sumActual(cogs);
  const totalExpenseBudget = sumBudget(expenses);
  const totalExpenseActual = sumActual(expenses);
  const totalOtherRevenueBudget = sumBudget(otherRevenue);
  const totalOtherRevenueActual = sumActual(otherRevenue);
  const totalOtherExpenseBudget = sumBudget(otherExpenses);
  const totalOtherExpenseActual = sumActual(otherExpenses);

  const netIncomeBudget =
    totalRevenueBudget + totalOtherRevenueBudget - totalCogsBudget - totalExpenseBudget - totalOtherExpenseBudget;
  const netIncomeActual =
    totalRevenueActual + totalOtherRevenueActual - totalCogsActual - totalExpenseActual - totalOtherExpenseActual;

  return {
    title: 'Budget vs Actual',
    labels: pl.labels,
    budgetName: budget.name,
    fiscalYear: budget.fiscalYear,
    startDate, endDate,
    revenue,
    cogs,
    expenses,
    otherRevenue,
    otherExpenses,
    totalRevenueBudget,
    totalRevenueActual,
    totalCogsBudget,
    totalCogsActual,
    totalExpenseBudget,
    totalExpenseActual,
    totalOtherRevenueBudget,
    totalOtherRevenueActual,
    totalOtherExpenseBudget,
    totalOtherExpenseActual,
    netIncomeBudget,
    netIncomeActual,
  };
}

/**
 * ADR 0XW §6 — Budget vs. Actuals scoped to the budget's tag (or
 * company-wide when tag_id is null). Actuals are aggregated directly
 * from journal_lines against posted transactions, so the query respects
 * split-level tag scoping introduced in ADR 0XX.
 *
 * Output is a per-account / per-month matrix plus row and column
 * totals. Variance sign flips for expense-type accounts so "positive =
 * good" reads consistently in the UI.
 *
 * Requires `env.TAG_BUDGETS_V1`. When the flag is off, callers should
 * use `buildBudgetVsActual` (the legacy company-wide P&L-backed path)
 * to preserve pre-ADR behavior verbatim.
 */
export async function runTagScopedBudgetVsActuals(
  tenantId: string,
  budgetId: string,
  companyId: string | null = null,
) {
  if (!env.TAG_BUDGETS_V1) {
    throw AppError.badRequest('TAG_BUDGETS_V1 feature flag is not enabled');
  }

  const budget = await getById(tenantId, budgetId);

  // fiscal_year_start is always populated by migration 0061's backfill,
  // but defensively fall back to Jan 1 of the legacy fiscal_year if
  // something cleared the column post-backfill.
  const fiscalStart = (budget as { fiscalYearStart?: string | null }).fiscalYearStart
    ?? `${budget.fiscalYear}-01-01`;
  const tagId = (budget as { tagId?: string | null }).tagId ?? null;

  const lines = await getLines(tenantId, budgetId);

  // Pull every posted line in the fiscal year for the relevant accounts,
  // tag-filtered when the budget has a tag scope.
  const accountIds = (lines as Array<{ account_id: string }>).map((l) => l.account_id);
  if (accountIds.length === 0) {
    return { budget, fiscalYearStart: fiscalStart, tagId, rows: [], totals: { perMonth: [], grand: 0 } };
  }

  // Build the 12 month buckets (month_1..month_12) of posted activity
  // per account. Uses date_trunc + offset math so a non-calendar fiscal
  // year works: bucket = month diff between txn_date and fiscal_start.
  const actualsRows = await db.execute(sql`
    WITH params AS (
      SELECT ${fiscalStart}::date AS fy_start,
             (${fiscalStart}::date + INTERVAL '1 year')::date AS fy_end
    )
    SELECT
      jl.account_id,
      -- period_index 1..12 = month offset from fiscal_year_start + 1
      (EXTRACT(YEAR FROM age(t.txn_date, p.fy_start)) * 12
       + EXTRACT(MONTH FROM age(t.txn_date, p.fy_start))
       + 1)::smallint AS period_index,
      SUM(jl.debit - jl.credit) AS signed_total
    FROM journal_lines jl
    JOIN transactions t ON t.id = jl.transaction_id
    CROSS JOIN params p
    WHERE jl.tenant_id = ${tenantId}
      AND t.status = 'posted'
      AND t.basis <> 'cash'
      AND t.txn_date >= p.fy_start
      AND t.txn_date <  p.fy_end
      AND jl.account_id = ANY(${sql.raw(`ARRAY[${accountIds.map((id) => `'${id}'`).join(',')}]::uuid[]`)})
      ${tagId ? sql`AND jl.tag_id = ${tagId}` : sql``}
      ${companyId ? sql`AND jl.company_id = ${companyId}` : sql``}
    GROUP BY jl.account_id, period_index
  `);

  const actualsByAccount = new Map<string, Map<number, number>>();
  for (const row of actualsRows.rows as Array<{ account_id: string; period_index: number; signed_total: string }>) {
    const perMonth = actualsByAccount.get(row.account_id) ?? new Map<number, number>();
    perMonth.set(Number(row.period_index), parseFloat(row.signed_total));
    actualsByAccount.set(row.account_id, perMonth);
  }

  type Cell = { periodIndex: number; budget: number; actual: number; variance: number; variancePct: number | null };
  type Row = {
    accountId: string;
    accountName: string;
    accountNumber: string;
    accountType: string;
    cells: Cell[];
    rowTotal: Cell;
  };

  // For expense-type accounts we flip the variance sign so that
  // "actual under budget" reads positive; revenue accounts already do.
  function signFor(accountType: string): 1 | -1 {
    return ['expense', 'cogs', 'other_expense'].includes(accountType) ? -1 : 1;
  }

  const rows: Row[] = (lines as Array<Record<string, unknown>>).map((line) => {
    const accountId = line['account_id'] as string;
    const accountType = line['account_type'] as string;
    const signFlip = signFor(accountType);
    const perMonth = actualsByAccount.get(accountId) ?? new Map<number, number>();
    const cells: Cell[] = [];
    let rowBudget = 0;
    let rowActual = 0;
    for (let m = 1; m <= 12; m += 1) {
      const budgetAmt = parseFloat(String(line[`month_${m}`] ?? '0'));
      const actualAmt = Math.abs(perMonth.get(m) ?? 0);
      const varianceRaw = (actualAmt - budgetAmt) * signFlip;
      cells.push({
        periodIndex: m,
        budget: budgetAmt,
        actual: actualAmt,
        variance: varianceRaw,
        variancePct: budgetAmt === 0 ? null : (varianceRaw / Math.abs(budgetAmt)) * 100,
      });
      rowBudget += budgetAmt;
      rowActual += actualAmt;
    }
    const rowVariance = (rowActual - rowBudget) * signFlip;
    return {
      accountId,
      accountName: line['account_name'] as string,
      accountNumber: line['account_number'] as string,
      accountType,
      cells,
      rowTotal: {
        periodIndex: 0,
        budget: rowBudget,
        actual: rowActual,
        variance: rowVariance,
        variancePct: rowBudget === 0 ? null : (rowVariance / Math.abs(rowBudget)) * 100,
      },
    };
  });

  // Column totals — sum across every row for each month.
  const perMonth: Cell[] = Array.from({ length: 12 }, (_, i) => {
    const m = i + 1;
    const budgetSum = rows.reduce((s, r) => s + (r.cells[i]?.budget ?? 0), 0);
    const actualSum = rows.reduce((s, r) => s + (r.cells[i]?.actual ?? 0), 0);
    const variance = actualSum - budgetSum;
    return {
      periodIndex: m,
      budget: budgetSum,
      actual: actualSum,
      variance,
      variancePct: budgetSum === 0 ? null : (variance / Math.abs(budgetSum)) * 100,
    };
  });
  const grand = rows.reduce((s, r) => s + r.rowTotal.actual - r.rowTotal.budget, 0);

  return {
    budget,
    fiscalYearStart: fiscalStart,
    tagId,
    rows,
    totals: { perMonth, grand },
  };
}

export async function buildBudgetOverview(tenantId: string, budgetId: string) {
  const budget = await getById(tenantId, budgetId);
  const lines = await getLines(tenantId, budgetId);

  const rows = (lines as any[]).map((line) => {
    const months = [1,2,3,4,5,6,7,8,9,10,11,12].map((m) => parseFloat(line[`month_${m}`] || '0'));
    const annualTotal = months.reduce((s, v) => s + v, 0);
    return {
      accountId: line.account_id,
      accountName: line.account_name,
      accountNumber: line.account_number,
      accountType: line.account_type,
      months,
      annualTotal,
    };
  }).filter((r) => r.annualTotal !== 0);

  const revenue = rows.filter((r) => r.accountType === 'revenue');
  const cogs = rows.filter((r) => r.accountType === 'cogs');
  const expenses = rows.filter((r) => r.accountType === 'expense');
  const otherRevenue = rows.filter((r) => r.accountType === 'other_revenue');
  const otherExpenses = rows.filter((r) => r.accountType === 'other_expense');

  return {
    title: 'Budget Overview',
    budgetName: budget.name,
    fiscalYear: budget.fiscalYear,
    revenue,
    cogs,
    expenses,
    otherRevenue,
    otherExpenses,
  };
}
