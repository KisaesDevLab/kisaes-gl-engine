// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// CPA engagement-letter / report variables (SSARS 21).
//
// A "report letter" is an admin-authored HTML template (compilation report,
// preparation disclaimer, …) that references {{variables}}. This module is the
// SHARED source of truth for:
//   - the variable CATALOG (name → description → source → basis-dependence),
//     consumed by both the WYSIWYG editor's "Insert variable" menu and the
//     API resolver, and
//   - the pure, testable basis/title/date PHRASING helpers, so the seeded
//     default templates and the render-time resolver agree on wording.
//
// The resolver that turns a catalog into concrete values lives in the API
// (services/report-letter.service.ts) because it reads tenant/company rows;
// everything here is pure.

/**
 * Basis of accounting a letter can be rendered for. Report packs only ever
 * carry 'accrual' | 'cash' (see reportPackItemOptionsSchema / defaultBasis),
 * but the phrasing helpers accept the broader set so a letter previewed for a
 * special-purpose framework (tax / modified-cash) still resolves correctly.
 * 'accrual' and 'gaap' are treated identically (GAAP wording).
 */
export type LetterBasis = 'accrual' | 'gaap' | 'cash' | 'tax' | 'modified_cash';

/** Normalize any incoming basis string to a LetterBasis (default GAAP). */
export function normalizeLetterBasis(basis: string | null | undefined): LetterBasis {
  switch ((basis ?? '').toLowerCase()) {
    case 'cash':
      return 'cash';
    case 'tax':
    case 'tax_basis':
      return 'tax';
    case 'modified_cash':
    case 'modified-cash':
      return 'modified_cash';
    case 'gaap':
      return 'gaap';
    case 'accrual':
    default:
      return 'accrual';
  }
}

/**
 * Human phrase for the financial-reporting framework, dropped into sentences
 * like "…in accordance with {{basis_of_accounting}}." Wording per AR-C 80/70.
 */
export function basisOfAccountingPhrase(basis: string): string {
  switch (normalizeLetterBasis(basis)) {
    case 'cash':
      return 'the cash basis of accounting';
    case 'tax':
      return 'the tax basis of accounting';
    case 'modified_cash':
      return 'the modified cash basis of accounting';
    case 'gaap':
    case 'accrual':
    default:
      return 'accounting principles generally accepted in the United States of America';
  }
}

/**
 * Basis-aware list of the financial-statement titles, phrased to slot into
 * "…which comprise the {{financial_statement_titles}} as of …". GAAP uses the
 * conventional titles; special-purpose frameworks use the AICPA-illustrated
 * special-purpose-framework titles.
 */
export function financialStatementTitles(basis: string): string {
  switch (normalizeLetterBasis(basis)) {
    case 'cash':
    case 'modified_cash':
      return 'statement of assets and liabilities arising from cash transactions, and the related statement of revenues collected and expenses paid';
    case 'tax':
      return 'statement of assets, liabilities, and equity—tax basis, and the related statement of revenues and expenses—tax basis';
    case 'gaap':
    case 'accrual':
    default:
      return 'balance sheet, and the related statement of income, statement of changes in equity, and statement of cash flows';
  }
}

/** Parse a YYYY-MM-DD (local, no timezone shift) into a Date, or null. */
function parseIsoDate(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const date = new Date(y, mo - 1, d);
  return Number.isNaN(date.getTime()) ? null : date;
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** Format a YYYY-MM-DD as a long date, e.g. "December 31, 2025". */
export function formatLongDate(iso: string | null | undefined): string {
  const d = parseIsoDate(iso);
  if (!d) return '';
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

/**
 * Singular period phrasing for the reporting period, e.g.
 *   "year ended December 31, 2025"     (span ≈ a full year)
 *   "period ended December 31, 2025"   (any other span)
 * A range within one calendar/fiscal year of ~360-366 days reads as a year;
 * anything else is a "period" (SSARS-acceptable for stub/short periods).
 */
export function periodDescription(
  periodStart: string | null | undefined,
  periodEnd: string | null | undefined,
): string {
  const end = formatLongDate(periodEnd);
  if (!end) return '';
  const start = parseIsoDate(periodStart);
  const endDate = parseIsoDate(periodEnd);
  if (start && endDate) {
    const days = Math.round((endDate.getTime() - start.getTime()) / 86_400_000) + 1;
    if (days >= 360 && days <= 366) return `year ended ${end}`;
  }
  return `period ended ${end}`;
}

/** A single variable in the catalog. */
export interface LetterVariableDef {
  /** Token key — inserted as `{{key}}`. */
  key: string;
  /** Human label for the editor's insert menu. */
  label: string;
  /** Where the resolved value comes from (documentation / UI hint). */
  source: string;
  /** True when the resolved value changes with the report's basis. */
  basisDependent: boolean;
}

/**
 * The full variable catalog. Order = display order in the editor menu.
 * `source` documents resolution; `basisDependent` marks the framework-driven
 * ones. Keep in sync with resolveLetterVariables (API).
 */
export const LETTER_VARIABLES: LetterVariableDef[] = [
  { key: 'client_name', label: 'Client name', source: 'company.businessName', basisDependent: false },
  { key: 'firm_name', label: 'Firm name', source: 'reportSettings.firmName → company.businessName', basisDependent: false },
  { key: 'firm_city', label: 'Firm city', source: 'reportSettings.firmCity → company.city', basisDependent: false },
  { key: 'firm_state', label: 'Firm state', source: 'reportSettings.firmState → company.state', basisDependent: false },
  { key: 'firm_city_state', label: 'Firm city, state', source: 'firm_city + firm_state', basisDependent: false },
  { key: 'accountant_signature', label: 'Accountant signature', source: 'reportSettings.accountantSignature → reportSettings.reportFooter → firm_name', basisDependent: false },
  { key: 'period_start_date', label: 'Period start date', source: 'report pack range start (long date)', basisDependent: false },
  { key: 'period_end_date', label: 'Period end date', source: 'report pack range end (long date)', basisDependent: false },
  { key: 'as_of_date', label: 'As-of date', source: 'report pack as-of / range end (long date)', basisDependent: false },
  { key: 'period_description', label: 'Period description', source: 'derived "year ended…"/"period ended…"', basisDependent: false },
  { key: 'basis_of_accounting', label: 'Basis of accounting (phrase)', source: 'report pack basis', basisDependent: true },
  { key: 'financial_statement_titles', label: 'Financial statement titles', source: 'report pack basis', basisDependent: true },
  { key: 'letter_date', label: 'Letter date', source: 'report/signature date (long date)', basisDependent: false },
  { key: 'report_date', label: 'Report date', source: 'report/signature date (long date)', basisDependent: false },
  { key: 'report_title', label: 'Report title', source: 'letter type default title', basisDependent: false },
];

/** All catalog keys, for validation. */
export const LETTER_VARIABLE_KEYS = LETTER_VARIABLES.map((v) => v.key);

/** Minimal HTML-escape for interpolated variable VALUES. */
export function escapeLetterValue(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Substitute {{key}} tokens in a letter body with resolved values. Each value
 * is HTML-escaped before insertion (values like client_name land inside HTML).
 * Unknown tokens are left untouched. Whitespace inside the braces is tolerated
 * ({{ client_name }} works).
 */
export function renderLetterBody(
  bodyHtml: string,
  values: Record<string, string>,
): string {
  return bodyHtml.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (match, key: string) => {
    if (Object.prototype.hasOwnProperty.call(values, key)) {
      return escapeLetterValue(values[key] ?? '');
    }
    return match;
  });
}
