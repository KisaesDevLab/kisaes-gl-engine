import * as reportService from './report.service.js';

type CompareMode = 'previous_period' | 'previous_year' | 'ytd_vs_prior_ytd' | 'multi_period';
type PeriodType = 'month' | 'quarter' | 'year';
type Basis = 'accrual' | 'cash';

interface DateRange { startDate: string; endDate: string; label: string }

function computeVariance(current: number, prior: number): { dollarChange: number; percentChange: number | null } {
  const dollarChange = current - prior;
  const percentChange = prior === 0 ? null : (dollarChange / Math.abs(prior)) * 100;
  return { dollarChange, percentChange };
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

function getPriorYearRange(startDate: string, endDate: string): DateRange {
  const start = new Date(startDate);
  const end = new Date(endDate);
  start.setFullYear(start.getFullYear() - 1);
  end.setFullYear(end.getFullYear() - 1);
  return {
    startDate: start.toISOString().split('T')[0]!,
    endDate: end.toISOString().split('T')[0]!,
    label: formatLabel(start, end),
  };
}

function getMultiPeriodRanges(endDate: string, periods: number, periodType: PeriodType): DateRange[] {
  const ranges: DateRange[] = [];
  const end = new Date(endDate);

  for (let i = periods - 1; i >= 0; i--) {
    let pStart: Date, pEnd: Date;
    if (periodType === 'month') {
      pStart = new Date(end.getFullYear(), end.getMonth() - i, 1);
      pEnd = new Date(end.getFullYear(), end.getMonth() - i + 1, 0);
    } else if (periodType === 'quarter') {
      const qEnd = new Date(end.getFullYear(), end.getMonth() - i * 3 + 1, 0);
      const qStart = new Date(qEnd.getFullYear(), qEnd.getMonth() - 2, 1);
      pStart = qStart;
      pEnd = qEnd;
    } else {
      pStart = new Date(end.getFullYear() - i, 0, 1);
      pEnd = new Date(end.getFullYear() - i, 11, 31);
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
  if (start.getMonth() === end.getMonth() && start.getFullYear() === end.getFullYear()) {
    return `${monthNames[start.getMonth()]} ${start.getFullYear()}`;
  }
  return `${monthNames[start.getMonth()]} – ${monthNames[end.getMonth()]} ${end.getFullYear()}`;
}

export async function buildComparativePL(
  tenantId: string, startDate: string, endDate: string, basis: Basis,
  compareMode: CompareMode, periods: number = 6, periodType: PeriodType = 'month',
  companyId: string | null = null,
) {
  if (compareMode === 'multi_period') {
    const ranges = getMultiPeriodRanges(endDate, periods, periodType);
    const columns = ranges.map((r) => ({ label: r.label, startDate: r.startDate, endDate: r.endDate }));
    columns.push({ label: 'Total', startDate: '', endDate: '' });

    // Get P&L for each period
    const plResults = await Promise.all(ranges.map((r) => reportService.buildProfitAndLoss(tenantId, r.startDate, r.endDate, basis, companyId)));

    type PLType = 'revenue' | 'cogs' | 'expense' | 'other_revenue' | 'other_expense';
    const sectionKey: Record<PLType, 'revenue' | 'cogs' | 'expenses' | 'otherRevenue' | 'otherExpenses'> = {
      revenue: 'revenue', cogs: 'cogs', expense: 'expenses',
      other_revenue: 'otherRevenue', other_expense: 'otherExpenses',
    };
    const accountMap = new Map<string, { accountId: string; name: string; accountNumber: string | null; type: PLType }>();
    for (const pl of plResults) {
      for (const r of pl.revenue) accountMap.set(r.name, { accountId: r.accountId, name: r.name, accountNumber: r.accountNumber, type: 'revenue' });
      for (const r of pl.cogs) accountMap.set(r.name, { accountId: r.accountId, name: r.name, accountNumber: r.accountNumber, type: 'cogs' });
      for (const r of pl.expenses) accountMap.set(r.name, { accountId: r.accountId, name: r.name, accountNumber: r.accountNumber, type: 'expense' });
      for (const r of pl.otherRevenue) accountMap.set(r.name, { accountId: r.accountId, name: r.name, accountNumber: r.accountNumber, type: 'other_revenue' });
      for (const r of pl.otherExpenses) accountMap.set(r.name, { accountId: r.accountId, name: r.name, accountNumber: r.accountNumber, type: 'other_expense' });
    }

    const rows = [...accountMap.values()].map((acct) => {
      const values = plResults.map((pl) => {
        const items = (pl as any)[sectionKey[acct.type]] as Array<{ name: string; amount: number }>;
        return items.find((i) => i.name === acct.name)?.amount || 0;
      });
      values.push(values.reduce((a, b) => a + b, 0)); // Total column
      return { accountId: acct.accountId, account: acct.name, accountNumber: acct.accountNumber, accountType: acct.type, values };
    });

    const withTotal = (vals: number[]) => { vals.push(vals.reduce((a, b) => a + b, 0)); return vals; };
    const revTotals = withTotal(plResults.map((pl) => pl.totalRevenue));
    const cogsTotals = withTotal(plResults.map((pl) => pl.totalCogs));
    const expTotals = withTotal(plResults.map((pl) => pl.totalExpenses));
    const otherRevTotals = withTotal(plResults.map((pl) => pl.totalOtherRevenue));
    const otherExpTotals = withTotal(plResults.map((pl) => pl.totalOtherExpenses));
    const netTotals = withTotal(plResults.map((pl) => pl.netIncome));

    return {
      title: 'Profit and Loss (Comparative)', comparisonMode: compareMode,
      labels: plResults[0]?.labels,
      columns, rows,
      totalRevenue: revTotals,
      totalCogs: cogsTotals,
      totalExpenses: expTotals,
      totalOtherRevenue: otherRevTotals,
      totalOtherExpenses: otherExpTotals,
      netIncome: netTotals,
    };
  }

  // Two-column comparison modes
  const currentPL = await reportService.buildProfitAndLoss(tenantId, startDate, endDate, basis, companyId);
  let priorRange: DateRange;

  if (compareMode === 'previous_year') {
    priorRange = getPriorYearRange(startDate, endDate);
  } else if (compareMode === 'ytd_vs_prior_ytd') {
    priorRange = getPriorYearRange(startDate, endDate);
  } else {
    priorRange = getPriorPeriodRange(startDate, endDate);
  }

  const priorPL = await reportService.buildProfitAndLoss(tenantId, priorRange.startDate, priorRange.endDate, basis, companyId);

  const columns = [
    { label: formatLabel(new Date(startDate), new Date(endDate)), startDate, endDate },
    { label: priorRange.label, startDate: priorRange.startDate, endDate: priorRange.endDate },
    { label: '$ Change', type: 'variance' },
    { label: '% Change', type: 'percent_variance' },
  ];

  type PLType = 'revenue' | 'cogs' | 'expense' | 'other_revenue' | 'other_expense';
  const allAccounts = new Map<string, { accountId: string; name: string; accountNumber: string | null; type: PLType }>();
  const collect = (pl: any) => {
    for (const r of pl.revenue) allAccounts.set(r.name, { accountId: r.accountId, name: r.name, accountNumber: r.accountNumber, type: 'revenue' });
    for (const r of pl.cogs) allAccounts.set(r.name, { accountId: r.accountId, name: r.name, accountNumber: r.accountNumber, type: 'cogs' });
    for (const r of pl.expenses) allAccounts.set(r.name, { accountId: r.accountId, name: r.name, accountNumber: r.accountNumber, type: 'expense' });
    for (const r of pl.otherRevenue) allAccounts.set(r.name, { accountId: r.accountId, name: r.name, accountNumber: r.accountNumber, type: 'other_revenue' });
    for (const r of pl.otherExpenses) allAccounts.set(r.name, { accountId: r.accountId, name: r.name, accountNumber: r.accountNumber, type: 'other_expense' });
  };
  collect(currentPL);
  collect(priorPL);

  const sectionKey: Record<PLType, 'revenue' | 'cogs' | 'expenses' | 'otherRevenue' | 'otherExpenses'> = {
    revenue: 'revenue', cogs: 'cogs', expense: 'expenses',
    other_revenue: 'otherRevenue', other_expense: 'otherExpenses',
  };

  const rows = [...allAccounts.values()].map((acct) => {
    const currentItems = (currentPL as any)[sectionKey[acct.type]] as Array<{ name: string; amount: number }>;
    const priorItems = (priorPL as any)[sectionKey[acct.type]] as Array<{ name: string; amount: number }>;
    const current = currentItems.find((i) => i.name === acct.name)?.amount || 0;
    const prior = priorItems.find((i) => i.name === acct.name)?.amount || 0;
    const v = computeVariance(current, prior);
    return { accountId: acct.accountId, account: acct.name, accountNumber: acct.accountNumber, accountType: acct.type, values: [current, prior, v.dollarChange, v.percentChange] };
  });

  const varRow = (cur: number, pr: number) => {
    const v = computeVariance(cur, pr);
    return [cur, pr, v.dollarChange, v.percentChange];
  };

  return {
    title: 'Profit and Loss (Comparative)', comparisonMode: compareMode,
    labels: currentPL.labels,
    columns, rows,
    totalRevenue: varRow(currentPL.totalRevenue, priorPL.totalRevenue),
    totalCogs: varRow(currentPL.totalCogs, priorPL.totalCogs),
    totalExpenses: varRow(currentPL.totalExpenses, priorPL.totalExpenses),
    totalOtherRevenue: varRow(currentPL.totalOtherRevenue, priorPL.totalOtherRevenue),
    totalOtherExpenses: varRow(currentPL.totalOtherExpenses, priorPL.totalOtherExpenses),
    netIncome: varRow(currentPL.netIncome, priorPL.netIncome),
  };
}

export async function buildComparativeBS(
  tenantId: string, asOfDate: string, basis: Basis, compareMode: CompareMode,
  companyId: string | null = null,
) {
  const currentBS = await reportService.buildBalanceSheet(tenantId, asOfDate, basis, companyId);
  let priorDate: string;

  if (compareMode === 'previous_year') {
    const d = new Date(asOfDate);
    d.setFullYear(d.getFullYear() - 1);
    priorDate = d.toISOString().split('T')[0]!;
  } else {
    const d = new Date(asOfDate);
    d.setMonth(d.getMonth() - 1);
    priorDate = d.toISOString().split('T')[0]!;
  }

  const priorBS = await reportService.buildBalanceSheet(tenantId, priorDate, basis, companyId);

  // Per-column asOfDate lets the web's QuickZoom drill-down build the right
  // transaction filter for each period. Variance columns carry no date.
  const columns = [
    { label: asOfDate, asOfDate },
    { label: priorDate, asOfDate: priorDate },
    { label: '$ Change', type: 'variance' },
    { label: '% Change', type: 'percent_variance' },
  ];

  type BSRow = { accountId: string | null; name: string; accountNumber: string | null; balance: number };
  function mergeSection(current: BSRow[], prior: BSRow[]) {
    const names = new Set([...current.map((c) => c.name), ...prior.map((p) => p.name)]);
    return [...names].map((name) => {
      const cur = current.find((c) => c.name === name);
      const pri = prior.find((p) => p.name === name);
      const curBal = cur?.balance || 0;
      const priBal = pri?.balance || 0;
      const v = computeVariance(curBal, priBal);
      return {
        accountId: cur?.accountId ?? pri?.accountId ?? null,
        name,
        values: [curBal, priBal, v.dollarChange, v.percentChange],
      };
    });
  }

  return {
    title: 'Balance Sheet (Comparative)', comparisonMode: compareMode, columns,
    assets: mergeSection(currentBS.assets, priorBS.assets),
    liabilities: mergeSection(currentBS.liabilities, priorBS.liabilities),
    equity: mergeSection(currentBS.equity, priorBS.equity),
    totalAssets: [currentBS.totalAssets, priorBS.totalAssets, ...Object.values(computeVariance(currentBS.totalAssets, priorBS.totalAssets))],
    totalLiabilities: [currentBS.totalLiabilities, priorBS.totalLiabilities, ...Object.values(computeVariance(currentBS.totalLiabilities, priorBS.totalLiabilities))],
    totalEquity: [currentBS.totalEquity, priorBS.totalEquity, ...Object.values(computeVariance(currentBS.totalEquity, priorBS.totalEquity))],
  };
}
