// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Built-in defaults: the starting layout (built on the seeded TB
// leadsheets A–O, see services/tb/groupings.service.ts DEFAULT_LEADSHEETS),
// the two built-in style presets, and the default cash-flow classification
// by leadsheet code. Everything here is PORTABLE (no client UUIDs) so it
// can double as a firm template.

import type {
  FsCashFlowClass, FsColumnsConfig, FsEntityKind, FsFrontMatter, FsLayout, FsNode, FsStatementConfig, FsStyle,
} from './schemas.js';
import { fsEquityNoun } from './titles.js';

const ls = (id: string, code: string, caption: string, display: 'single_line' | 'detail' | 'summary_with_schedule' = 'single_line', extra: Partial<Extract<FsNode, { type: 'leadsheet' }>> = {}): FsNode => ({
  type: 'leadsheet', id, ref: { leadsheetCode: code }, caption, display, ...extra,
});

function balanceSheet(entity: FsEntityKind): FsStatementConfig {
  const equityNoun = fsEquityNoun(entity);
  const equityLower = equityNoun.charAt(0) + equityNoun.slice(1).toLowerCase();
  return {
    id: 'bs', kind: 'balance_sheet', enabled: true,
    body: [
      {
        type: 'section', id: 'bs_assets', caption: 'ASSETS', showHeading: true, polarity: 'debit',
        showTotal: true, totalCaption: 'TOTAL ASSETS', role: 'total_assets', totalRuleBelow: 'double',
        children: [
          {
            type: 'section', id: 'bs_current_assets', caption: 'Current assets', showHeading: true, polarity: 'debit',
            showTotal: true, totalCaption: 'Total current assets', totalRuleAbove: 'single',
            children: [
              ls('bs_cash', 'A', 'Cash'),
              ls('bs_ar', 'B', 'Accounts receivable'),
              ls('bs_inventory', 'C', 'Inventory'),
            ],
          },
          { type: 'blank', id: 'bs_blank1' },
          {
            type: 'section', id: 'bs_ppe', caption: 'Property and equipment', showHeading: true, polarity: 'debit',
            showTotal: true, totalCaption: 'Property and equipment, net', totalRuleAbove: 'single',
            children: [ls('bs_fixed', 'D', 'Property and equipment', 'detail')],
          },
          { type: 'blank', id: 'bs_blank2' },
          ls('bs_other_assets', 'E', 'Other assets'),
        ],
      },
      { type: 'blank', id: 'bs_blank3' },
      {
        type: 'section', id: 'bs_le', caption: `LIABILITIES AND ${equityNoun.toUpperCase()}`, showHeading: true, polarity: 'credit',
        showTotal: true, totalCaption: `TOTAL LIABILITIES AND ${equityNoun.toUpperCase()}`, role: 'total_liabilities_equity', totalRuleBelow: 'double',
        children: [
          {
            type: 'section', id: 'bs_current_liab', caption: 'Current liabilities', showHeading: true, polarity: 'credit',
            showTotal: true, totalCaption: 'Total current liabilities', totalRuleAbove: 'single',
            children: [
              ls('bs_ap', 'F', 'Accounts payable'),
              ls('bs_accrued', 'G', 'Accrued liabilities'),
            ],
          },
          { type: 'blank', id: 'bs_blank4' },
          {
            type: 'section', id: 'bs_lt_liab', caption: 'Long-term liabilities', showHeading: true, polarity: 'credit',
            showTotal: true, totalCaption: 'Total long-term liabilities', totalRuleAbove: 'single',
            children: [
              ls('bs_debt', 'H', 'Notes payable'),
              ls('bs_other_liab', 'I', 'Other liabilities'),
            ],
          },
          { type: 'total', id: 'bs_total_liab', caption: 'Total liabilities', terms: [{ nodeId: 'bs_current_liab', sign: 1 }, { nodeId: 'bs_lt_liab', sign: 1 }], ruleAbove: 'single' },
          { type: 'blank', id: 'bs_blank5' },
          {
            type: 'section', id: 'bs_equity', caption: equityLower, showHeading: true, polarity: 'credit',
            showTotal: true, totalCaption: `Total ${equityLower.charAt(0).toLowerCase()}${equityLower.slice(1)}`, totalRuleAbove: 'single',
            children: [ls('bs_equity_ls', 'J', equityNoun, entity === 'corporation' ? 'detail' : 'single_line')],
          },
        ],
      },
    ],
  };
}

function incomeStatement(): FsStatementConfig {
  return {
    id: 'is', kind: 'income_statement', enabled: true,
    body: [
      ls('is_revenue', 'K', 'Revenue', 'single_line', { polarity: 'credit', revenueBase: true }),
      ls('is_cogs', 'L', 'Cost of goods sold', 'single_line', { polarity: 'debit', ruleBelow: 'single' }),
      { type: 'total', id: 'is_gross_profit', caption: 'Gross profit', terms: [{ nodeId: 'is_revenue', sign: 1 }, { nodeId: 'is_cogs', sign: -1 }] },
      { type: 'blank', id: 'is_blank1' },
      ls('is_opex', 'M', 'Operating expenses', 'summary_with_schedule', { polarity: 'debit', scheduleTitle: 'Schedule of Operating Expenses', ruleBelow: 'single' }),
      { type: 'total', id: 'is_operating_income', caption: 'Income from operations', terms: [{ nodeId: 'is_gross_profit', sign: 1 }, { nodeId: 'is_opex', sign: -1 }] },
      { type: 'blank', id: 'is_blank2' },
      {
        type: 'section', id: 'is_other', caption: 'Other income (expense)', showHeading: true, polarity: 'credit',
        showTotal: true, totalCaption: 'Total other income (expense)', totalRuleAbove: 'single', hideWhenZero: true,
        children: [
          ls('is_other_income', 'N', 'Other income'),
          ls('is_other_expense', 'O', 'Other expense'),
        ],
      },
      { type: 'blank', id: 'is_blank3' },
      {
        type: 'total', id: 'is_net_income', caption: 'NET INCOME', role: 'net_income', ruleAbove: 'single', ruleBelow: 'double',
        terms: [{ nodeId: 'is_operating_income', sign: 1 }, { nodeId: 'is_other', sign: 1 }],
      },
    ],
  };
}

export function buildDefaultLayout(entity: FsEntityKind): FsLayout {
  return {
    version: 1,
    statements: [
      balanceSheet(entity),
      incomeStatement(),
      { id: 'eq', kind: 'equity', enabled: true, body: [], equity: { columns: 'auto' } },
      { id: 'cf', kind: 'cash_flows', enabled: true, body: [], cashFlow: { detailByAccount: false } },
    ],
    schedules: { enabled: true, dividerTitle: 'Supplementary Information', numbering: 'numeric' },
  };
}

const el = (sizePt: number, bold = false, italic = false, extra: { caps?: boolean; align?: 'left' | 'center' | 'right' } = {}) => ({ sizePt, bold, italic, ...extra });

export const FS_BUILTIN_STYLES: ReadonlyArray<{ key: string; name: string; style: FsStyle }> = [
  {
    key: 'classic_serif',
    name: 'Classic Serif',
    style: {
      fontKey: 'liberation_serif', baseSizePt: 11, lineHeight: 1.25, indentPt: 12, amountColumnWidthIn: 1.2,
      number: { decimals: 0, dollarSigns: 'first_and_totals', negative: 'parens', zero: 'dash', hideZeroLines: true },
      elements: {
        companyName: el(13, true, false, { caps: true }),
        statementTitle: el(12, true),
        dateLine: el(11, false, false),
        columnHeader: el(10, true),
        sectionHeading: el(11, true),
        detail: el(11),
        subtotal: el(11),
        total: el(11, true),
        text: el(10, false, true),
        footer: el(9, false, true),
      },
      page: { paper: 'letter', orientation: 'portrait', margins: { top: 1, right: 1, bottom: 1, left: 1 } },
      titleBlock: { align: 'center' },
      footer: {
        text: "See Accountant's Compilation Report.",
        onStatements: true, onSchedules: true,
        pageNumber: { format: 'dash_n', position: 'bottom_center' },
      },
    },
  },
  {
    key: 'modern_sans',
    name: 'Modern Sans',
    style: {
      fontKey: 'carlito', baseSizePt: 10.5, lineHeight: 1.3, indentPt: 12, amountColumnWidthIn: 1.15,
      number: { decimals: 0, dollarSigns: 'first_and_totals', negative: 'parens', zero: 'dash', hideZeroLines: true },
      elements: {
        companyName: el(14, true),
        statementTitle: el(12, true),
        dateLine: el(10.5, false, true),
        columnHeader: el(10, true),
        sectionHeading: el(10.5, true, false, { caps: true }),
        detail: el(10.5),
        subtotal: el(10.5, true),
        total: el(10.5, true),
        text: el(9.5, false, true),
        footer: el(8.5),
      },
      page: { paper: 'letter', orientation: 'portrait', margins: { top: 0.9, right: 0.9, bottom: 0.9, left: 0.9 } },
      titleBlock: { align: 'left' },
      footer: {
        text: "See Accountant's Compilation Report.",
        onStatements: true, onSchedules: true,
        pageNumber: { format: 'page_n', position: 'bottom_right' },
      },
    },
  },
];

export const FS_DEFAULT_STYLE: FsStyle = FS_BUILTIN_STYLES[0]!.style;

export const FS_DEFAULT_COLUMNS: FsColumnsConfig = { mode: 'single', pctOfRevenue: false, varianceAmt: false, variancePct: false };

export const FS_DEFAULT_FRONT_MATTER: FsFrontMatter = {
  cover: { enabled: true, title: 'Financial Statements', showFirmName: true },
  toc: { enabled: true, title: 'Table of Contents' },
  letter: { enabled: true, letterId: null },
};

// Default cash-flow classification by leadsheet code (DEFAULT_LEADSHEETS).
export const FS_DEFAULT_CF_CLASS_BY_CODE: Readonly<Record<string, FsCashFlowClass>> = {
  A: 'cash',
  B: 'operating',
  C: 'operating',
  D: 'investing',
  E: 'operating',
  F: 'operating',
  G: 'operating',
  H: 'financing',
  I: 'operating',
  J: 'financing',
};

// Accumulated depreciation / amortization is a noncash add-back no matter
// which leadsheet it lives in.
export function fsIsAccumulatedDepreciation(name: string, detailType: string | null): boolean {
  const s = `${name} ${detailType ?? ''}`.toLowerCase();
  return /accum[a-z_ .]*(deprec|amort)/.test(s) || /accumulated_(depreciation|amortization)/.test(s);
}

export function fsDefaultCashFlowClass(
  account: { accountType: string; name: string; detailType: string | null },
  leadsheetCode: string | null,
): FsCashFlowClass {
  if (account.accountType === 'asset' && fsIsAccumulatedDepreciation(account.name, account.detailType)) return 'noncash_adjustment';
  if (leadsheetCode && FS_DEFAULT_CF_CLASS_BY_CODE[leadsheetCode]) return FS_DEFAULT_CF_CLASS_BY_CODE[leadsheetCode]!;
  const d = (account.detailType ?? '').toLowerCase();
  if (account.accountType === 'asset') {
    if (d === 'bank' || d === 'cash' || /cash|bank/.test(d)) return 'cash';
    if (/fixed|property|equipment|vehicle|building|land|furniture|machinery/.test(d)) return 'investing';
    return 'operating';
  }
  if (account.accountType === 'liability') {
    if (/loan|note|mortgage|line_of_credit|long_term/.test(d)) return 'financing';
    return 'operating';
  }
  if (account.accountType === 'equity') return 'financing';
  return 'excluded';
}
