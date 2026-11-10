// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

// Exact reports (U-14, U-205, reports-exact-v1).
//
// `?exact=1` on a report route returns the same report with an additive
// `xExact` decimal string beside every money field `x`, Decimal totals,
// calendar dates as YYYY-MM-DD and a `meta` block. These handlers are
// registered on the reports router ahead of the legacy ones for the same
// paths; without exact=1 (or with format=csv|pdf) they pass straight
// through to the legacy handler, so default responses are unchanged.
//
// Errors with exact=1: 400 INVALID_PARAM (details.param) for a bad value,
// 400 INVALID_DATE_RANGE (details.param) when the start date is after the
// end date; 403 FORBIDDEN from the router's permission check.

import type { Request, Response, NextFunction, Router } from 'express';
import { z } from 'zod';
import { AppError } from '../utils/errors.js';
import { describe } from '../middleware/describe.js';
import * as reportService from '../services/report.service.js';
import * as apReportService from '../services/ap-report.service.js';
import * as comparisonService from '../services/report-comparison.service.js';
import { buildVendor1099SummaryByBox } from '../services/vendor-1099-summary.service.js';
import { exactRows, isIsoDate, normalizeReportDates, reportMeta } from '../services/report-exact.js';

export interface ExactRouteHelpers {
  resolveCompanyScope(req: Request): string | null;
  readTagFilter(req: Request): string | null;
  readAdjusting(req: Request): reportService.AdjustingFilter;
  readAccountIds(req: Request): string[] | null;
  readGroupBy(req: Request): 'detail_type' | 'leadsheet' | null;
  reportSchemaVersion: string;
}

const today = () => new Date().toISOString().split('T')[0]!;
const yearStart = () => `${new Date().getFullYear()}-01-01`;

function bad(param: string, message: string): AppError {
  return AppError.badRequest(message, 'INVALID_PARAM', { param });
}

/** exact=1|true -> true; absent, empty, 0 or false -> false; anything else is 400. */
export function readExact(req: Request): boolean {
  const v = req.query['exact'];
  if (v === undefined || v === '' || v === '0' || v === 'false') return false;
  if (v === '1' || v === 'true') return true;
  throw bad('exact', 'exact must be 1 or 0');
}

function qs(req: Request, name: string): string | undefined {
  const v = req.query[name];
  if (v === undefined || v === '') return undefined;
  if (typeof v !== 'string') throw bad(name, `${name} must be given once`);
  return v;
}

function date(req: Request, name: string): string | undefined {
  const v = qs(req, name);
  if (v !== undefined && !isIsoDate(v)) throw bad(name, `${name} must be a date (YYYY-MM-DD)`);
  return v;
}

function range(req: Request, startName = 'start_date', endName = 'end_date', defaults = true): { from: string; to: string } {
  const from = date(req, startName) ?? (defaults ? yearStart() : '');
  const to = date(req, endName) ?? (defaults ? today() : '');
  if (from && to && from > to) {
    throw AppError.badRequest(`${startName} is after ${endName}`, 'INVALID_DATE_RANGE', { param: endName });
  }
  return { from, to };
}

function basis(req: Request): 'accrual' | 'cash' {
  const v = qs(req, 'basis');
  if (v === undefined || v === 'accrual') return 'accrual';
  if (v === 'cash') return 'cash';
  throw bad('basis', 'basis must be accrual or cash');
}

function oneOf<T extends string>(req: Request, name: string, allowed: readonly T[]): T | undefined {
  const v = qs(req, name);
  if (v === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(v)) throw bad(name, `${name} must be one of ${allowed.join(', ')}`);
  return v as T;
}

function posInt(req: Request, name: string, max: number): number | undefined {
  const v = qs(req, name);
  if (v === undefined) return undefined;
  if (!/^\d+$/.test(v) || Number(v) < 1 || Number(v) > max) throw bad(name, `${name} must be a whole number from 1 to ${max}`);
  return Number(v);
}

function uuid(req: Request, name: string, required: boolean): string | undefined {
  const v = qs(req, name);
  if (v === undefined) {
    if (required) throw bad(name, `${name} is required`);
    return undefined;
  }
  if (!z.string().uuid().safeParse(v).success) throw bad(name, `${name} must be an id`);
  return v;
}

/** The exact handler wrapper: pass through unless exact=1 without an export format. */
type ExactHandler = (req: Request, res: Response) => Promise<unknown>;
function exactOnly(handler: ExactHandler) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const exact = readExact(req);
    if (!exact || req.query['format'] !== undefined && req.query['format'] !== '') { next(); return; }
    const body = await handler(req, res);
    res.json(normalizeReportDates(body));
  };
}

/** A list report: `xExact` on every row for each money field plus `totalsExact`. */
function exactList<T extends { data: unknown[] }>(data: T, fields: readonly string[], extra?: (row: Record<string, unknown>) => Record<string, unknown>) {
  const { rows, totals } = exactRows(data.data as Array<Record<string, unknown>>, fields);
  return { ...data, data: extra ? rows.map((r) => ({ ...r, ...extra(r) })) : rows, totalsExact: totals };
}

const EXACT_Q = {
  exact: z.enum(['1', '0', 'true', 'false']).optional()
    .describe('1 = exact report (reports-exact-v1): *Exact decimal strings, Decimal totals, YYYY-MM-DD dates and meta. Ignored with format=csv|pdf.'),
};
const RANGE_Q = {
  start_date: z.string().optional().describe('YYYY-MM-DD; default January 1 of this year'),
  end_date: z.string().optional().describe('YYYY-MM-DD; default today'),
};
const COMMON_Q = {
  tag_id: z.string().optional().describe('Comma-separated tag ids'),
  scope: z.enum(['consolidated']).optional(),
  format: z.enum(['csv', 'pdf']).optional(),
};
const BASIS_Q = { basis: z.enum(['accrual', 'cash']).optional() };
const ADJ_Q = { adjusting: z.enum(['include', 'exclude', 'only']).optional() };
const META_DOC = 'meta {exact: true, basis, cashBasisRules (plain-language Q-P23z note on cash basis, else null), from, to | asOf, reportSchemaVersion}. '
  + 'Every *Exact is the unrounded decimal string (at least 4 places), same sign as its number field; totals are Decimal sums of the rows. '
  + 'Account rows on P&L, Balance Sheet and Trial Balance carry parentAccountId, depth and (parents) rollupExact; zero-amount ancestors are added so the tree is complete.';

function doc(summary: string, description: string, query: Record<string, z.ZodTypeAny>) {
  return describe({
    summary,
    description: `${description} ${META_DOC}`,
    query: z.object({ ...EXACT_Q, ...COMMON_Q, ...query }),
  });
}

export function registerExactReportRoutes(router: Router, h: ExactRouteHelpers): void {
  const meta = (req: Request, o: { basis?: 'accrual' | 'cash' | null; from?: string; to?: string; asOf?: string }) =>
    reportMeta({ basis: o.basis ?? null, from: o.from, to: o.to, asOf: o.asOf, reportSchemaVersion: h.reportSchemaVersion });

  // ── Financial statements ──
  router.get('/profit-loss', doc('Profit and Loss',
    'Standard: revenue/cogs/expenses/otherRevenue/otherExpenses[] {accountId, amount, amountExact, parentAccountId, depth, rollupExact?}, '
    + 'total*Exact, grossProfitExact, operatingIncomeExact, netIncomeExact; group_by adds groups[].subtotalExact. compare=previous_period|'
    + 'previous_year|ytd_vs_prior_ytd|multi_period|by_tag: rows[].valuesExact and groups[].valuesExact (amounts; $ change; % change at 1 place, '
    + 'null on a zero base), total*Exact / netIncomeExact arrays.',
    { ...RANGE_Q, ...BASIS_Q, ...ADJ_Q, compare: z.string().optional(), periods: z.string().optional(), period_type: z.string().optional(),
      group_by: z.enum(['detail_type', 'leadsheet']).optional() }),
  exactOnly(async (req) => {
    const { from, to } = range(req);
    const b = basis(req);
    const compare = oneOf(req, 'compare', ['previous_period', 'previous_year', 'ytd_vs_prior_ytd', 'multi_period', 'by_tag'] as const);
    const periods = posInt(req, 'periods', 60);
    const periodType = oneOf(req, 'period_type', ['month', 'quarter', 'year'] as const) ?? 'month';
    const companyId = h.resolveCompanyScope(req);
    const tagId = h.readTagFilter(req);
    const adjusting = h.readAdjusting(req);
    const groupBy = h.readGroupBy(req);
    const m = meta(req, { basis: b, from, to });
    if (compare === 'by_tag' && tagId) {
      const data = await comparisonService.buildPLByTag(req.tenantId, from, to, b, tagId, companyId, groupBy, { adjusting, exact: true });
      if (data) return { ...data, meta: m };
    }
    if (compare && compare !== 'by_tag') {
      const data = await comparisonService.buildComparativePL(req.tenantId, from, to, b, compare, periods ?? null, periodType, companyId, groupBy, { adjusting, exact: true });
      return { ...data, meta: m };
    }
    const data = await reportService.buildProfitAndLoss(req.tenantId, from, to, b, companyId, tagId, groupBy, { adjusting, exactAmounts: true, accountTree: true });
    return { ...data, meta: m };
  }));

  router.get('/balance-sheet', doc('Balance Sheet',
    'assets/liabilities/equity[] {accountId, balance, balanceExact, parentAccountId, depth, rollupExact?} in natural sign (liabilities and '
    + 'equity credit-positive), total*Exact; compare=previous_period|previous_year: rows[].valuesExact, total*Exact arrays.',
    { as_of_date: z.string().optional(), ...BASIS_Q, ...ADJ_Q, compare: z.string().optional(), group_by: z.enum(['detail_type', 'leadsheet']).optional() }),
  exactOnly(async (req) => {
    const asOf = date(req, 'as_of_date') ?? today();
    const b = basis(req);
    const compare = oneOf(req, 'compare', ['previous_period', 'previous_year'] as const);
    const companyId = h.resolveCompanyScope(req);
    const adjusting = h.readAdjusting(req);
    const groupBy = h.readGroupBy(req);
    const m = meta(req, { basis: b, asOf });
    if (compare) {
      const data = await comparisonService.buildComparativeBS(req.tenantId, asOf, b, compare, companyId, groupBy, { adjusting, exact: true });
      return { ...data, meta: m };
    }
    const data = await reportService.buildBalanceSheet(req.tenantId, asOf, b, companyId, h.readTagFilter(req), groupBy, { adjusting, exactAmounts: true, accountTree: true });
    return { ...data, meta: m };
  }));

  router.get('/trial-balance', doc('Trial Balance',
    'data[] {accountId, debit, credit, debitExact, creditExact, netExact (debit - credit), total_debitExact, total_creditExact, parentAccountId, '
    + 'depth, rollupExact?}, totalDebitsExact, totalCreditsExact.',
    { ...RANGE_Q, as_of_date: z.string().optional(), ...BASIS_Q, ...ADJ_Q }),
  exactOnly(async (req) => {
    const asOf = date(req, 'as_of_date');
    const from = date(req, 'start_date') ?? yearStart();
    const to = date(req, 'end_date') ?? asOf ?? today();
    if (from > to) throw AppError.badRequest('start_date is after end_date', 'INVALID_DATE_RANGE', { param: 'end_date' });
    const b = basis(req);
    const data = await reportService.buildTrialBalance(req.tenantId, from, to, h.resolveCompanyScope(req), h.readTagFilter(req), b,
      { adjusting: h.readAdjusting(req), exactAmounts: true, accountTree: true });
    return { ...data, meta: meta(req, { basis: b, from, to }) };
  }));

  router.get('/general-ledger', doc('General Ledger',
    'accounts[] {accountId, beginningBalanceExact, periodDebitsExact, periodCreditsExact, endingBalanceExact, lines[] {lineId, transactionId, '
    + 'debitExact, creditExact, runningBalanceExact}}, totalDebitsExact, totalCreditsExact, rowCount (all lines), truncated. limit returns at most '
    + 'that many lines in report order; balances and totals still cover every line. Cash-basis lineIds are row numbers, not journal line ids.',
    { ...RANGE_Q, ...BASIS_Q, ...ADJ_Q, account_ids: z.string().optional(), limit: z.string().optional().describe('1-100000') }),
  exactOnly(async (req) => {
    const { from, to } = range(req);
    const b = basis(req);
    const limit = posInt(req, 'limit', 100000);
    const data = await reportService.buildGeneralLedger(req.tenantId, from, to, h.resolveCompanyScope(req), h.readTagFilter(req), b,
      h.readAccountIds(req), { adjusting: h.readAdjusting(req), exactAmounts: true, limit: limit ?? null });
    return { ...data, meta: meta(req, { basis: b, from, to }) };
  }));

  router.get('/account-activity-summary', doc('Account Activity Summary',
    'data[] {total_debitExact, total_creditExact, netExact}, totalDebitsExact, totalCreditsExact, totalNetExact.', { ...RANGE_Q }),
  exactOnly(async (req) => {
    const { from, to } = range(req);
    const data = await reportService.buildAccountActivitySummary(req.tenantId, from, to, h.resolveCompanyScope(req), h.readTagFilter(req));
    return { ...data, meta: meta(req, { basis: 'accrual', from, to }) };
  }));

  // ── Lists ──
  router.get('/transaction-list', doc('Transaction List',
    'One row per journal line: data[] {id (transaction), lineId (journal line; null on cash basis), debitExact, creditExact, amountExact '
    + '(debit - credit)}, totalsExact {debit, credit, amount}.',
    { ...RANGE_Q, ...BASIS_Q, ...ADJ_Q, txn_type: z.string().optional(), account_id: z.string().optional() }),
  exactOnly(async (req) => {
    const { from, to } = range(req, 'start_date', 'end_date', false);
    const b = basis(req);
    const accountId = uuid(req, 'account_id', false);
    const tagId = h.readTagFilter(req);
    const data = await reportService.buildTransactionList(req.tenantId, {
      startDate: from || undefined, endDate: to || undefined, txnType: qs(req, 'txn_type'), accountId, ...(tagId ? { tagId } : {}),
      basis: b, adjusting: h.readAdjusting(req),
    }, h.resolveCompanyScope(req));
    return { ...exactList(data as { data: unknown[] }, ['debit', 'credit', 'amount'], (r) => ({ lineId: r['line_id'] ?? null })), meta: meta(req, { basis: b, from: from || undefined, to: to || undefined }) };
  }));

  router.get('/journal-entry-report', doc('Journal',
    'Journal entries, one row per line: data[] {id, lineId, debitExact, creditExact, amountExact}, totalsExact.', { ...RANGE_Q, ...ADJ_Q }),
  exactOnly(async (req) => {
    const { from, to } = range(req, 'start_date', 'end_date', false);
    const data = await reportService.buildJournalEntryReport(req.tenantId, { startDate: from || undefined, endDate: to || undefined },
      h.resolveCompanyScope(req), h.readTagFilter(req), h.readAdjusting(req));
    return { ...exactList(data as { data: unknown[] }, ['debit', 'credit', 'amount'], (r) => ({ lineId: r['line_id'] ?? null })), title: 'Journal Entry Report',
      meta: meta(req, { basis: 'accrual', from: from || undefined, to: to || undefined }) };
  }));

  router.get('/invoice-list', doc('Invoice List', 'data[] {totalExact, amount_paidExact, balance_dueExact}, totalsExact.',
    { ...RANGE_Q, status: z.string().optional() }),
  exactOnly(async (req) => {
    const { from, to } = range(req, 'start_date', 'end_date', false);
    const tagId = h.readTagFilter(req);
    const data = await reportService.buildInvoiceList(req.tenantId, { startDate: from || undefined, endDate: to || undefined, status: qs(req, 'status'), ...(tagId ? { tagId } : {}) }, h.resolveCompanyScope(req));
    return { ...exactList(data as { data: unknown[] }, ['total', 'amount_paid', 'balance_due']), meta: meta(req, { basis: null, from: from || undefined, to: to || undefined }) };
  }));

  router.get('/customer-balance-summary', doc('Customer Balance Summary', 'data[] {balanceExact}, totalsExact {balance}.', {}),
  exactOnly(async (req) => {
    const data = await reportService.buildCustomerBalanceSummary(req.tenantId, h.resolveCompanyScope(req), h.readTagFilter(req));
    return { ...exactList(data, ['balance']), meta: meta(req, { basis: null }) };
  }));
  router.get('/customer-balance-detail', doc('Customer Balance Detail', 'data[] {balanceExact}, totalsExact {balance}.', {}),
  exactOnly(async (req) => {
    const data = await reportService.buildCustomerBalanceDetail(req.tenantId, h.resolveCompanyScope(req), h.readTagFilter(req));
    return { ...exactList(data, ['balance']), meta: meta(req, { basis: null }) };
  }));
  router.get('/vendor-balance-summary', doc('Vendor Balance Summary', 'data[] {total_spentExact}, totalsExact {total_spent}.', {}),
  exactOnly(async (req) => {
    const data = await reportService.buildVendorBalanceSummary(req.tenantId, h.resolveCompanyScope(req));
    return { ...exactList(data, ['total_spent']), meta: meta(req, { basis: null }) };
  }));

  // ── A/P ──
  for (const path of ['/ap-aging-summary', '/ap-aging-detail'] as const) {
    router.get(path, doc(path === '/ap-aging-summary' ? 'A/P Aging Summary' : 'A/P Aging Detail',
      'vendors[] {currentExact, bucket1to30Exact, bucket31to60Exact, bucket61to90Exact, bucketOver90Exact, totalExact}, totalsExact (same keys), '
      + 'details[] {bill_id, totalExact, paidExact, balanceExact}.', { as_of_date: z.string().optional() }),
    exactOnly(async (req) => {
      const asOf = date(req, 'as_of_date') ?? today();
      const data = await apReportService.buildApAgingSummary(req.tenantId, asOf, h.resolveCompanyScope(req), h.readTagFilter(req));
      return { ...data, meta: meta(req, { basis: null, asOf }) };
    }));
  }
  router.get('/unpaid-bills', doc('Unpaid Bills', 'data[] {totalExact, amount_paidExact, credits_appliedExact, balance_dueExact}, totalsExact.',
    { contact_id: z.string().optional(), due_on_or_before: z.string().optional(), overdue_only: z.string().optional() }),
  exactOnly(async (req) => {
    const data = await apReportService.buildUnpaidBills(req.tenantId, {
      contactId: uuid(req, 'contact_id', false), dueOnOrBefore: date(req, 'due_on_or_before'), overdueOnly: req.query['overdue_only'] === 'true',
    }, h.resolveCompanyScope(req));
    return { ...exactList(data, ['total', 'amount_paid', 'credits_applied', 'balance_due']), meta: meta(req, { basis: null }) };
  }));
  router.get('/bill-payment-history', doc('Bill Payment History', 'data[] {totalExact}, totalsExact {total}.', { ...RANGE_Q }),
  exactOnly(async (req) => {
    const { from, to } = range(req, 'start_date', 'end_date', false);
    const data = await apReportService.buildBillPaymentHistory(req.tenantId, { startDate: from || undefined, endDate: to || undefined }, h.resolveCompanyScope(req));
    return { ...exactList(data, ['total']), meta: meta(req, { basis: null, from: from || undefined, to: to || undefined }) };
  }));
  router.get('/vendor-statement', doc('Vendor Statement',
    'openingBalanceExact, closingBalanceExact, totalChargesExact, totalPaymentsExact, lines[] {id, chargeExact, paymentExact, balanceExact}.',
    { vendor_id: z.string().uuid(), ...RANGE_Q }),
  exactOnly(async (req) => {
    const vendorId = uuid(req, 'vendor_id', true)!;
    const { from, to } = range(req);
    const data = await apReportService.buildVendorStatement(req.tenantId, vendorId, { startDate: from, endDate: to }, h.resolveCompanyScope(req));
    return { ...data, meta: meta(req, { basis: null, from, to }) };
  }));
  router.get('/transaction-list-by-vendor', doc('Transactions by Vendor', 'data[] {totalExact}, totalsExact {total}.',
    { vendor_id: z.string().uuid(), ...RANGE_Q }),
  exactOnly(async (req) => {
    const vendorId = uuid(req, 'vendor_id', true)!;
    const { from, to } = range(req, 'start_date', 'end_date', false);
    const data = await reportService.buildTransactionListByVendor(req.tenantId, vendorId, { startDate: from || undefined, endDate: to || undefined }, h.resolveCompanyScope(req));
    return { ...exactList(data, ['total']), meta: meta(req, { basis: null, from: from || undefined, to: to || undefined }) };
  }));
  router.get('/ap-1099-prep', doc('1099 Preparation', 'data[] {total_paidExact}, totalPaidExact.', { tax_year: z.string().optional() }),
  exactOnly(async (req) => {
    const year = posInt(req, 'tax_year', 9999) ?? new Date().getFullYear();
    const data = await apReportService.buildAp1099Prep(req.tenantId, year, h.resolveCompanyScope(req));
    return { ...data, meta: meta(req, { basis: 'cash', from: `${year}-01-01`, to: `${year}-12-31` }) };
  }));
  router.get('/vendor-1099-summary', doc('1099 Summary by box (U-205)',
    'Without exact: the legacy {title, year, data[] {id, display_name, tax_id, total_paid}}. With exact=1: {title, year, boxCatalog[] {box, form, '
    + 'boxNumber, label, thresholdExact}, rows[] {contactId, name, tinLast4, is1099Eligible, boxes {box code: exact amount}, totalExact, '
    + 'meetsThreshold}, totalsExact {box code..., total}} from the 1099 account-to-box mapping (the 1099 Center source), for the company.',
    { year: z.string().optional() }),
  exactOnly(async (req) => {
    const year = posInt(req, 'year', 9999) ?? new Date().getFullYear();
    if (year < 1900) throw bad('year', 'year must be a four-digit year');
    const data = await buildVendor1099SummaryByBox(req.tenantId, year, h.resolveCompanyScope(req));
    return { ...data, meta: meta(req, { basis: 'cash', from: `${year}-01-01`, to: `${year}-12-31` }) };
  }));

  // ── Sales and spending ──
  for (const [path, title, build] of [
    ['/sales-by-customer', 'Sales by Client', reportService.buildSalesByCustomer],
    ['/sales-by-item', 'Sales by Item', reportService.buildSalesByItem],
  ] as const) {
    router.get(path, doc(title, 'data[] {totalExact}, totalsExact {total}.', { ...RANGE_Q, ...BASIS_Q }),
    exactOnly(async (req) => {
      const { from, to } = range(req);
      const b = basis(req);
      const data = await build(req.tenantId, from, to, h.resolveCompanyScope(req), h.readTagFilter(req), b);
      return { ...exactList(data as { data: unknown[] }, ['total']), meta: meta(req, { basis: b, from, to }) };
    }));
  }
  router.get('/expense-by-vendor', doc('Expenses by Vendor',
    'data[] {totalExact}, totalsExact {total}; display=detail adds groups[] {totalExact, accounts[] {totalExact}}.',
    { ...RANGE_Q, ...BASIS_Q, display: z.enum(['detail']).optional() }),
  exactOnly(async (req) => {
    const { from, to } = range(req);
    const b = basis(req);
    const data = await reportService.buildExpenseByVendor(req.tenantId, from, to, h.resolveCompanyScope(req), h.readTagFilter(req), req.query['display'] === 'detail', b);
    return { ...exactList(data as { data: unknown[] }, ['total']), meta: meta(req, { basis: b, from, to }) };
  }));
  router.get('/expense-by-category', doc('Expenses by Category',
    'data[] {totalExact}, totalsExact {total}; display=detail adds groups[] {totalDebitsExact, totalCreditsExact, subtotalExact, lines[] '
    + '{lineId, debitExact, creditExact, balanceExact}} and grandTotalExact.',
    { ...RANGE_Q, ...BASIS_Q, account_ids: z.string().optional(), display: z.enum(['detail']).optional() }),
  exactOnly(async (req) => {
    const { from, to } = range(req);
    const b = basis(req);
    const data = await reportService.buildExpenseByCategory(req.tenantId, from, to, h.resolveCompanyScope(req), h.readTagFilter(req),
      h.readAccountIds(req), req.query['display'] === 'detail', b, { exactAmounts: true });
    return { ...exactList(data as { data: unknown[] }, ['total']), meta: meta(req, { basis: b, from, to }) };
  }));
  router.get('/revenue-by-category', doc('Revenue by Category',
    'data[] {totalExact}, totalsExact {total}; display=detail adds groups[] {totalDebitsExact, totalCreditsExact, subtotalExact, lines[] '
    + '{lineId, debitExact, creditExact, balanceExact}} and grandTotalExact.',
    { ...RANGE_Q, ...BASIS_Q, account_ids: z.string().optional(), display: z.enum(['detail']).optional() }),
  exactOnly(async (req) => {
    const { from, to } = range(req);
    const b = basis(req);
    const data = await reportService.buildAccountDetailReport(req.tenantId, from, to, {
      title: 'Revenues by Category', accountTypes: ['revenue', 'other_revenue'], normalSide: 'credit',
      companyId: h.resolveCompanyScope(req), tagId: h.readTagFilter(req), accountIds: h.readAccountIds(req),
      detail: req.query['display'] === 'detail', carryForward: false, basis: b, exactAmounts: true,
    });
    return { ...exactList(data as { data: unknown[] }, ['total']), meta: meta(req, { basis: b, from, to }) };
  }));

  // ── Banking ──
  router.get('/deposit-detail', doc('Deposit Detail', 'data[] {totalExact}, totalsExact {total}.', { ...RANGE_Q }),
  exactOnly(async (req) => {
    const { from, to } = range(req, 'start_date', 'end_date', false);
    const data = await reportService.buildDepositDetail(req.tenantId, { startDate: from || undefined, endDate: to || undefined }, h.resolveCompanyScope(req));
    return { ...exactList(data as { data: unknown[] }, ['total']), meta: meta(req, { basis: null, from: from || undefined, to: to || undefined }) };
  }));
  router.get('/check-register', doc('Check Register', 'data[] {debitExact, creditExact}, totalsExact {debit, credit}.',
    { account_id: z.string().uuid(), ...RANGE_Q }),
  exactOnly(async (req) => {
    const accountId = uuid(req, 'account_id', true)!;
    const { from, to } = range(req, 'start_date', 'end_date', false);
    const data = await reportService.buildCheckRegister(req.tenantId, accountId, { startDate: from || undefined, endDate: to || undefined }, h.resolveCompanyScope(req), h.readTagFilter(req));
    return { ...exactList(data as { data: unknown[] }, ['debit', 'credit']), meta: meta(req, { basis: null, from: from || undefined, to: to || undefined }) };
  }));
  router.get('/bank-balances', doc('Bank Account Balances', 'accounts[] {balanceExact}, totalBalanceExact.', { as_of_date: z.string().optional() }),
  exactOnly(async (req) => {
    const asOf = date(req, 'as_of_date') ?? today();
    const data = await reportService.buildBankBalances(req.tenantId, asOf, h.resolveCompanyScope(req));
    return { ...data, meta: meta(req, { basis: 'accrual', asOf }) };
  }));
}
