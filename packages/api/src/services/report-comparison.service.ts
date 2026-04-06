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
) {
  if (compareMode === 'multi_period') {
    const ranges = getMultiPeriodRanges(endDate, periods, periodType);
    const columns = ranges.map((r) => ({ label: r.label, startDate: r.startDate, endDate: r.endDate }));
    columns.push({ label: 'Total', startDate: '', endDate: '' });

    // Get P&L for each period
    const plResults = await Promise.all(ranges.map((r) => reportService.buildProfitAndLoss(tenantId, r.startDate, r.endDate, basis)));

    // Collect all unique accounts
    const accountMap = new Map<string, { name: string; accountNumber: string | null; type: 'revenue' | 'expense' }>();
    for (const pl of plResults) {
      for (const r of pl.revenue) accountMap.set(r.name, { name: r.name, accountNumber: r.accountNumber, type: 'revenue' });
      for (const e of pl.expenses) accountMap.set(e.name, { name: e.name, accountNumber: e.accountNumber, type: 'expense' });
    }

    const rows = [...accountMap.values()].map((acct) => {
      const values = plResults.map((pl) => {
        const items = acct.type === 'revenue' ? pl.revenue : pl.expenses;
        return items.find((i) => i.name === acct.name)?.amount || 0;
      });
      values.push(values.reduce((a, b) => a + b, 0)); // Total column
      return { account: acct.name, accountNumber: acct.accountNumber, accountType: acct.type, values };
    });

    // Add totals
    const revTotals = plResults.map((pl) => pl.totalRevenue);
    revTotals.push(revTotals.reduce((a, b) => a + b, 0));
    const expTotals = plResults.map((pl) => pl.totalExpenses);
    expTotals.push(expTotals.reduce((a, b) => a + b, 0));
    const netTotals = plResults.map((pl) => pl.netIncome);
    netTotals.push(netTotals.reduce((a, b) => a + b, 0));

    return {
      title: 'Profit and Loss (Comparative)', comparisonMode: compareMode,
      columns, rows,
      totalRevenue: revTotals, totalExpenses: expTotals, netIncome: netTotals,
    };
  }

  // Two-column comparison modes
  const currentPL = await reportService.buildProfitAndLoss(tenantId, startDate, endDate, basis);
  let priorRange: DateRange;

  if (compareMode === 'previous_year') {
    priorRange = getPriorYearRange(startDate, endDate);
  } else if (compareMode === 'ytd_vs_prior_ytd') {
    priorRange = getPriorYearRange(startDate, endDate);
  } else {
    priorRange = getPriorPeriodRange(startDate, endDate);
  }

  const priorPL = await reportService.buildProfitAndLoss(tenantId, priorRange.startDate, priorRange.endDate, basis);

  const columns = [
    { label: formatLabel(new Date(startDate), new Date(endDate)), startDate, endDate },
    { label: priorRange.label, startDate: priorRange.startDate, endDate: priorRange.endDate },
    { label: '$ Change', type: 'variance' },
    { label: '% Change', type: 'percent_variance' },
  ];

  // Build merged rows
  const allAccounts = new Map<string, { name: string; accountNumber: string | null; type: string }>();
  for (const r of [...currentPL.revenue, ...priorPL.revenue]) allAccounts.set(r.name, { name: r.name, accountNumber: r.accountNumber, type: 'revenue' });
  for (const e of [...currentPL.expenses, ...priorPL.expenses]) allAccounts.set(e.name, { name: e.name, accountNumber: e.accountNumber, type: 'expense' });

  const rows = [...allAccounts.values()].map((acct) => {
    const currentItems = acct.type === 'revenue' ? currentPL.revenue : currentPL.expenses;
    const priorItems = acct.type === 'revenue' ? priorPL.revenue : priorPL.expenses;
    const current = currentItems.find((i) => i.name === acct.name)?.amount || 0;
    const prior = priorItems.find((i) => i.name === acct.name)?.amount || 0;
    const v = computeVariance(current, prior);
    return { account: acct.name, accountNumber: acct.accountNumber, accountType: acct.type, values: [current, prior, v.dollarChange, v.percentChange] };
  });

  const revVar = computeVariance(currentPL.totalRevenue, priorPL.totalRevenue);
  const expVar = computeVariance(currentPL.totalExpenses, priorPL.totalExpenses);
  const netVar = computeVariance(currentPL.netIncome, priorPL.netIncome);

  return {
    title: 'Profit and Loss (Comparative)', comparisonMode: compareMode,
    columns, rows,
    totalRevenue: [currentPL.totalRevenue, priorPL.totalRevenue, revVar.dollarChange, revVar.percentChange],
    totalExpenses: [currentPL.totalExpenses, priorPL.totalExpenses, expVar.dollarChange, expVar.percentChange],
    netIncome: [currentPL.netIncome, priorPL.netIncome, netVar.dollarChange, netVar.percentChange],
  };
}

export async function buildComparativeBS(
  tenantId: string, asOfDate: string, basis: Basis, compareMode: CompareMode,
) {
  const currentBS = await reportService.buildBalanceSheet(tenantId, asOfDate, basis);
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

  const priorBS = await reportService.buildBalanceSheet(tenantId, priorDate, basis);

  const columns = [
    { label: asOfDate },
    { label: priorDate },
    { label: '$ Change', type: 'variance' },
    { label: '% Change', type: 'percent_variance' },
  ];

  function mergeSection(current: Array<{ name: string; accountNumber: string | null; balance: number }>, prior: Array<{ name: string; accountNumber: string | null; balance: number }>) {
    const names = new Set([...current.map((c) => c.name), ...prior.map((p) => p.name)]);
    return [...names].map((name) => {
      const cur = current.find((c) => c.name === name)?.balance || 0;
      const pri = prior.find((p) => p.name === name)?.balance || 0;
      const v = computeVariance(cur, pri);
      return { name, values: [cur, pri, v.dollarChange, v.percentChange] };
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
