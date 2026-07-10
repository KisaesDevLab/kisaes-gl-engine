// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { formatDetailTypeLabel } from '@kis-books/shared';
import * as reportService from './report.service.js';
import { getCustomDetailTypeRanks, orderDetailTypeGroups } from './detail-types.service.js';

type CompareMode = 'previous_period' | 'previous_year' | 'ytd_vs_prior_ytd' | 'multi_period';
type PeriodType = 'month' | 'quarter' | 'year';
type Basis = 'accrual' | 'cash';

interface DateRange { startDate: string; endDate: string; label: string }

// `favorabilitySign` flips the change columns for cost sections so the $/%
// change represents impact on net income, not a raw delta: spending MORE reads
// as a negative (unfavorable) change and spending LESS as positive. Revenue
// passes +1 (raw). With this, green = helped profit / red = hurt profit for
// every row, and the section changes sum to the (raw) net-income change.
function computeVariance(current: number, prior: number, favorabilitySign: 1 | -1 = 1): { dollarChange: number; percentChange: number | null } {
  const dollarChange = favorabilitySign * (current - prior);
  const percentChange = prior === 0 ? null : (dollarChange / Math.abs(prior)) * 100;
  return { dollarChange, percentChange };
}

// P&L cost sections (COGS + operating + other expense) flip; revenue stays raw.
// Balance-sheet comparatives never pass a sign, so they keep the +1 default.
type PLAcctType = 'revenue' | 'cogs' | 'expense' | 'other_revenue' | 'other_expense';
const favSign = (t: PLAcctType): 1 | -1 => (t === 'cogs' || t === 'expense' || t === 'other_expense' ? -1 : 1);

// ─── Detail-type grouping for comparative reports ────────────────
//
// Same option as the standard reports (?group_by=detail_type), same
// additive-only contract: the existing comparative shapes are untouched
// and a `groups` field is added per section, each group carrying its
// member rows plus a per-column subtotal row.

// One group of comparative rows sharing a detail type. `values` is the
// group's subtotal for EVERY column — plain sums for period columns,
// re-derived variance / % variance for the change columns (summing
// per-row percentages would be nonsense).
export interface ComparativeDetailTypeGroup<T> {
  detailType: string | null;
  label: string;
  rows: T[];
  values: Array<number | null>;
}

type ComparativeColumn = { label: string; type?: string };

// Subtotal a set of comparative rows column-by-column with the same
// variance semantics used for account rows and section totals:
//   - plain columns: sum of the member rows' values
//   - 'variance': current-sum − prior-sum (columns 0 and 1)
//   - 'percent_variance': computeVariance(currentSum, priorSum) — null
//     when the prior sum is zero, matching account-row behavior.
function subtotalValues(rows: Array<{ values: Array<number | null> }>, columns: ComparativeColumn[], favorabilitySign: 1 | -1 = 1): Array<number | null> {
  const sums = columns.map((col, i) => {
    if (col.type === 'variance' || col.type === 'percent_variance') return 0;
    return rows.reduce((acc, r) => acc + (r.values[i] ?? 0), 0);
  });
  const out: Array<number | null> = [...sums];
  for (let i = 0; i < columns.length; i++) {
    const col = columns[i];
    if (col?.type === 'variance') {
      out[i] = favorabilitySign * ((sums[0] ?? 0) - (sums[1] ?? 0));
    } else if (col?.type === 'percent_variance') {
      out[i] = computeVariance(sums[0] ?? 0, sums[1] ?? 0, favorabilitySign).percentChange;
    }
  }
  return out;
}

// Group comparative rows by detailType in order of first occurrence
// (null → 'Other'). Rows flagged `calculated` (the BS's computed
// Retained Earnings / Net Income rows) land in a dedicated trailing
// 'Equity (Calculated)' group.
function groupComparativeRows<T extends { detailType?: string | null; values: Array<number | null> }>(
  rows: T[],
  columns: ComparativeColumn[],
  isCalculated: (row: T) => boolean = () => false,
  favorabilitySign: 1 | -1 = 1,
): Array<ComparativeDetailTypeGroup<T>> {
  const groups = new Map<string, ComparativeDetailTypeGroup<T>>();
  const calculated: T[] = [];
  for (const row of rows) {
    if (isCalculated(row)) { calculated.push(row); continue; }
    const dt = row.detailType ?? null;
    const key = dt ?? '__other__';
    let group = groups.get(key);
    if (!group) {
      group = { detailType: dt, label: formatDetailTypeLabel(dt), rows: [], values: [] };
      groups.set(key, group);
    }
    group.rows.push(row);
  }
  const out = Array.from(groups.values());
  if (calculated.length > 0) {
    out.push({ detailType: null, label: 'Equity (Calculated)', rows: calculated, values: [] });
  }
  for (const g of out) g.values = subtotalValues(g.rows, columns, favorabilitySign);
  return out;
}

function getPriorPeriodRange(startDate: string, endDate: string): DateRange {
  const start = new Date(startDate);
  const end = new Date(endDate);
  const durationMs = end.getTime() - start.getTime();
  const priorEnd = new Date(start.getTime() - 86400000); // day before current start
  const priorStart = new Date(priorEnd.getTime() - durationMs);
  return {
    startDate: priorStart.toISOString().split('T')[0]!,
    endDate: priorEnd.toISOString().split('T')[0]!,
    label: formatLabel(priorStart, priorEnd),
  };
}

// Shift a YYYY-MM-DD string by whole years with pure string math —
// no Date round-trip, so no TZ drift, and Feb 29 clamps to Feb 28
// instead of rolling into March.
function shiftYearStr(d: string, delta: number): string {
  const y = parseInt(d.slice(0, 4), 10) + delta;
  let md = d.slice(5);
  const isLeap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  if (md === '02-29' && !isLeap) md = '02-28';
  return `${y}-${md}`;
}

function getPriorYearRange(startDate: string, endDate: string): DateRange {
  const s = shiftYearStr(startDate, -1);
  const e = shiftYearStr(endDate, -1);
  return { startDate: s, endDate: e, label: formatLabelStr(s, e) };
}

// All arithmetic in UTC. The previous local-getter version shifted
// boundary dates by a day (or a whole column) whenever the container
// TZ differed from UTC. `fyStartMonth` makes the 'year' columns FISCAL
// years — a July-FY company's "last 3 years" P&L used to split each
// fiscal year across two calendar-year columns.
function getMultiPeriodRanges(endDate: string, periods: number, periodType: PeriodType, fyStartMonth: number = 1): DateRange[] {
  const ranges: DateRange[] = [];
  const end = new Date(endDate + 'T00:00:00Z');

  for (let i = periods - 1; i >= 0; i--) {
    let pStart: Date, pEnd: Date;
    if (periodType === 'month') {
      pStart = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - i, 1));
      pEnd = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - i + 1, 0));
    } else if (periodType === 'quarter') {
      pEnd = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - i * 3 + 1, 0));
      pStart = new Date(Date.UTC(pEnd.getUTCFullYear(), pEnd.getUTCMonth() - 2, 1));
    } else {
      // Fiscal year containing endDate, walked back i years.
      let fyY = end.getUTCFullYear();
      if (end.getUTCMonth() + 1 < fyStartMonth) fyY--;
      pStart = new Date(Date.UTC(fyY - i, fyStartMonth - 1, 1));
      pEnd = new Date(Date.UTC(fyY - i + 1, fyStartMonth - 1, 0));
    }
    ranges.push({
      startDate: pStart.toISOString().split('T')[0]!,
      endDate: pEnd.toISOString().split('T')[0]!,
      label: formatLabel(pStart, pEnd),
    });
  }
  return ranges;
}

function formatLabel(start: Date, end: Date): string {
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  // UTC getters — these Dates are always UTC-midnight calendar days.
  if (start.getUTCMonth() === end.getUTCMonth() && start.getUTCFullYear() === end.getUTCFullYear()) {
    return `${monthNames[start.getUTCMonth()]} ${start.getUTCFullYear()}`;
  }
  return `${monthNames[start.getUTCMonth()]} – ${monthNames[end.getUTCMonth()]} ${end.getUTCFullYear()}`;
}

function formatLabelStr(startDate: string, endDate: string): string {
  return formatLabel(new Date(startDate + 'T00:00:00Z'), new Date(endDate + 'T00:00:00Z'));
}

export async function buildComparativePL(
  tenantId: string, startDate: string, endDate: string, basis: Basis,
  compareMode: CompareMode, periods: number = 6, periodType: PeriodType = 'month',
  companyId: string | null = null,
  // Optional grouping mode (?group_by=detail_type) -- additive `groups`
  // field per section; existing comparative shape untouched.
  groupBy: reportService.ReportGroupBy | null = null,
) {
  const grouped = groupBy === 'detail_type';
  if (compareMode === 'multi_period') {
    const fyStartMonth = periodType === 'year'
      ? await reportService.getFiscalYearStart(tenantId, companyId)
      : 1;
    const ranges = getMultiPeriodRanges(endDate, periods, periodType, fyStartMonth);
    const columns = ranges.map((r) => ({ label: r.label, startDate: r.startDate, endDate: r.endDate }));
    columns.push({ label: 'Total', startDate: '', endDate: '' });

    // Get P&L for each period
    const plResults = await Promise.all(ranges.map((r) => reportService.buildProfitAndLoss(tenantId, r.startDate, r.endDate, basis, companyId, null, groupBy)));

    type PLType = 'revenue' | 'cogs' | 'expense' | 'other_revenue' | 'other_expense';
    const sectionKey: Record<PLType, 'revenue' | 'cogs' | 'expenses' | 'otherRevenue' | 'otherExpenses'> = {
      revenue: 'revenue', cogs: 'cogs', expense: 'expenses',
      other_revenue: 'otherRevenue', other_expense: 'otherExpenses',
    };
    const accountMap = new Map<string, { accountId: string; name: string; accountNumber: string | null; type: PLType; detailType: string | null }>();
    for (const pl of plResults) {
      for (const r of pl.revenue) accountMap.set(r.accountId ?? r.name, { accountId: r.accountId, name: r.name, accountNumber: r.accountNumber, type: 'revenue', detailType: r.detailType ?? null });
      for (const r of pl.cogs) accountMap.set(r.accountId ?? r.name, { accountId: r.accountId, name: r.name, accountNumber: r.accountNumber, type: 'cogs', detailType: r.detailType ?? null });
      for (const r of pl.expenses) accountMap.set(r.accountId ?? r.name, { accountId: r.accountId, name: r.name, accountNumber: r.accountNumber, type: 'expense', detailType: r.detailType ?? null });
      for (const r of pl.otherRevenue) accountMap.set(r.accountId ?? r.name, { accountId: r.accountId, name: r.name, accountNumber: r.accountNumber, type: 'other_revenue', detailType: r.detailType ?? null });
      for (const r of pl.otherExpenses) accountMap.set(r.accountId ?? r.name, { accountId: r.accountId, name: r.name, accountNumber: r.accountNumber, type: 'other_expense', detailType: r.detailType ?? null });
    }

    const rows = [...accountMap.values()].map((acct) => {
      const values = plResults.map((pl) => {
        const items = (pl as any)[sectionKey[acct.type]] as Array<{ accountId: string; name: string; amount: number }>;
        return items.find((i) => i.accountId === acct.accountId)?.amount || 0;
      });
      values.push(values.reduce((a, b) => a + b, 0)); // Total column
      return {
        accountId: acct.accountId, account: acct.name, accountNumber: acct.accountNumber,
        accountType: acct.type, values,
        ...(grouped ? { detailType: acct.detailType } : {}),
      };
    });

    // Grouped mode: per-section detail-type groups with per-column
    // subtotal rows (all plain sums here -- multi-period columns carry
    // no variance columns; the trailing Total column sums like any other).
    // Custom detail types follow the tenant's presentation order —
    // same shared helper as the standard P&L/BS builders.
    const ranks = grouped ? await getCustomDetailTypeRanks(tenantId) : null;
    const plGroups = grouped && ranks
      ? {
          revenue: orderDetailTypeGroups(groupComparativeRows(rows.filter((r) => r.accountType === 'revenue'), columns), ranks, 'revenue'),
          cogs: orderDetailTypeGroups(groupComparativeRows(rows.filter((r) => r.accountType === 'cogs'), columns), ranks, 'cogs'),
          expenses: orderDetailTypeGroups(groupComparativeRows(rows.filter((r) => r.accountType === 'expense'), columns), ranks, 'expense'),
          otherRevenue: orderDetailTypeGroups(groupComparativeRows(rows.filter((r) => r.accountType === 'other_revenue'), columns), ranks, 'other_revenue'),
          otherExpenses: orderDetailTypeGroups(groupComparativeRows(rows.filter((r) => r.accountType === 'other_expense'), columns), ranks, 'other_expense'),
        }
      : undefined;

    const withTotal = (vals: number[]) => { vals.push(vals.reduce((a, b) => a + b, 0)); return vals; };
    const revTotals = withTotal(plResults.map((pl) => pl.totalRevenue));
    const cogsTotals = withTotal(plResults.map((pl) => pl.totalCogs));
    const expTotals = withTotal(plResults.map((pl) => pl.totalExpenses));
    const otherRevTotals = withTotal(plResults.map((pl) => pl.totalOtherRevenue));
    const otherExpTotals = withTotal(plResults.map((pl) => pl.totalOtherExpenses));
    const netTotals = withTotal(plResults.map((pl) => pl.netIncome));

    return {
      title: 'Profit and Loss (Comparative)' + reportService.basisTitleSuffix(basis), comparisonMode: compareMode,
      labels: plResults[0]?.labels,
      footer: plResults[0]?.footer ?? '',
      columns, rows,
      totalRevenue: revTotals,
      totalCogs: cogsTotals,
      totalExpenses: expTotals,
      totalOtherRevenue: otherRevTotals,
      totalOtherExpenses: otherExpTotals,
      netIncome: netTotals,
      ...(plGroups ? { groupBy: 'detail_type' as const, groups: plGroups } : {}),
    };
  }

  // Two-column comparison modes
  const currentPL = await reportService.buildProfitAndLoss(tenantId, startDate, endDate, basis, companyId, null, groupBy);
  let priorRange: DateRange;

  if (compareMode === 'previous_year') {
    priorRange = getPriorYearRange(startDate, endDate);
  } else if (compareMode === 'ytd_vs_prior_ytd') {
    priorRange = getPriorYearRange(startDate, endDate);
  } else {
    priorRange = getPriorPeriodRange(startDate, endDate);
  }

  const priorPL = await reportService.buildProfitAndLoss(tenantId, priorRange.startDate, priorRange.endDate, basis, companyId, null, groupBy);

  const columns = [
    { label: formatLabel(new Date(startDate), new Date(endDate)), startDate, endDate },
    { label: priorRange.label, startDate: priorRange.startDate, endDate: priorRange.endDate },
    { label: '$ Change', type: 'variance' },
    { label: '% Change', type: 'percent_variance' },
  ];

  type PLType = 'revenue' | 'cogs' | 'expense' | 'other_revenue' | 'other_expense';
  const allAccounts = new Map<string, { accountId: string; name: string; accountNumber: string | null; type: PLType; detailType: string | null }>();
  const collect = (pl: any) => {
    for (const r of pl.revenue) allAccounts.set(r.accountId ?? r.name, { accountId: r.accountId, name: r.name, accountNumber: r.accountNumber, type: 'revenue', detailType: r.detailType ?? null });
    for (const r of pl.cogs) allAccounts.set(r.accountId ?? r.name, { accountId: r.accountId, name: r.name, accountNumber: r.accountNumber, type: 'cogs', detailType: r.detailType ?? null });
    for (const r of pl.expenses) allAccounts.set(r.accountId ?? r.name, { accountId: r.accountId, name: r.name, accountNumber: r.accountNumber, type: 'expense', detailType: r.detailType ?? null });
    for (const r of pl.otherRevenue) allAccounts.set(r.accountId ?? r.name, { accountId: r.accountId, name: r.name, accountNumber: r.accountNumber, type: 'other_revenue', detailType: r.detailType ?? null });
    for (const r of pl.otherExpenses) allAccounts.set(r.accountId ?? r.name, { accountId: r.accountId, name: r.name, accountNumber: r.accountNumber, type: 'other_expense', detailType: r.detailType ?? null });
  };
  collect(currentPL);
  collect(priorPL);

  const sectionKey: Record<PLType, 'revenue' | 'cogs' | 'expenses' | 'otherRevenue' | 'otherExpenses'> = {
    revenue: 'revenue', cogs: 'cogs', expense: 'expenses',
    other_revenue: 'otherRevenue', other_expense: 'otherExpenses',
  };

  const rows = [...allAccounts.values()].map((acct) => {
    const currentItems = (currentPL as any)[sectionKey[acct.type]] as Array<{ accountId: string; name: string; amount: number }>;
    const priorItems = (priorPL as any)[sectionKey[acct.type]] as Array<{ accountId: string; name: string; amount: number }>;
    const current = currentItems.find((i) => i.accountId === acct.accountId)?.amount || 0;
    const prior = priorItems.find((i) => i.accountId === acct.accountId)?.amount || 0;
    const v = computeVariance(current, prior, favSign(acct.type));
    return {
      accountId: acct.accountId, account: acct.name, accountNumber: acct.accountNumber,
      accountType: acct.type, values: [current, prior, v.dollarChange, v.percentChange],
      ...(grouped ? { detailType: acct.detailType } : {}),
    };
  });

  // Grouped mode: per-section detail-type groups. Subtotal rows carry
  // values for every column -- current/prior sums with the $ / % change
  // re-derived from those sums (same semantics as account rows). Custom
  // detail types follow the tenant's presentation order (shared helper).
  const ranks = grouped ? await getCustomDetailTypeRanks(tenantId) : null;
  const plGroups = grouped && ranks
    ? {
        revenue: orderDetailTypeGroups(groupComparativeRows(rows.filter((r) => r.accountType === 'revenue'), columns, undefined, favSign('revenue')), ranks, 'revenue'),
        cogs: orderDetailTypeGroups(groupComparativeRows(rows.filter((r) => r.accountType === 'cogs'), columns, undefined, favSign('cogs')), ranks, 'cogs'),
        expenses: orderDetailTypeGroups(groupComparativeRows(rows.filter((r) => r.accountType === 'expense'), columns, undefined, favSign('expense')), ranks, 'expense'),
        otherRevenue: orderDetailTypeGroups(groupComparativeRows(rows.filter((r) => r.accountType === 'other_revenue'), columns, undefined, favSign('other_revenue')), ranks, 'other_revenue'),
        otherExpenses: orderDetailTypeGroups(groupComparativeRows(rows.filter((r) => r.accountType === 'other_expense'), columns, undefined, favSign('other_expense')), ranks, 'other_expense'),
      }
    : undefined;

  // Section totals mirror account-row favorability: cost totals flip, revenue
  // and net income stay raw (net income up is always favorable).
  const varRow = (cur: number, pr: number, favorabilitySign: 1 | -1 = 1) => {
    const v = computeVariance(cur, pr, favorabilitySign);
    return [cur, pr, v.dollarChange, v.percentChange];
  };

  return {
    title: 'Profit and Loss (Comparative)' + reportService.basisTitleSuffix(basis), comparisonMode: compareMode,
    labels: currentPL.labels,
    footer: currentPL.footer,
    columns, rows,
    totalRevenue: varRow(currentPL.totalRevenue, priorPL.totalRevenue, favSign('revenue')),
    totalCogs: varRow(currentPL.totalCogs, priorPL.totalCogs, favSign('cogs')),
    totalExpenses: varRow(currentPL.totalExpenses, priorPL.totalExpenses, favSign('expense')),
    totalOtherRevenue: varRow(currentPL.totalOtherRevenue, priorPL.totalOtherRevenue, favSign('other_revenue')),
    totalOtherExpenses: varRow(currentPL.totalOtherExpenses, priorPL.totalOtherExpenses, favSign('other_expense')),
    netIncome: varRow(currentPL.netIncome, priorPL.netIncome),
    ...(plGroups ? { groupBy: 'detail_type' as const, groups: plGroups } : {}),
  };
}

export async function buildComparativeBS(
  tenantId: string, asOfDate: string, basis: Basis, compareMode: CompareMode,
  companyId: string | null = null,
  // Optional grouping mode (?group_by=detail_type) -- additive `groups`
  // field per section; existing comparative shape untouched.
  groupBy: reportService.ReportGroupBy | null = null,
) {
  const grouped = groupBy === 'detail_type';
  const currentBS = await reportService.buildBalanceSheet(tenantId, asOfDate, basis, companyId, null, groupBy);
  let priorDate: string;

  if (compareMode === 'previous_year') {
    // String year-shift: TZ-proof and Feb-29-safe.
    priorDate = shiftYearStr(asOfDate, -1);
  } else {
    // UTC month-shift so the boundary day can't drift in non-UTC
    // containers. (setUTCMonth on day-31 clamps forward like setMonth —
    // acceptable for a comparative as-of column.)
    const d = new Date(asOfDate + 'T00:00:00Z');
    d.setUTCMonth(d.getUTCMonth() - 1);
    priorDate = d.toISOString().split('T')[0]!;
  }

  const priorBS = await reportService.buildBalanceSheet(tenantId, priorDate, basis, companyId, null, groupBy);

  // Per-column asOfDate lets the web's QuickZoom drill-down build the right
  // transaction filter for each period. Variance columns carry no date.
  const columns = [
    { label: asOfDate, asOfDate },
    { label: priorDate, asOfDate: priorDate },
    { label: '$ Change', type: 'variance' },
    { label: '% Change', type: 'percent_variance' },
  ];

  type BSRow = { accountId: string | null; name: string; accountNumber: string | null; balance: number; detailType?: string | null };
  // Key by accountId, NOT name: account names aren't unique (only numbers are),
  // so name-keying collapsed two same-named accounts into one row and hid the
  // second account's prior-period amount when it had no current balance.
  // Calculated rows (Retained Earnings / Net Income) have no accountId → key by
  // name, which is unique for them. Current-period order first, then any
  // account that exists only in the prior period.
  function mergeSection(current: BSRow[], prior: BSRow[]) {
    const keyOf = (r: BSRow) => r.accountId ?? `name:${r.name}`;
    const curByKey = new Map<string, BSRow>();
    const priByKey = new Map<string, BSRow>();
    const order: string[] = [];
    for (const c of current) { const k = keyOf(c); if (!curByKey.has(k)) { curByKey.set(k, c); order.push(k); } }
    for (const p of prior) { const k = keyOf(p); if (!priByKey.has(k)) { priByKey.set(k, p); if (!curByKey.has(k)) order.push(k); } }
    return order.map((k) => {
      const cur = curByKey.get(k);
      const pri = priByKey.get(k);
      const curBal = cur?.balance || 0;
      const priBal = pri?.balance || 0;
      const v = computeVariance(curBal, priBal);
      return {
        accountId: cur?.accountId ?? pri?.accountId ?? null,
        name: cur?.name ?? pri?.name ?? '',
        accountNumber: cur?.accountNumber ?? pri?.accountNumber ?? null,
        values: [curBal, priBal, v.dollarChange, v.percentChange] as Array<number | null>,
        // Present only in grouped mode (the underlying BS entries carry
        // detailType only when built with groupBy).
        ...(grouped ? { detailType: (cur?.detailType ?? pri?.detailType) ?? null } : {}),
      };
    });
  }

  const mergedAssets = mergeSection(currentBS.assets, priorBS.assets);
  const mergedLiabilities = mergeSection(currentBS.liabilities, priorBS.liabilities);
  const mergedEquity = mergeSection(currentBS.equity, priorBS.equity);

  // Grouped mode: detail-type groups per section; the computed rows
  // (accountId null: Retained Earnings (Prior Years) / Net Income
  // (Current Year)) land in a trailing 'Equity (Calculated)' group.
  // Custom detail types follow the tenant's presentation order; null-
  // detail groups (incl. the calculated one) stay trailing.
  const ranks = grouped ? await getCustomDetailTypeRanks(tenantId) : null;
  const bsGroups = grouped && ranks
    ? {
        assets: orderDetailTypeGroups(groupComparativeRows(mergedAssets, columns), ranks, 'asset'),
        liabilities: orderDetailTypeGroups(groupComparativeRows(mergedLiabilities, columns), ranks, 'liability'),
        equity: orderDetailTypeGroups(groupComparativeRows(mergedEquity, columns, (r) => r.accountId === null), ranks, 'equity'),
      }
    : undefined;

  return {
    title: 'Balance Sheet (Comparative)' + reportService.basisTitleSuffix(basis), comparisonMode: compareMode, columns,
    labels: currentBS.labels,
    footer: currentBS.footer,
    assets: mergedAssets,
    liabilities: mergedLiabilities,
    equity: mergedEquity,
    totalAssets: [currentBS.totalAssets, priorBS.totalAssets, ...Object.values(computeVariance(currentBS.totalAssets, priorBS.totalAssets))],
    totalLiabilities: [currentBS.totalLiabilities, priorBS.totalLiabilities, ...Object.values(computeVariance(currentBS.totalLiabilities, priorBS.totalLiabilities))],
    totalEquity: [currentBS.totalEquity, priorBS.totalEquity, ...Object.values(computeVariance(currentBS.totalEquity, priorBS.totalEquity))],
    // Grand total (equals Total Assets when the books balance). Was
    // missing entirely, so the comparative view had no closing
    // "Total Liabilities & Equity" row.
    totalLiabilitiesAndEquity: [
      currentBS.totalLiabilitiesAndEquity,
      priorBS.totalLiabilitiesAndEquity,
      ...Object.values(computeVariance(currentBS.totalLiabilitiesAndEquity, priorBS.totalLiabilitiesAndEquity)),
    ],
    ...(bsGroups ? { groupBy: 'detail_type' as const, groups: bsGroups } : {}),
  };
}
