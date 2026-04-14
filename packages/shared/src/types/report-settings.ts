export interface PLSectionLabels {
  revenue: string;
  cogs: string;
  grossProfit: string;
  expenses: string;
  operatingIncome: string;
  otherRevenue: string;
  otherExpenses: string;
  netIncome: string;
}

export const DEFAULT_PL_LABELS: PLSectionLabels = {
  revenue: 'Revenue',
  cogs: 'Cost of Goods Sold',
  grossProfit: 'Gross Profit',
  expenses: 'Expenses',
  operatingIncome: 'Operating Income',
  otherRevenue: 'Other Revenue',
  otherExpenses: 'Other Expenses',
  netIncome: 'Net Income',
};

export interface TenantReportSettings {
  plLabels?: Partial<PLSectionLabels>;
}

/**
 * Fill in any missing labels from defaults. Accepts a partial to support
 * tenants who have only customized a subset. Empty strings are treated
 * as "use default" so a cleared input in the settings UI reverts rather
 * than producing a blank heading in the report.
 */
export function resolvePLLabels(custom?: Partial<PLSectionLabels> | null): PLSectionLabels {
  const out = { ...DEFAULT_PL_LABELS };
  if (!custom) return out;
  for (const key of Object.keys(out) as (keyof PLSectionLabels)[]) {
    const value = custom[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      out[key] = value.trim();
    }
  }
  return out;
}
