// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

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

export interface BSSectionLabels {
  assets: string;
  liabilities: string;
  equity: string;
  totalLiabilitiesAndEquity: string;
}

export const DEFAULT_BS_LABELS: BSSectionLabels = {
  assets: 'Assets',
  liabilities: 'Liabilities',
  equity: 'Equity',
  totalLiabilitiesAndEquity: 'Total Liabilities & Equity',
};

export interface CFSectionLabels {
  operatingActivities: string;
  investingActivities: string;
  financingActivities: string;
  netChange: string;
}

export const DEFAULT_CF_LABELS: CFSectionLabels = {
  operatingActivities: 'Operating Activities',
  investingActivities: 'Investing Activities',
  financingActivities: 'Financing Activities',
  netChange: 'Net Change in Cash',
};

// Maximum length the UI accepts (and the Zod schema enforces) for the
// optional footer text shown at the bottom of the 3 financial-statement
// reports. Mirrors a typical CPA disclaimer / "Prepared by …" footnote.
export const REPORT_FOOTER_MAX_LENGTH = 500;

export interface TenantReportSettings {
  plLabels?: Partial<PLSectionLabels>;
  bsLabels?: Partial<BSSectionLabels>;
  cfLabels?: Partial<CFSectionLabels>;
  /** Optional footer text shown at the bottom of P&L, Balance Sheet, and
   *  Cash Flow reports (on-screen, CSV, and PDF). Empty/absent = no footer. */
  reportFooter?: string;
  /** Optional CPA firm identity used by SSARS-21 engagement letters. When
   *  absent, the letter resolver falls back to the company's businessName /
   *  city / state. See @kis-books/shared letter-variables + report-letter
   *  service resolveLetterVariables. */
  firmName?: string;
  firmCity?: string;
  firmState?: string;
  /** Signature line for the letter's {{accountant_signature}} variable.
   *  Falls back to reportFooter, then firmName, when absent. */
  accountantSignature?: string;
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

export function resolveBSLabels(custom?: Partial<BSSectionLabels> | null): BSSectionLabels {
  const out = { ...DEFAULT_BS_LABELS };
  if (!custom) return out;
  for (const key of Object.keys(out) as (keyof BSSectionLabels)[]) {
    const value = custom[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      out[key] = value.trim();
    }
  }
  return out;
}

export function resolveCFLabels(custom?: Partial<CFSectionLabels> | null): CFSectionLabels {
  const out = { ...DEFAULT_CF_LABELS };
  if (!custom) return out;
  for (const key of Object.keys(out) as (keyof CFSectionLabels)[]) {
    const value = custom[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      out[key] = value.trim();
    }
  }
  return out;
}
