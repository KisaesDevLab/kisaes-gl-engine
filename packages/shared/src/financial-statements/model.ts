// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Engine input (FsSourceData — balances pulled from the TB workpaper) and
// output (FsRenderedReport — the one model every renderer consumes: HTML
// preview, PDF, DOCX, XLSX). Amounts in the source are SIGNED (+ = debit)
// numbers with ≤4 decimals, exactly as computeWorkpaper returns them.

import type { FsCashFlowClass, FsColumnMode, FsEntityKind, FsFramework, FsPageSetup, FsRule, FsStatementKind } from './schemas.js';

export type FsPeriodKey = 'cy' | 'py' | 'cyOpen' | 'pyOpen' | 'cyPriorMonth';

export interface FsSourceAccount {
  id: string;
  number: string | null;
  name: string;
  accountType: string; // asset | liability | equity | revenue | cogs | expense | other_revenue | other_expense
  detailType: string | null;
  systemTag: string | null;
  isVirtual: boolean; // VIRTUAL_RE_ID row (no system RE account)
}

export interface FsSourcePeriod {
  date: string;
  fyStart: string;
  // Signed balances by account id. BS accounts: cumulative through date.
  // P&L accounts: fiscal-year-to-date (the engine closes them into RE).
  balances: Record<string, number>;
  hasData: boolean;
}

export interface FsSourceGrouping {
  id: string;
  code: string | null;
  name: string;
  sortOrder: number;
  accountIds: string[];
}

export type FsEquityRole = 'retained' | 'distributions' | 'contributions' | 'other';

export interface FsSourceData {
  companyName: string;
  entityKind: FsEntityKind;
  framework: FsFramework;
  basis: 'accrual' | 'cash';
  glVersionStamp: number;
  periodEnd: string;
  fyStart: string;
  accounts: FsSourceAccount[];
  groupings: FsSourceGrouping[];
  periods: Partial<Record<FsPeriodKey, FsSourcePeriod>>;
  // Tag-filtered P&L balances (income statement only) when a tag is set.
  tagged?: Partial<Record<'cy' | 'py' | 'cyPriorMonth', FsSourcePeriod>> | null;
  tagName?: string | null;
  // Account that receives the year-end P&L close (system RE or virtual).
  reAccountId: string;
  equityRoles: Record<string, FsEquityRole>;
  cashFlowOverrides: Array<{ accountId: string | null; groupingId: string | null; classification: FsCashFlowClass }>;
  // Informational flags from the loader.
  taxHasPriorRje?: boolean;
}

// ─── Rendered model ────────────────────────────────────────────────

export type FsColumnKind = 'amount' | 'pct' | 'variance_amt' | 'variance_pct';

export interface FsColumnDef {
  key: string;
  label: string;       // e.g. "2025", "Month", "Year to Date", "% of Revenue"
  sublabel?: string;
  kind: FsColumnKind;
}

export type FsRowKind = 'heading' | 'detail' | 'subtotal' | 'total' | 'text' | 'blank' | 'page_break';
export type FsStyleRole = 'sectionHeading' | 'detail' | 'subtotal' | 'total' | 'text';

export type FsRowFormula =
  | { kind: 'sum'; rows: number[] }                               // row indexes in the same statement
  | { kind: 'terms'; terms: Array<{ row: number; sign: 1 | -1 }> };

export interface FsRow {
  key: string;
  nodeId?: string;
  kind: FsRowKind;
  caption: string;
  level: number;
  styleRole: FsStyleRole;
  bold?: boolean;
  italic?: boolean;
  caps?: boolean;
  sizeDelta?: number;
  // One entry per statement column. Amount columns are rounded display
  // values (dollars, or cents when decimals=2); pct columns are percents
  // (12.3 = 12.3%). null = blank cell.
  values: Array<number | null>;
  dollarSign: boolean;
  ruleAbove: 'none' | 'single';
  ruleBelow: FsRule;
  scheduleRef?: string; // "Schedule 1"
  plug?: Array<number>;   // rounding plug applied, per amount column
  formula?: FsRowFormula; // amount columns only (XLSX)
  breakBefore?: boolean;
}

export interface FsRenderedStatement {
  id: string;
  kind: FsStatementKind | 'schedule';
  title: string;
  dateLine: string;
  scheduleNo?: string;
  pageSetup: FsPageSetup;
  columns: FsColumnDef[];
  rows: FsRow[];
}

export type FsCheckSeverity = 'error' | 'warning' | 'info';

export interface FsCheck {
  code: string;
  severity: FsCheckSeverity;
  message: string;
  statementId?: string;
  nodeId?: string;
  accountIds?: string[];
  amount?: number;
}

export interface FsRenderedReport {
  meta: {
    companyName: string;
    periodEnd: string;
    fyStart: string;
    framework: FsFramework;
    basis: 'accrual' | 'cash';
    entityKind: FsEntityKind;
    columnMode: FsColumnMode;
    glVersionStamp: number;
    decimals: 0 | 2;
    tagName?: string | null;
  };
  statements: FsRenderedStatement[]; // face statements in layout order
  schedules: FsRenderedStatement[];  // supplementary schedules, numbered
  checks: FsCheck[];
}
