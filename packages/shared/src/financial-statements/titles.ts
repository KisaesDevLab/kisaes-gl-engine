// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Statement titles + date lines per framework / entity kind, following the
// AICPA illustrations (special-purpose frameworks get the "— Income Tax
// Basis" / "— Cash Basis" titles). Pure; used by the engine, the letter
// variable resolver and the editor.

import type { FsColumnMode, FsEntityKind, FsFramework, FsStatementKind } from './schemas.js';

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const NUMBER_WORDS = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve'];

function parts(iso: string): { y: number; m: number; d: number } {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return { y, m, d };
}

export function fsLongDate(iso: string): string {
  const { y, m, d } = parts(iso);
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}

// Months from fyStart through periodEnd, inclusive (1–12).
export function fsMonthsInPeriod(fyStart: string, periodEnd: string): number {
  const a = parts(fyStart);
  const b = parts(periodEnd);
  return Math.max(1, Math.min(12, (b.y - a.y) * 12 + (b.m - a.m) + 1));
}

export function fsEquityNoun(entity: FsEntityKind): string {
  switch (entity) {
    case 'corporation': return "Stockholders' Equity";
    case 'partnership': return "Partners' Capital";
    case 'llc': return "Member's Equity";
    case 'sole_prop': return "Owner's Equity";
  }
}

function frameworkSuffix(framework: FsFramework): string {
  if (framework === 'tax') return ' — Income Tax Basis';
  if (framework === 'cash') return ' — Cash Basis';
  return '';
}

export interface FsTitleOptions {
  framework: FsFramework;
  entityKind: FsEntityKind;
  comparative: boolean; // two-year statements take plural titles
  // Corporation equity statement with a single column reads as a
  // retained-earnings statement.
  equityColumns?: 'single' | 'by_account';
}

export function fsStatementTitle(kind: FsStatementKind, o: FsTitleOptions): string {
  const pl = o.comparative;
  const stmt = pl ? 'Statements' : 'Statement';
  const suffix = frameworkSuffix(o.framework);
  switch (kind) {
    case 'balance_sheet':
      if (o.framework === 'gaap') return pl ? 'Balance Sheets' : 'Balance Sheet';
      return `${stmt} of Assets, Liabilities and ${o.entityKind === 'corporation' ? 'Equity' : fsEquityNoun(o.entityKind)}${suffix}`;
    case 'income_statement':
      if (o.framework === 'gaap') return `${stmt} of Income`;
      return `${stmt} of Revenues and Expenses${suffix}`;
    case 'equity':
      if (o.entityKind === 'corporation' && o.equityColumns === 'single') return `${stmt} of Retained Earnings${suffix}`;
      return `${stmt} of Changes in ${fsEquityNoun(o.entityKind)}${suffix}`;
    case 'cash_flows':
      return `${stmt} of Cash Flows${suffix}`;
  }
}

export interface FsDateLineOptions {
  fyStart: string;
  periodEnd: string;
  mode: FsColumnMode;
  priorPeriodEnd?: string | null; // comparative year-end
}

export function fsBalanceSheetDateLine(o: FsDateLineOptions): string {
  const cy = fsLongDate(o.periodEnd);
  if (o.mode === 'cy_py' && o.priorPeriodEnd) return `${cy} and ${parts(o.priorPeriodEnd).y}`;
  return cy;
}

export function fsFlowDateLine(o: FsDateLineOptions): string {
  const months = fsMonthsInPeriod(o.fyStart, o.periodEnd);
  const end = fsLongDate(o.periodEnd);
  const span = months === 12 ? 'Year' : `${NUMBER_WORDS[months]} Month${months === 1 ? '' : 's'}`;
  if (o.mode === 'cy_py' && o.priorPeriodEnd) {
    const plural = months === 12 ? 'Years' : `${NUMBER_WORDS[months]} Months`;
    return `For the ${plural} Ended ${end} and ${parts(o.priorPeriodEnd).y}`;
  }
  if (o.mode === 'month_ytd' && months > 1) return `For the One Month and ${span} Ended ${end}`;
  return `For the ${span} Ended ${end}`;
}

// Letter variable {{financial_statement_titles}}: lower-case titles of the
// statements ACTUALLY included, phrased for "…which comprise the ___ as of
// <date>…".
export function fsIncludedTitlesPhrase(kinds: FsStatementKind[], o: FsTitleOptions): string {
  const has = (k: FsStatementKind) => kinds.includes(k);
  const first = has('balance_sheet') ? fsStatementTitle('balance_sheet', o).toLowerCase() : null;
  const related = (['income_statement', 'equity', 'cash_flows'] as const).filter(has)
    .map((k) => fsStatementTitle(k, o).replace(/^Statements? of /, '').toLowerCase());
  const stmtWord = o.comparative || related.length > 1 ? 'statements' : 'statement';
  const list = related.length <= 2 ? related.join(' and ') : `${related.slice(0, -1).join(', ')}, and ${related[related.length - 1]}`;
  if (first && related.length) return `${first}, and the related ${stmtWord} of ${list}`;
  if (first) return first;
  if (related.length) return `${stmtWord} of ${list}`;
  return '';
}
