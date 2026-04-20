// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { eq, and, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { budgets, budgetLines, accounts } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import * as reportService from './report.service.js';
import { env } from '../config/env.js';

export async function list(tenantId: string) {
  return db.select().from(budgets).where(eq(budgets.tenantId, tenantId)).orderBy(sql`${budgets.fiscalYear} DESC`);
}

export async function getById(tenantId: string, id: string) {
  const budget = await db.query.budgets.findFirst({ where: and(eq(budgets.tenantId, tenantId), eq(budgets.id, id)) });
  if (!budget) throw AppError.notFound('Budget not found');
  return budget;
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

export async function create(tenantId: string, input: CreateBudgetInput) {
  const existing = await db.query.budgets.findFirst({
    where: and(eq(budgets.tenantId, tenantId), eq(budgets.fiscalYear, input.fiscalYear)),
  });
  if (existing) throw AppError.conflict('A budget for this fiscal year already exists');

  // Derive fiscal_year_start if caller didn't supply one. Matches the
  // migration 0061 backfill: Jan 1 of the integer fiscal year.
  const fiscalYearStart =
    input.fiscalYearStart ?? `${input.fiscalYear}-01-01`;

  const [budget] = await db.insert(budgets).values({
    tenantId,
    name: input.name,
    fiscalYear: input.fiscalYear,
    tagId: input.tagId ?? null,
    description: input.description ?? null,
    periodType: input.periodType ?? 'monthly',
    status: input.status ?? 'active',
    fiscalYearStart,
  }).returning();
  return budget;
}

export interface UpdateBudgetInput {
  name?: string;
  isActive?: boolean;
  tagId?: string | null;
  description?: string | null;
  status?: 'draft' | 'active' | 'archived';
}

export async function update(tenantId: string, id: string, input: UpdateBudgetInput) {
  const [updated] = await db.update(budgets).set({ ...input, updatedAt: new Date() })
    .where(and(eq(budgets.tenantId, tenantId), eq(budgets.id, id))).returning();
  if (!updated) throw AppError.notFound('Budget not found');
  return updated;
}

export async function remove(tenantId: string, id: string) {
  // `budget_lines` has no tenant_id column — it's scoped transitively
  // via `budget_id → budgets.tenant_id`. We verify ownership before
  // deleting the lines so a malformed id can't wipe another tenant's
  // budget lines, and we wrap both deletes in a transaction so a
  // partial failure doesn't leave dangling lines.
  await db.transaction(async (tx) => {
    const budget = await tx.query.budgets.findFirst({
      where: and(eq(budgets.tenantId, tenantId), eq(budgets.id, id)),
    });
    if (!budget) throw AppError.notFound('Budget not found');

    await tx.delete(budgetLines).where(eq(budgetLines.budgetId, id));
    await tx.delete(budgets).where(and(eq(budgets.tenantId, tenantId), eq(budgets.id, id)));
  });
}

export async function getLines(tenantId: string, budgetId: string) {
  await getById(tenantId, budgetId);
  const lines = await db.execute(sql`
    SELECT bl.*, a.name as account_name, a.account_number, a.account_type
    FROM budget_lines bl
    JOIN accounts a ON a.id = bl.account_id
    WHERE bl.budget_id = ${budgetId}
    ORDER BY a.account_type, a.account_number, a.name
  `);
  return lines.rows;
}

export async function updateLines(tenantId: string, budgetId: string, lines: Array<{
  accountId: string; month1?: string; month2?: string; month3?: string; month4?: string;
  month5?: string; month6?: string; month7?: string; month8?: string;
  month9?: string; month10?: string; month11?: string; month12?: string;
}>) {
  await getById(tenantId, budgetId);

  for (const line of lines) {
    const existing = await db.query.budgetLines.findFirst({
      where: and(eq(budgetLines.budgetId, budgetId), eq(budgetLines.accountId, line.accountId)),
    });

    const values = {
      month1: line.month1 || '0', month2: line.month2 || '0', month3: line.month3 || '0',
      month4: line.month4 || '0', month5: line.month5 || '0', month6: line.month6 || '0',
      month7: line.month7 || '0', month8: line.month8 || '0', month9: line.month9 || '0',
      month10: line.month10 || '0', month11: line.month11 || '0', month12: line.month12 || '0',
    };

    if (existing) {
      await db.update(budgetLines).set(values).where(eq(budgetLines.id, existing.id));
    } else {
      await db.insert(budgetLines).values({ budgetId, accountId: line.accountId, ...values });
    }
  }
}

export async function fillFromActuals(tenantId: string, budgetId: string) {
  const budget = await getById(tenantId, budgetId);

  // Get company fiscal year start
  const companyResult = await db.execute(sql`SELECT fiscal_year_start_month FROM companies WHERE tenant_id = ${tenantId} LIMIT 1`);
  const fyStartMonth = (companyResult.rows as any[])[0]?.fiscal_year_start_month || 1;

  // ADR 0XW §4 — when the budget is tag-scoped, the seed must also be
  // tag-scoped so next year's plan mirrors the same slice of actuals
  // the Budget vs. Actuals report will later evaluate. When the budget
  // is company-wide (tagId is null) we aggregate every line, matching
  // the prior behavior.
  const budgetTagId = (budget as { tagId?: string | null }).tagId ?? null;

  // Get actuals for the prior fiscal year
  const priorYear = budget.fiscalYear - 1;
  const revenueExpenseAccounts = await db.select().from(accounts)
    .where(and(eq(accounts.tenantId, tenantId), eq(accounts.isActive, true)));

  for (const account of revenueExpenseAccounts.filter((a) => ['revenue', 'cogs', 'expense', 'other_revenue', 'other_expense'].includes(a.accountType))) {
    const monthlyAmounts: string[] = [];
    for (let m = 0; m < 12; m++) {
      const month = ((fyStartMonth - 1 + m) % 12) + 1;
      const year = fyStartMonth > 1 && month < fyStartMonth ? priorYear + 1 : priorYear;
      const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
      const endDate = new Date(year, month, 0).toISOString().split('T')[0]!;

      const result = await db.execute(sql`
        SELECT COALESCE(SUM(jl.debit), 0) as total_debit, COALESCE(SUM(jl.credit), 0) as total_credit
        FROM journal_lines jl
        JOIN transactions t ON t.id = jl.transaction_id
        WHERE jl.tenant_id = ${tenantId} AND jl.account_id = ${account.id}
          AND t.status = 'posted' AND t.txn_date >= ${startDate} AND t.txn_date <= ${endDate}
          ${budgetTagId ? sql`AND jl.tag_id = ${budgetTagId}` : sql``}
      `);
      const row = (result.rows as any[])[0] || { total_debit: '0', total_credit: '0' };
      const amount = Math.abs(parseFloat(row.total_credit) - parseFloat(row.total_debit));
      monthlyAmounts.push(amount.toFixed(4));
    }

    await updateLines(tenantId, budgetId, [{
      accountId: account.id,
      month1: monthlyAmounts[0], month2: monthlyAmounts[1], month3: monthlyAmounts[2],
      month4: monthlyAmounts[3], month5: monthlyAmounts[4], month6: monthlyAmounts[5],
      month7: monthlyAmounts[6], month8: monthlyAmounts[7], month9: monthlyAmounts[8],
      month10: monthlyAmounts[9], month11: monthlyAmounts[10], month12: monthlyAmounts[11],
    }]);
  }
}

export async function copyFromBudget(tenantId: string, targetBudgetId: string, sourceBudgetId: string) {
  await getById(tenantId, targetBudgetId);
  const sourceLines = await getLines(tenantId, sourceBudgetId);

  const linesToCopy = (sourceLines as any[]).map((line) => ({
    accountId: line.account_id,
    month1: line.month_1 || '0', month2: line.month_2 || '0', month3: line.month_3 || '0',
    month4: line.month_4 || '0', month5: line.month_5 || '0', month6: line.month_6 || '0',
    month7: line.month_7 || '0', month8: line.month_8 || '0', month9: line.month_9 || '0',
    month10: line.month_10 || '0', month11: line.month_11 || '0', month12: line.month_12 || '0',
  }));

  await updateLines(tenantId, targetBudgetId, linesToCopy);
}

export async function adjustByPercent(tenantId: string, budgetId: string, percent: number) {
  await getById(tenantId, budgetId);
  const lines = await getLines(tenantId, budgetId);
  const multiplier = 1 + percent / 100;

  const adjusted = (lines as any[]).map((line) => ({
    accountId: line.account_id,
    month1: (parseFloat(line.month_1 || '0') * multiplier).toFixed(4),
    month2: (parseFloat(line.month_2 || '0') * multiplier).toFixed(4),
    month3: (parseFloat(line.month_3 || '0') * multiplier).toFixed(4),
    month4: (parseFloat(line.month_4 || '0') * multiplier).toFixed(4),
    month5: (parseFloat(line.month_5 || '0') * multiplier).toFixed(4),
    month6: (parseFloat(line.month_6 || '0') * multiplier).toFixed(4),
    month7: (parseFloat(line.month_7 || '0') * multiplier).toFixed(4),
    month8: (parseFloat(line.month_8 || '0') * multiplier).toFixed(4),
    month9: (parseFloat(line.month_9 || '0') * multiplier).toFixed(4),
    month10: (parseFloat(line.month_10 || '0') * multiplier).toFixed(4),
    month11: (parseFloat(line.month_11 || '0') * multiplier).toFixed(4),
    month12: (parseFloat(line.month_12 || '0') * multiplier).toFixed(4),
  }));

  await updateLines(tenantId, budgetId, adjusted);
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

  function buildRow(line: any) {
    const monthTotal = [1,2,3,4,5,6,7,8,9,10,11,12].reduce((s, m) => s + parseFloat(line[`month_${m}`] || '0'), 0);
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
