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
import { exactRows, exactStr, dsum, isIsoDate, normalizeReportDates, reportMeta, ReportDecimal } from '../services/report-exact.js';
import { loadGroupTags, type ContactLens, type LineLens, type TagLens } from '../services/report-lens.js';
import {
  MAX_PERIOD_RANGES, ReportColumnsError, applyTrialBalanceTagSplit, buildBalanceSheetColumns, buildProfitAndLossColumns,
  fiscalYearStartOf, type DateRange,
} from '../services/report-columns.service.js';

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

// ─── U-201 / U-202 strict readers (reports-columns-v1, reports-drill-v1) ──
// Unlike the legacy readers (which drop a malformed id and so widen the
// report), these answer 400 INVALID_PARAM: a drill that silently loses a
// filter would not tie out to its cell.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MAX_DRILL_IDS = 500;

function flag(req: Request, name: string): boolean {
  const v = qs(req, name);
  if (v === undefined || v === '0' || v === 'false') return false;
  if (v === '1' || v === 'true') return true;
  throw bad(name, `${name} must be 1 or 0`);
}

function strictIds(req: Request, name: string, max = MAX_DRILL_IDS): string[] | null {
  const v = qs(req, name);
  if (v === undefined) return null;
  const ids = v.split(',').map((s) => s.trim()).filter((s) => s !== '');
  if (ids.length === 0) return null;
  if (ids.some((id) => !UUID_RE.test(id))) throw bad(name, `${name} must be comma-separated ids`);
  if (ids.length > max) throw bad(name, `${name} takes at most ${max} ids`);
  return [...new Set(ids.map((s) => s.toLowerCase()))];
}

function decimalParam(req: Request, name: string): string | null {
  const v = qs(req, name);
  if (v === undefined) return null;
  if (!/^\d{1,15}(\.\d{1,4})?$/.test(v)) throw bad(name, `${name} must be a non-negative amount like 1234.56`);
  return v;
}

/** tag_id (ids | untagged) and tag_scope=untagged_in_group&tag_group_id=. */
function readTagLens(req: Request, opts: { allowUntagged: boolean; allowScope: boolean }): TagLens | null {
  const raw = qs(req, 'tag_id') ?? qs(req, 'tagId');
  const scope = oneOf(req, 'tag_scope', ['untagged_in_group'] as const);
  if (scope) {
    if (!opts.allowScope) throw bad('tag_scope', 'tag_scope is not available on this report');
    if (raw !== undefined) throw bad('tag_scope', 'use tag_id or tag_scope, not both');
    const groupId = uuid(req, 'tag_group_id', true)!;
    return { kind: 'untagged_in_group', groupId };
  }
  if (raw === undefined) return null;
  if (raw === 'untagged') {
    if (!opts.allowUntagged) throw bad('tag_id', 'tag_id=untagged is not available on this report');
    return { kind: 'untagged' };
  }
  const ids = strictIds(req, req.query['tag_id'] !== undefined ? 'tag_id' : 'tagId');
  return ids ? { kind: 'ids', ids } : null;
}

/** contact_id (ids | none | others with exclude_contact_ids). */
function readContactLens(req: Request): ContactLens | null {
  const raw = qs(req, 'contact_id');
  const exclude = strictIds(req, 'exclude_contact_ids', 100);
  if (raw === undefined) {
    if (exclude) throw bad('exclude_contact_ids', 'exclude_contact_ids needs contact_id=others');
    return null;
  }
  if (raw === 'none') { if (exclude) throw bad('exclude_contact_ids', 'exclude_contact_ids needs contact_id=others'); return { kind: 'none' }; }
  if (raw === 'others') return { kind: 'others', exclude: exclude ?? [] };
  if (exclude) throw bad('exclude_contact_ids', 'exclude_contact_ids needs contact_id=others');
  const ids = strictIds(req, 'contact_id');
  return ids ? { kind: 'ids', ids } : null;
}

/** The U-202 drill lens: client, tag, amount range, cleared state, transaction types. */
function readLineLens(req: Request): LineLens {
  const amountMin = decimalParam(req, 'amount_min');
  const amountMax = decimalParam(req, 'amount_max');
  if (amountMin && amountMax && new ReportDecimal(amountMin).gt(amountMax)) {
    throw AppError.badRequest('amount_min is more than amount_max', 'INVALID_PARAM', { param: 'amount_max' });
  }
  const types = qs(req, 'txn_types');
  let txnTypes: string[] | null = null;
  if (types !== undefined) {
    txnTypes = types.split(',').map((s) => s.trim()).filter(Boolean);
    if (txnTypes.length === 0 || txnTypes.length > 50 || txnTypes.some((t) => !/^[a-z_]{1,40}$/.test(t))) {
      throw bad('txn_types', 'txn_types must be comma-separated transaction types');
    }
  }
  return {
    contact: readContactLens(req),
    tag: readTagLens(req, { allowUntagged: true, allowScope: true }),
    amountMin, amountMax,
    cleared: oneOf(req, 'cleared', ['cleared', 'uncleared', 'reconciled'] as const) ?? null,
    txnTypes,
  };
}

/** period_ranges=YYYY-MM-DD..YYYY-MM-DD,… (at most 36, ascending, not overlapping). */
function readPeriodRanges(req: Request): DateRange[] | null {
  const v = qs(req, 'period_ranges');
  if (v === undefined) return null;
  const parts = v.split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  if (parts.length > MAX_PERIOD_RANGES) throw bad('period_ranges', `period_ranges takes at most ${MAX_PERIOD_RANGES} ranges`);
  const ranges = parts.map((p) => {
    const m = /^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/.exec(p);
    if (!m || !isIsoDate(m[1]!) || !isIsoDate(m[2]!)) throw bad('period_ranges', 'period_ranges must be YYYY-MM-DD..YYYY-MM-DD, comma-separated');
    if (m[1]! > m[2]!) throw AppError.badRequest(`range ${p} starts after it ends`, 'INVALID_DATE_RANGE', { param: 'period_ranges' });
    return { from: m[1]!, to: m[2]! };
  });
  for (let i = 1; i < ranges.length; i++) {
    if (ranges[i]!.from <= ranges[i - 1]!.to) throw bad('period_ranges', 'period_ranges must be in date order and must not overlap');
  }
  return ranges;
}

/** Parameters that need exact=1 (and no export format); without it they would be ignored. */
const COLUMN_PARAMS = ['period_ranges', 'ytd', 'fiscal_year_start', 'prior', 'tag_split', 'tag_group_id', 'pct_of_income'];
const DRILL_PARAMS = ['tag_scope', 'contact_id', 'exclude_contact_ids', 'amount_min', 'amount_max', 'cleared', 'txn_types'];
function needsExact(params: readonly string[], extra?: (req: Request) => string | null) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const exact = readExact(req);
    const exported = req.query['format'] !== undefined && req.query['format'] !== '';
    if (!exact || exported) {
      const hit = params.find((p) => req.query[p] !== undefined && req.query[p] !== '') ?? extra?.(req) ?? null;
      if (hit) throw bad(hit, `${hit} needs exact=1 and no export format (reports-columns-v1 / reports-drill-v1)`);
    }
    next();
  };
}
const untaggedNeedsExact = (req: Request) => ((req.query['tag_id'] ?? req.query['tagId']) === 'untagged' ? 'tag_id' : null);

/**
 * POST twin of a GET drill route: the same parameters as a JSON object
 * body (strings, or arrays joined with commas), for an account_ids list
 * too long for a URL (up to 500 ids).
 */
function bodyAsQuery(req: Request, _res: Response, next: NextFunction) {
  const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body as Record<string, unknown> : {};
  const q: Record<string, string> = {};
  for (const [k, v] of Object.entries(body)) {
    if (v === null || v === undefined) continue;
    if (Array.isArray(v)) q[k] = v.map((x) => String(x)).join(',');
    else if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') q[k] = String(v);
    else throw bad(k, `${k} must be a string`);
  }
  (req as unknown as { query: Record<string, string> }).query = { ...(req.query as Record<string, string>), ...q, exact: q['exact'] ?? '1' };
  next();
}

/**
 * The Journal (GET /general-ledger?group_by=transaction, U-202): the
 * General Ledger's lines regrouped by transaction, in date order, every
 * filter applied per line exactly as on the ledger. limit counts lines.
 */
type GlLine = Record<string, unknown> & { transactionId: string; date: unknown; debitExact?: string; creditExact?: string; lineOrder?: number };
type GlAccount = { id: string; accountNumber: string | null; name: string; lines: GlLine[] };
export function journalOf(gl: { title?: string; startDate: string; endDate: string; accounts: GlAccount[] }, limit: number | null) {
  type Txn = { transactionId: string; date: unknown; txnType: unknown; txnNumber: unknown; contactName: unknown; lines: Array<Record<string, unknown>> };
  const byTxn = new Map<string, Txn>();
  for (const a of gl.accounts) {
    for (const l of a.lines) {
      let t = byTxn.get(l.transactionId);
      if (!t) {
        t = { transactionId: l.transactionId, date: l.date, txnType: l['txnType'], txnNumber: l['txnNumber'], contactName: l['contactName'], lines: [] };
        byTxn.set(l.transactionId, t);
      }
      t.lines.push({
        lineId: l['lineId'], sourceLineId: l['sourceLineId'] ?? null, accountId: a.id, accountNumber: a.accountNumber, accountName: a.name,
        description: l['description'], debitExact: l.debitExact, creditExact: l.creditExact, tagId: l['tagId'] ?? null, tagName: l['tagName'] ?? null,
        contactId: l['contactId'] ?? null, lineOrder: l.lineOrder ?? 0,
      });
    }
  }
  const day = (d: unknown) => (d instanceof Date ? d.getTime() : Date.parse(String(d)));
  const txns = [...byTxn.values()].sort((x, y) => day(x.date) - day(y.date)
    || String(x.txnNumber ?? '').localeCompare(String(y.txnNumber ?? ''), undefined, { numeric: true })
    || x.transactionId.localeCompare(y.transactionId));
  let rowCount = 0;
  let totalD = dsum([]); let totalC = dsum([]);
  const out = txns.map((t) => {
    t.lines.sort((p, q) => Number(p['lineOrder']) - Number(q['lineOrder']) || String(p['accountNumber'] ?? '').localeCompare(String(q['accountNumber'] ?? '')));
    const d = dsum(t.lines.map((l) => l['debitExact'] as string));
    const c = dsum(t.lines.map((l) => l['creditExact'] as string));
    totalD = totalD.plus(d); totalC = totalC.plus(c);
    rowCount += t.lines.length;
    return { ...t, totalDebitsExact: exactStr(d), totalCreditsExact: exactStr(c) };
  });
  let truncated = false;
  if (limit !== null && rowCount > limit) {
    truncated = true;
    let left = limit;
    for (const t of out) {
      if (t.lines.length > left) t.lines = t.lines.slice(0, left);
      left -= t.lines.length;
    }
  }
  return {
    title: 'Journal', startDate: gl.startDate, endDate: gl.endDate,
    transactions: out.filter((t) => t.lines.length > 0),
    totalDebitsExact: exactStr(totalD), totalCreditsExact: exactStr(totalC), rowCount, truncated,
  };
}

function columnsError(e: unknown): never {
  if (e instanceof ReportColumnsError) {
    if (e.code === 'NOT_FOUND') throw AppError.notFound(e.message);
    throw bad(e.param, e.message);
  }
  throw e;
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
// U-201 (reports-columns-v1); every one needs exact=1.
const COLUMNS_Q = {
  period_ranges: z.string().optional().describe('YYYY-MM-DD..YYYY-MM-DD,… up to 36 ranges in date order, not overlapping (4-4-5 or custom periods). '
    + 'One column per range (Balance Sheet: as of each range end); a P&L with two or more ranges adds a Total column.'),
  ytd: z.enum(['1', '0']).optional().describe('1 = add a YTD column from fiscal_year_start (default: the company fiscal year start) to the last end date'),
  fiscal_year_start: z.string().optional().describe('YYYY-MM-DD; the YTD column start (needs ytd=1)'),
  prior: z.enum(['period', 'year']).optional().describe('After each period / YTD column: the prior period (same number of days just before; '
    + 'Balance Sheet: as of the day before the period start) or prior year, $ change (current - prior) and % change (change / |prior|, 1 place, null on 0)'),
  tag_split: z.enum(['1', '0']).optional().describe('1 = under each account: rowKind account (lines without a tag from the group), tag (one per group tag '
    + 'with activity) and account_total (untagged + tags, the unsplit amount). Section totals unchanged. Needs tag_group_id.'),
  tag_group_id: z.string().uuid().optional().describe('The tag group for tag_split or compare=by_tag'),
  pct_of_income: z.enum(['1', '0']).optional().describe('1 = pctOfIncomeExact per row and pctOfIncomeTotalsExact: amount / total income x 100, 1 place, null on 0 income'),
};
// U-202 (reports-drill-v1); every one needs exact=1.
const DRILL_Q = {
  contact_id: z.string().optional().describe('Comma-separated client ids (the line\'s own contact, else its transaction\'s), none (no client) or others (with exclude_contact_ids)'),
  exclude_contact_ids: z.string().optional().describe('With contact_id=others: the clients to leave out (at most 100)'),
  account_ids: z.string().optional().describe('Comma-separated account ids, at most 500 (POST the same parameters as a JSON body for long lists)'),
  tag_id: z.string().optional().describe('Comma-separated tag ids or untagged (per line: the line\'s own tag)'),
  tag_scope: z.enum(['untagged_in_group']).optional().describe('Lines without a tag from tag_group_id (no tag, or a tag from another group)'),
  tag_group_id: z.string().uuid().optional(),
  amount_min: z.string().optional().describe('Decimal string; lines with |debit - credit| at least this'),
  amount_max: z.string().optional().describe('Decimal string; lines with |debit - credit| at most this'),
  cleared: z.enum(['cleared', 'uncleared', 'reconciled']).optional().describe('Reconciliation state of the journal line (cash-basis shares of a paid document count as uncleared)'),
  txn_types: z.string().optional().describe('Comma-separated transaction types'),
};
const ADJ_Q = { adjusting: z.enum(['include', 'exclude', 'only']).optional() };
const META_DOC = 'meta {exact: true, basis, cashBasisRules (plain-language Q-P23z note on cash basis, else null), from, to | asOf, reportSchemaVersion}. '
  + 'Every *Exact is the unrounded decimal string, same sign as its number field: 4 places from the journal, more for a cash-basis '
  + 'allocation share (never rounded). Totals are Decimal sums of the rows. Standard P&L, Balance Sheet and Trial Balance account rows carry '
  + 'parentAccountId, depth and (parents) rollupExact, in report order with zero-amount ancestors added so the tree is complete.';

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

  /** The parameters every drill of this report adds (basis, adjusting, report tag filter). */
  const drillBase = (b: 'accrual' | 'cash', adjusting: string, tag: TagLens | null): Record<string, string> => ({
    basis: b, adjusting,
    ...(tag?.kind === 'ids' ? { tag_id: tag.ids.join(',') } : tag?.kind === 'untagged' ? { tag_id: 'untagged' } : {}),
  });

  // U-201: the column layout of the Profit and Loss, or null for the classic shapes.
  async function profitLossColumns(req: Request) {
    const ranges = readPeriodRanges(req);
    const ytd = flag(req, 'ytd');
    const prior = oneOf(req, 'prior', ['period', 'year'] as const) ?? null;
    const compareRaw = qs(req, 'compare');
    const tagSplit = flag(req, 'tag_split');
    const pctOfIncome = flag(req, 'pct_of_income');
    const groupId = uuid(req, 'tag_group_id', false) ?? null;
    const tagFilter = readTagLens(req, { allowUntagged: true, allowScope: false });
    const compare = compareRaw === 'by_contact' ? { kind: 'contact' as const }
      : compareRaw === 'by_tag' && groupId ? { kind: 'tag' as const, groupId } : null;
    const columnsMode = !!ranges || ytd || !!prior || !!compare || tagSplit || pctOfIncome || tagFilter?.kind === 'untagged';
    if (!columnsMode) {
      if (groupId) throw bad('tag_group_id', 'tag_group_id needs tag_split=1 or compare=by_tag');
      if (qs(req, 'fiscal_year_start') !== undefined) throw bad('fiscal_year_start', 'fiscal_year_start needs ytd=1');
      return null;
    }
    if (compareRaw && !compare) {
      throw bad('compare', compareRaw === 'by_tag'
        ? 'compare=by_tag with these options needs tag_group_id'
        : `compare=${compareRaw} does not combine with period_ranges, ytd, prior, tag_split or pct_of_income`);
    }
    if (compare && (ranges || ytd || prior || tagSplit)) throw bad('compare', 'columns by client or tag do not combine with period_ranges, ytd, prior or tag_split');
    if (tagSplit && !groupId) throw bad('tag_group_id', 'tag_split needs tag_group_id');
    if (!tagSplit && !compare && groupId) throw bad('tag_group_id', 'tag_group_id needs tag_split=1 or compare=by_tag');
    if ((tagSplit || compare?.kind === 'tag') && tagFilter) throw bad('tag_id', 'tag_id does not combine with tag_split or compare=by_tag');
    if (h.readGroupBy(req)) throw bad('group_by', 'group_by is not available in the column layout');
    const fyParam = date(req, 'fiscal_year_start');
    if (fyParam && !ytd) throw bad('fiscal_year_start', 'fiscal_year_start needs ytd=1');
    const useRanges = ranges ?? [range(req)];
    const b = basis(req);
    const companyId = h.resolveCompanyScope(req);
    const adjusting = h.readAdjusting(req);
    const last = useRanges[useRanges.length - 1]!.to;
    let ytdFrom: string | null = null;
    if (ytd) {
      ytdFrom = fyParam ?? fiscalYearStartOf(last, await reportService.getFiscalYearStart(req.tenantId, companyId));
      if (ytdFrom > last) throw AppError.badRequest('fiscal_year_start is after the last period end', 'INVALID_DATE_RANGE', { param: 'fiscal_year_start' });
    }
    const data = await buildProfitAndLossColumns(req.tenantId, {
      basis: b, companyId, adjusting, tagFilter, ranges: useRanges, periodColumns: !!ranges, ytdFrom, prior, compare,
      tagSplitGroupId: tagSplit ? groupId : null, pctOfIncome,
    }).catch(columnsError);
    const from = ytdFrom && ytdFrom < useRanges[0]!.from ? ytdFrom : useRanges[0]!.from;
    return {
      ...data,
      drillTarget: { path: '/reports/general-ledger', amount: 'netChangeExact', params: drillBase(b, adjusting, tagFilter) },
      meta: meta(req, { basis: b, from, to: last }),
    };
  }

  // U-201: the column layout of the Balance Sheet, or null for the classic shapes.
  async function balanceSheetColumns(req: Request) {
    const ranges = readPeriodRanges(req);
    const prior = oneOf(req, 'prior', ['period', 'year'] as const) ?? null;
    const tagSplit = flag(req, 'tag_split');
    const groupId = uuid(req, 'tag_group_id', false) ?? null;
    const tagFilter = readTagLens(req, { allowUntagged: true, allowScope: false });
    if (flag(req, 'ytd')) throw bad('ytd', 'ytd is not available on the Balance Sheet');
    if (flag(req, 'pct_of_income')) throw bad('pct_of_income', 'pct_of_income is not available on the Balance Sheet');
    const columnsMode = !!ranges || !!prior || tagSplit || tagFilter?.kind === 'untagged';
    if (!columnsMode) {
      if (groupId) throw bad('tag_group_id', 'tag_group_id needs tag_split=1');
      return null;
    }
    if (qs(req, 'compare')) throw bad('compare', 'compare does not combine with period_ranges, prior, tag_split or tag_id=untagged');
    if (tagSplit && !groupId) throw bad('tag_group_id', 'tag_split needs tag_group_id');
    if (!tagSplit && groupId) throw bad('tag_group_id', 'tag_group_id needs tag_split=1');
    if (tagSplit && tagFilter) throw bad('tag_id', 'tag_id does not combine with tag_split');
    if (h.readGroupBy(req)) throw bad('group_by', 'group_by is not available in the column layout');
    let asOfs: Array<{ asOf: string; from: string | null }>;
    if (ranges) {
      asOfs = ranges.map((r) => ({ asOf: r.to, from: r.from }));
    } else {
      const asOf = date(req, 'as_of_date') ?? today();
      const from = date(req, 'start_date') ?? null;
      if (from && from > asOf) throw AppError.badRequest('start_date is after as_of_date', 'INVALID_DATE_RANGE', { param: 'start_date' });
      asOfs = [{ asOf, from }];
    }
    if (prior === 'period' && asOfs.some((a) => !a.from)) throw bad('prior', 'prior=period needs period_ranges or start_date');
    const b = basis(req);
    const adjusting = h.readAdjusting(req);
    const data = await buildBalanceSheetColumns(req.tenantId, {
      basis: b, companyId: h.resolveCompanyScope(req), adjusting, tagFilter, asOfs, periodColumns: !!ranges, prior,
      tagSplitGroupId: tagSplit ? groupId : null,
    }).catch(columnsError);
    return {
      ...data,
      drillTarget: { path: '/reports/general-ledger', amount: 'endingBalanceExact', params: drillBase(b, adjusting, tagFilter) },
      meta: meta(req, { basis: b, asOf: asOfs[asOfs.length - 1]!.asOf }),
    };
  }

  // ── Financial statements ──
  router.get('/profit-loss', doc('Profit and Loss',
    'Standard: revenue/cogs/expenses/otherRevenue/otherExpenses[] {accountId, amount, amountExact, parentAccountId, depth, rollupExact?}, '
    + 'total*Exact, grossProfitExact, operatingIncomeExact, netIncomeExact; group_by adds groups[].subtotalExact. compare=previous_period|'
    + 'previous_year|ytd_vs_prior_ytd|multi_period|by_tag: rows[].valuesExact and groups[].valuesExact (amounts; $ change; % change at 1 place, '
    + 'null on a zero base), total*Exact / netIncomeExact arrays.',
    { ...RANGE_Q, ...BASIS_Q, ...ADJ_Q, compare: z.string().optional(), periods: z.string().optional(), period_type: z.string().optional(),
      group_by: z.enum(['detail_type', 'leadsheet']).optional(), ...COLUMNS_Q }),
  needsExact(COLUMN_PARAMS, (req) => (req.query['compare'] === 'by_contact' ? 'compare' : untaggedNeedsExact(req))),
  exactOnly(async (req) => {
    const columns = await profitLossColumns(req);
    if (columns) return columns;
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
    { as_of_date: z.string().optional(), ...BASIS_Q, ...ADJ_Q, compare: z.string().optional(), group_by: z.enum(['detail_type', 'leadsheet']).optional(),
      start_date: z.string().optional().describe('With prior=period and no period_ranges: the period start (prior as-of = the day before)'),
      period_ranges: COLUMNS_Q.period_ranges, prior: COLUMNS_Q.prior, tag_split: COLUMNS_Q.tag_split, tag_group_id: COLUMNS_Q.tag_group_id }),
  needsExact(COLUMN_PARAMS, untaggedNeedsExact),
  exactOnly(async (req) => {
    const columns = await balanceSheetColumns(req);
    if (columns) return columns;
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
    { ...RANGE_Q, as_of_date: z.string().optional(), ...BASIS_Q, ...ADJ_Q, tag_split: COLUMNS_Q.tag_split, tag_group_id: COLUMNS_Q.tag_group_id }),
  needsExact(['tag_split', 'tag_group_id']),
  exactOnly(async (req) => {
    const asOf = date(req, 'as_of_date');
    const from = date(req, 'start_date') ?? yearStart();
    const to = date(req, 'end_date') ?? asOf ?? today();
    if (from > to) throw AppError.badRequest('start_date is after end_date', 'INVALID_DATE_RANGE', { param: 'end_date' });
    const b = basis(req);
    const tagSplit = flag(req, 'tag_split');
    const groupId = uuid(req, 'tag_group_id', false) ?? null;
    if (tagSplit && !groupId) throw bad('tag_group_id', 'tag_split needs tag_group_id');
    if (!tagSplit && groupId) throw bad('tag_group_id', 'tag_group_id needs tag_split=1');
    if (tagSplit && (req.query['tag_id'] ?? req.query['tagId'])) throw bad('tag_id', 'tag_id does not combine with tag_split');
    const companyId = h.resolveCompanyScope(req);
    const adjusting = h.readAdjusting(req);
    const data = await reportService.buildTrialBalance(req.tenantId, from, to, companyId, h.readTagFilter(req), b,
      { adjusting, exactAmounts: true, accountTree: true });
    const out = tagSplit
      ? await applyTrialBalanceTagSplit(req.tenantId, data as typeof data & { data: Array<Record<string, unknown>> }, { basis: b, companyId, adjusting, tagGroupId: groupId! })
        .catch(columnsError)
      : data;
    return {
      ...out,
      drillTarget: { path: '/reports/general-ledger', amount: 'endingBalanceExact',
        startDate: fiscalYearStartOf(to, await reportService.getFiscalYearStart(req.tenantId, companyId)), endDate: to,
        note: 'GL start_date = startDate (the fiscal year start of the end date), end_date = endDate; the GL ending balance is in the account\'s natural sign '
          + '(netExact for debit-normal accounts, -netExact for credit-normal ones). The computed retained-earnings row has no drill.',
        params: { basis: b, adjusting } },
      meta: meta(req, { basis: b, from, to }),
    };
  }));

  router.get('/general-ledger', doc('General Ledger',
    'accounts[] {accountId, beginningBalanceExact, periodDebitsExact, periodCreditsExact, endingBalanceExact, lines[] {lineId, transactionId, '
    + 'debitExact, creditExact, runningBalanceExact}}, totalDebitsExact, totalCreditsExact, rowCount (all lines), truncated. limit returns at most '
    + 'that many lines in report order; balances and totals still cover every line. Cash-basis lineIds are row numbers, not journal line ids.',
    { ...RANGE_Q, ...BASIS_Q, ...ADJ_Q, limit: z.string().optional().describe('1-100000'),
      ...DRILL_Q, tag_split: COLUMNS_Q.tag_split,
      group_by: z.enum(['transaction']).optional().describe('transaction = the Journal: transactions[] {transactionId, date, txnType, txnNumber, '
        + 'contactName, lines[] {lineId, accountId, accountNumber, accountName, debitExact, creditExact, tagId, contactId}, totalDebitsExact, '
        + 'totalCreditsExact} in date order, totalDebitsExact, totalCreditsExact, rowCount, truncated') }),
  needsExact([...DRILL_PARAMS, 'tag_split', 'tag_group_id'],
    (req) => (req.query['group_by'] === 'transaction' ? 'group_by' : untaggedNeedsExact(req))),
  exactOnly(generalLedger));
  router.post('/general-ledger', doc('General Ledger (POST)',
    'The exact General Ledger with the parameters as a JSON object body (strings; arrays are joined with commas), for an account_ids '
    + 'list too long for a URL. exact=1 is implied. Same response as GET /reports/general-ledger?exact=1.', {}),
  bodyAsQuery, exactOnly(generalLedger));

  async function generalLedger(req: Request) {
    const { from, to } = range(req);
    const b = basis(req);
    const limit = posInt(req, 'limit', 100000);
    const lens = readLineLens(req);
    const accountIds = strictIds(req, 'account_ids');
    const tagSplit = flag(req, 'tag_split');
    const groupBy = oneOf(req, 'group_by', ['transaction'] as const);
    const groupId = uuid(req, 'tag_group_id', false) ?? null;
    if (tagSplit && !groupId) throw bad('tag_group_id', 'tag_split needs tag_group_id');
    if (tagSplit && lens.tag) throw bad('tag_id', 'tag_id / tag_scope do not combine with tag_split');
    if (tagSplit && groupBy) throw bad('tag_split', 'tag_split does not combine with group_by=transaction');
    if (groupId && !tagSplit && lens.tag?.kind !== 'untagged_in_group') throw bad('tag_group_id', 'tag_group_id needs tag_split=1 or tag_scope');
    if (tagSplit) {
      const tags = await loadGroupTags(req.tenantId, groupId!);
      if (tags === null) throw AppError.notFound('tag group not found');
    }
    const adjusting = h.readAdjusting(req);
    const data = await reportService.buildGeneralLedger(req.tenantId, from, to, h.resolveCompanyScope(req), null, b,
      accountIds, { adjusting, exactAmounts: true, limit: groupBy ? null : limit ?? null, lens, tagSplitGroupId: tagSplit ? groupId : null });
    const m = meta(req, { basis: b, from, to });
    if (groupBy === 'transaction') return { ...journalOf(data, limit ?? null), meta: m };
    return { ...data, meta: m };
  }

  router.get('/account-activity-summary', doc('Account Activity Summary',
    'data[] {total_debitExact, total_creditExact, netExact}, totalDebitsExact, totalCreditsExact, totalNetExact.', { ...RANGE_Q }),
  exactOnly(async (req) => {
    const { from, to } = range(req);
    const data = await reportService.buildAccountActivitySummary(req.tenantId, from, to, h.resolveCompanyScope(req), h.readTagFilter(req), { exactAmounts: true });
    return { ...data, meta: meta(req, { basis: 'accrual', from, to }) };
  }));

  // ── Lists ──
  router.get('/transaction-list', doc('Transaction List',
    'One row per journal line: data[] {id (transaction), lineId (journal line; on cash basis the line passed through, null for a share of a '
    + 'paid document), accountId, contactId (the line\'s client), debitExact, creditExact, amountExact (debit - credit)}, totalsExact {debit, '
    + 'credit, amount}. With exact=1 every filter is per line, tag_id included (reports-drill-v1).',
    { ...RANGE_Q, ...BASIS_Q, ...ADJ_Q, txn_type: z.string().optional(), account_id: z.string().optional(), ...DRILL_Q }),
  needsExact([...DRILL_PARAMS, 'account_ids', 'tag_group_id'], untaggedNeedsExact),
  exactOnly(transactionList));
  router.post('/transaction-list', doc('Transaction List (POST)',
    'The exact Transaction List with the parameters as a JSON object body (strings; arrays are joined with commas), for an account_ids '
    + 'list too long for a URL. exact=1 is implied. Same response as GET /reports/transaction-list?exact=1.', {}),
  bodyAsQuery, exactOnly(transactionList));

  async function transactionList(req: Request) {
    const { from, to } = range(req, 'start_date', 'end_date', false);
    const b = basis(req);
    const accountId = uuid(req, 'account_id', false);
    const lens = readLineLens(req);
    const accountIds = strictIds(req, 'account_ids');
    if (accountId && accountIds) throw bad('account_ids', 'use account_id or account_ids, not both');
    const data = await reportService.buildTransactionList(req.tenantId, {
      startDate: from || undefined, endDate: to || undefined, txnType: qs(req, 'txn_type'), accountId,
      basis: b, adjusting: h.readAdjusting(req), exactAmounts: true, accountIds, lens,
    }, h.resolveCompanyScope(req));
    return {
      ...exactList(data as { data: unknown[] }, ['debit', 'credit', 'amount'], (r) => ({
        lineId: r['line_id'] ?? null, accountId: r['account_id'] ?? null, contactId: r['line_contact_id'] ?? null,
      })),
      meta: meta(req, { basis: b, from: from || undefined, to: to || undefined }),
    };
  }

  router.get('/journal-entry-report', doc('Journal',
    'Journal entries, one row per line: data[] {id, lineId, debitExact, creditExact, amountExact}, totalsExact.', { ...RANGE_Q, ...ADJ_Q }),
  exactOnly(async (req) => {
    const { from, to } = range(req, 'start_date', 'end_date', false);
    const data = await reportService.buildJournalEntryReport(req.tenantId, { startDate: from || undefined, endDate: to || undefined },
      h.resolveCompanyScope(req), h.readTagFilter(req), h.readAdjusting(req), { exactAmounts: true });
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
      const data = await apReportService.buildApAgingSummary(req.tenantId, asOf, h.resolveCompanyScope(req), h.readTagFilter(req), { exactAmounts: true });
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
    const data = await apReportService.buildVendorStatement(req.tenantId, vendorId, { startDate: from, endDate: to }, h.resolveCompanyScope(req), { exactAmounts: true });
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
    const data = await apReportService.buildAp1099Prep(req.tenantId, year, h.resolveCompanyScope(req), { exactAmounts: true });
    return { ...data, meta: meta(req, { basis: null, from: `${year}-01-01`, to: `${year}-12-31` }) };
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
    return { ...data, meta: meta(req, { basis: null, from: `${year}-01-01`, to: `${year}-12-31` }) };
  }));

  // ── Sales and spending ──
  for (const [path, title, build] of [
    ['/sales-by-customer', 'Sales by Client', reportService.buildSalesByCustomer],
    ['/sales-by-item', 'Sales by Item', reportService.buildSalesByItem],
  ] as const) {
    router.get(path, doc(title, `data[] {${path === '/sales-by-customer' ? 'contact_id (null: no client)' : 'item_id (null: no item)'}, totalExact}, `
      + 'totalsExact {total}, grandTotalExact (= totalsExact.total). adjusting is the U-60 lens (reports-drill-v1).', { ...RANGE_Q, ...BASIS_Q, ...ADJ_Q }),
    exactOnly(async (req) => {
      const { from, to } = range(req);
      const b = basis(req);
      const data = await build(req.tenantId, from, to, h.resolveCompanyScope(req), h.readTagFilter(req), b, h.readAdjusting(req));
      const list = exactList(data as { data: unknown[] }, ['total']);
      return { ...list, grandTotalExact: list.totalsExact['total'], meta: meta(req, { basis: b, from, to }) };
    }));
  }
  router.get('/expense-by-vendor', doc('Expenses by Vendor',
    'data[] {totalExact}, totalsExact {total}; display=detail adds groups[] {totalExact, accounts[] {totalExact}}.',
    { ...RANGE_Q, ...BASIS_Q, display: z.enum(['detail']).optional() }),
  exactOnly(async (req) => {
    const { from, to } = range(req);
    const b = basis(req);
    const data = await reportService.buildExpenseByVendor(req.tenantId, from, to, h.resolveCompanyScope(req), h.readTagFilter(req), req.query['display'] === 'detail', b, { exactAmounts: true });
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
    const data = await reportService.buildBankBalances(req.tenantId, asOf, h.resolveCompanyScope(req), { exactAmounts: true });
    return { ...data, meta: meta(req, { basis: 'accrual', asOf }) };
  }));
}
