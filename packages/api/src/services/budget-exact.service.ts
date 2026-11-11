// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

// Exact budgets and Budget vs. Actual (U-203, budgets-exact-v1; ClientLedger
// P28 PR-C, Q-P28c / Q-P28n).
//
// Budgets are company-scoped: a request sees its company's budgets and the
// budgets saved before budgets had a company (company_id NULL, every budget
// MyBooks Online created so far). New budgets take the request's company.
//
// Writes (the budget, its lines, fill from actuals, copy, adjust %) each run
// in ONE database transaction: the budget row is locked, the `version` the
// caller read (when sent) is compared (409 STALE_VERSION {current}), the
// write is made, the version goes up by one, the Idempotency-Key is claimed
// and an audit row written. Callers that send no version keep the old
// last-write-wins behaviour (MyBooks Online today).
//
// Lines: one row per P&L account with twelve period cells (month_1..month_12,
// "period" = a fiscal period; 4-4-5 is the desktop's mapping of periods to
// dates). A cell is a decimal with at most 2 places (stored at 4).
// Fill from actuals and adjust % compute in Decimal and round each cell to
// the cent, half away from zero.
//
// Budget vs. Actual: actuals are the P&L's own lines (report-lens.lineSums:
// same basis, company, adjusting and cash-basis rules), matched by account
// id, summed in Decimal; range i of period_ranges is budget period
// first_period + i, taken whole (the desktop snaps custom dates out to
// whole periods). Rows cover every P&L account with a budget or activity;
// over = actual - budget; % of budget = actual / budget x 100 at 1 place,
// half away from zero, null on a zero budget. Nothing here is a JS number.

import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { db, type Tx } from '../db/index.js';
import { budgets } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import { auditLog } from '../middleware/audit.js';
import { claimAndRecord } from './idempotency.service.js';
import {
  ReportDecimal, applyAccountTree, dec, dsum, exactStr, percent1, type AccountTreeNode, type Dec,
} from './report-exact.js';
import { loadAccountTree, type AdjustingFilter } from './report.service.js';
import { lineSums, loadGroupTags, naturalAmount, type GroupTag, type LineLens } from './report-lens.js';
import { rangeCaption, type DateRange } from './report-columns.service.js';

export const BUDGETS_EXACT_CAPABILITY = 'budgets-exact-v1';

export const PERIODS = 12;
export const MAX_LINES_PER_PUT = 2000;
export const PL_TYPES = ['revenue', 'cogs', 'expense', 'other_revenue', 'other_expense'] as const;

const PERIOD_KEYS = Array.from({ length: PERIODS }, (_, i) => `month${i + 1}`);
const ZERO = () => dec(0);

export type BudgetRow = typeof budgets.$inferSelect;

// ── Errors ─────────────────────────────────────────────────────────

export function stale(current: number): AppError {
  return AppError.conflict('This budget was changed since you opened it. Reload it and make your change again.', 'STALE_VERSION', { current });
}

export function lineInvalid(message: string, details: Record<string, unknown>): AppError {
  return AppError.badRequest(message, 'BUDGET_LINE_INVALID', details);
}

export const budgetNotFound = () => AppError.notFound('Budget not found');

// ── Scope ──────────────────────────────────────────────────────────

/** The company's budgets plus the budgets saved before budgets had a company. */
export function budgetScope(tenantId: string, companyId: string | null) {
  return companyId
    ? and(eq(budgets.tenantId, tenantId), or(eq(budgets.companyId, companyId), isNull(budgets.companyId)))
    : eq(budgets.tenantId, tenantId);
}

export async function budgetForAccess(tenantId: string, companyId: string | null, id: string, exec: Tx | typeof db = db): Promise<BudgetRow> {
  const [row] = await exec.select().from(budgets).where(and(budgetScope(tenantId, companyId), eq(budgets.id, id))).limit(1);
  if (!row) throw budgetNotFound();
  return row;
}

async function lockBudget(tx: Tx, tenantId: string, companyId: string | null, id: string): Promise<BudgetRow> {
  const [row] = await tx.select().from(budgets).where(and(budgetScope(tenantId, companyId), eq(budgets.id, id))).for('update').limit(1);
  if (!row) throw budgetNotFound();
  return row;
}

function checkVersion(row: BudgetRow, version: number | undefined): void {
  if (version !== undefined && row.version !== version) throw stale(row.version);
}

async function bump(tx: Tx, row: BudgetRow): Promise<number> {
  const next = row.version + 1;
  await tx.update(budgets).set({ version: next, updatedAt: new Date() })
    .where(and(eq(budgets.tenantId, row.tenantId), eq(budgets.id, row.id)));
  return next;
}

// ── Cells ──────────────────────────────────────────────────────────

const CELL_RE = /^-?\d{1,15}(\.\d+)?$/;

/**
 * A budget cell from a request: a decimal string (or, for older callers, a
 * JSON number). Empty, null or absent is 0. More than 4 places (the stored
 * scale) or not a number is 400 BUDGET_LINE_INVALID. 3 or 4 places by value
 * are returned with `subCent`: the caller accepts them only when they equal
 * the stored cell (sub-cent amounts written by the old float fill / adjust).
 */
export function parseCell(v: unknown, where: { index: number; field: string }): { d: Dec; subCent: boolean } {
  if (v === undefined || v === null || v === '') return { d: ZERO(), subCent: false };
  let s: string;
  if (typeof v === 'string') s = v.trim();
  else if (typeof v === 'number' && Number.isFinite(v)) s = String(v);
  else throw lineInvalid(`${where.field} must be an amount`, where);
  if (!CELL_RE.test(s)) throw lineInvalid(`${where.field} must be an amount like 1234.56`, where);
  const d = dec(s);
  if (d.decimalPlaces() > 4) throw lineInvalid(`${where.field} has more than 2 decimal places`, where);
  return { d, subCent: d.decimalPlaces() > 2 };
}

/** Round to the cent, half away from zero. */
export function cent(d: Dec): Dec {
  return d.toDecimalPlaces(2, ReportDecimal.ROUND_HALF_UP);
}

const cellOut = (d: Dec) => exactStr(d);

// ── Accounts ───────────────────────────────────────────────────────

interface PlAccount { id: string; name: string; accountNumber: string | null; accountType: string; isActive: boolean }

/** The tenant's P&L accounts the company can use (its own and the shared ones), in report order. */
async function loadPlAccounts(tenantId: string, companyId: string | null, exec: Tx | typeof db = db): Promise<PlAccount[]> {
  const res = await exec.execute(sql`
    SELECT id, name, account_number, account_type, COALESCE(is_active, true) AS is_active FROM accounts
    WHERE tenant_id = ${tenantId}
      AND account_type IN (${sql.join(PL_TYPES.map((t) => sql`${t}`), sql`, `)})
      ${companyId ? sql`AND (company_id IS NULL OR company_id = ${companyId})` : sql``}
    ORDER BY account_number, name, id
  `);
  return (res.rows as Array<Record<string, unknown>>).map((r) => ({
    id: String(r['id']), name: String(r['name'] ?? ''), accountNumber: (r['account_number'] as string | null) ?? null,
    accountType: String(r['account_type']), isActive: r['is_active'] !== false,
  }));
}

// ── Reading lines ──────────────────────────────────────────────────

interface StoredLine { accountId: string; cells: Dec[] }

async function readLines(budgetId: string, exec: Tx | typeof db = db): Promise<StoredLine[]> {
  const res = await exec.execute(sql`SELECT * FROM budget_lines WHERE budget_id = ${budgetId}`);
  return (res.rows as Array<Record<string, unknown>>).map((r) => ({
    accountId: String(r['account_id']),
    cells: Array.from({ length: PERIODS }, (_, i) => dec(r[`month_${i + 1}`] as string | null)),
  }));
}

const SECTION_OF: Record<string, 'revenue' | 'cogs' | 'expenses' | 'otherRevenue' | 'otherExpenses'> = {
  revenue: 'revenue', cogs: 'cogs', expense: 'expenses', other_revenue: 'otherRevenue', other_expense: 'otherExpenses',
};
type SectionKey = 'revenue' | 'cogs' | 'expenses' | 'otherRevenue' | 'otherExpenses';
const SECTIONS: SectionKey[] = ['revenue', 'cogs', 'expenses', 'otherRevenue', 'otherExpenses'];

/** Net income from section values: revenue + other revenue - cogs - expenses - other expenses. */
function netOf(s: Record<SectionKey, Dec>): Dec {
  return s.revenue.plus(s.otherRevenue).minus(s.cogs).minus(s.expenses).minus(s.otherExpenses);
}

/**
 * The exact view of a budget's lines (added to GET /budgets/:id/lines and
 * every write response): per line periodsExact[12] and totalExact; per
 * section and for net income, the per-period totals and the total.
 */
export async function linesTotals(tenantId: string, budgetId: string, exec: Tx | typeof db = db) {
  const res = await exec.execute(sql`
    SELECT bl.account_id, a.account_type FROM budget_lines bl
    JOIN accounts a ON a.id = bl.account_id AND a.tenant_id = ${tenantId}
    WHERE bl.budget_id = ${budgetId}
  `);
  const typeOf = new Map((res.rows as Array<Record<string, unknown>>).map((r) => [String(r['account_id']), String(r['account_type'])]));
  const lines = await readLines(budgetId, exec);
  const perLine = new Map<string, { periodsExact: string[]; totalExact: string }>();
  const sec: Record<SectionKey, Dec[]> = Object.fromEntries(SECTIONS.map((k) => [k, Array.from({ length: PERIODS }, ZERO)])) as Record<SectionKey, Dec[]>;
  for (const l of lines) {
    perLine.set(l.accountId, { periodsExact: l.cells.map(cellOut), totalExact: cellOut(dsum(l.cells)) });
    const s = SECTION_OF[typeOf.get(l.accountId) ?? ''];
    if (!s) continue;
    sec[s] = sec[s].map((v, i) => v.plus(l.cells[i]!));
  }
  const view = (cells: Dec[]) => ({ periodsExact: cells.map(cellOut), totalExact: cellOut(dsum(cells)) });
  const net = Array.from({ length: PERIODS }, (_, i) => netOf(Object.fromEntries(SECTIONS.map((k) => [k, sec[k][i]!])) as Record<SectionKey, Dec>));
  return {
    perLine,
    totalsExact: {
      ...Object.fromEntries(SECTIONS.map((k) => [k, view(sec[k])])) as Record<SectionKey, { periodsExact: string[]; totalExact: string }>,
      netIncome: view(net),
    },
  };
}

// ── Writes ─────────────────────────────────────────────────────────

export interface LineInput {
  accountId: string;
  cells: Dec[];
  /** Period indexes (0-based) with 3-4 places: accepted only when equal to the stored cell. */
  subCent?: number[];
}

/** Validates a PUT /:id/lines body's `lines` into accounts x 12 cells. */
export function parseLines(raw: unknown): LineInput[] {
  if (!Array.isArray(raw)) throw lineInvalid('lines must be a list', { field: 'lines' });
  if (raw.length > MAX_LINES_PER_PUT) throw lineInvalid(`at most ${MAX_LINES_PER_PUT} lines per request`, { field: 'lines' });
  const seen = new Set<string>();
  return raw.map((l, index) => {
    if (!l || typeof l !== 'object' || Array.isArray(l)) throw lineInvalid('each line must be an object', { index, field: 'lines' });
    const o = l as Record<string, unknown>;
    for (const k of Object.keys(o)) {
      if (k !== 'accountId' && !PERIOD_KEYS.includes(k)) {
        throw lineInvalid(`${k} is not a budget line field (periods are month1..month12)`, { index, field: k });
      }
    }
    const accountId = o['accountId'];
    if (typeof accountId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(accountId)) {
      throw lineInvalid('accountId must be an account id', { index, field: 'accountId' });
    }
    const id = accountId.toLowerCase();
    if (seen.has(id)) throw lineInvalid('an account appears twice', { index, field: 'accountId', accountId: id });
    seen.add(id);
    const parsed = PERIOD_KEYS.map((field) => parseCell(o[field], { index, field }));
    const subCent = parsed.flatMap((c, i) => (c.subCent ? [i] : []));
    return { accountId: id, cells: parsed.map((c) => c.d), ...(subCent.length > 0 ? { subCent } : {}) };
  });
}

/**
 * Upserts lines (each replaces the account's twelve cells). checkAccounts:
 * P&L accounts of the company only (PUT lines, fill); a copy takes the
 * source budget's lines as they are, as before.
 */
async function writeLines(tx: Tx, tenantId: string, companyId: string | null, budgetId: string, lines: LineInput[],
  checkAccounts = true): Promise<void> {
  if (lines.length === 0) return;
  const allowed = checkAccounts ? new Map((await loadPlAccounts(tenantId, companyId, tx)).map((a) => [a.id, a])) : null;
  lines.forEach((l, index) => {
    if (allowed && !allowed.has(l.accountId)) {
      throw lineInvalid('Budgets take income and expense (Profit and Loss) accounts of this company only', { index, field: 'accountId', accountId: l.accountId });
    }
  });
  for (let i = 0; i < lines.length; i = i + 200) {
    const chunk = lines.slice(i, i + 200);
    await tx.execute(sql`
      INSERT INTO budget_lines (budget_id, account_id, month_1, month_2, month_3, month_4, month_5, month_6,
        month_7, month_8, month_9, month_10, month_11, month_12)
      VALUES ${sql.join(chunk.map((l) => sql`(${budgetId}, ${l.accountId}, ${sql.join(l.cells.map((c) => sql`${c.toFixed()}::numeric`), sql`, `)})`), sql`, `)}
      ON CONFLICT (budget_id, account_id) DO UPDATE SET
        month_1 = EXCLUDED.month_1, month_2 = EXCLUDED.month_2, month_3 = EXCLUDED.month_3, month_4 = EXCLUDED.month_4,
        month_5 = EXCLUDED.month_5, month_6 = EXCLUDED.month_6, month_7 = EXCLUDED.month_7, month_8 = EXCLUDED.month_8,
        month_9 = EXCLUDED.month_9, month_10 = EXCLUDED.month_10, month_11 = EXCLUDED.month_11, month_12 = EXCLUDED.month_12
    `);
  }
}

/** The audit shape of a lines write: which accounts, never the amounts. */
const linesAudit = (op: string, version: number, n: number) => ({ op, version, lineCount: n });

export async function putLines(tenantId: string, companyId: string | null, budgetId: string,
  input: { version?: number; lines: LineInput[] }, userId?: string): Promise<void> {
  await db.transaction(async (tx) => {
    const row = await lockBudget(tx, tenantId, companyId, budgetId);
    checkVersion(row, input.version);
    // 3-4 places pass only unchanged (a row saved back with an old sub-cent cell).
    if (input.lines.some((l) => l.subCent)) {
      const stored = new Map((await readLines(budgetId, tx)).map((l) => [l.accountId, l.cells]));
      input.lines.forEach((l, index) => {
        for (const i of l.subCent ?? []) {
          const was = stored.get(l.accountId)?.[i];
          if (!was || !was.eq(l.cells[i]!)) throw lineInvalid(`month${i + 1} has more than 2 decimal places`, { index, field: `month${i + 1}` });
        }
      });
    }
    await writeLines(tx, tenantId, companyId, budgetId, input.lines);
    const v = await bump(tx, row);
    await claimAndRecord(tx, 'budget', budgetId);
    await auditLog(tenantId, 'update', 'budget_lines', budgetId, { version: row.version }, linesAudit('save', v, input.lines.length), userId, tx);
  });
}

/** A budget period's first day: the budget's fiscal year start plus `i` months. */
export function periodStart(fyStart: string, i: number): string {
  const y = parseInt(fyStart.slice(0, 4), 10);
  const m0 = parseInt(fyStart.slice(5, 7), 10) - 1 + i;
  const yy = y + Math.floor(m0 / 12);
  const mm = ((m0 % 12) + 12) % 12 + 1;
  return `${String(yy).padStart(4, '0')}-${String(mm).padStart(2, '0')}-01`;
}

function dayBefore(d: string): string {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() - 1);
  return t.toISOString().slice(0, 10);
}

/** The twelve calendar-month periods of a budget (or of the year `shiftYears` before it). */
export function monthlyPeriods(fyStart: string, shiftYears = 0): DateRange[] {
  return Array.from({ length: PERIODS }, (_, i) => ({
    from: periodStart(fyStart, i + 12 * shiftYears), to: dayBefore(periodStart(fyStart, i + 1 + 12 * shiftYears)),
  }));
}

export function fiscalStartOf(row: BudgetRow): string {
  return String(row.fiscalYearStart ?? `${row.fiscalYear}-01-01`).slice(0, 10);
}

/**
 * Fill from actuals: each P&L account's actual for the twelve months of the
 * year before the budget's fiscal year (natural sign, the budget's tag when
 * it has one, the company's lines), rounded to the cent, half away from
 * zero. Every active P&L account gets a line (zero when no activity), as
 * before.
 */
export async function fillFromActuals(tenantId: string, companyId: string | null, budgetId: string,
  input: { version?: number; basis?: 'accrual' | 'cash' }, userId?: string): Promise<void> {
  const row = await budgetForAccess(tenantId, companyId, budgetId);
  const windows = monthlyPeriods(fiscalStartOf(row), -1);
  const lens: LineLens | null = row.tagId ? { tag: { kind: 'ids', ids: [row.tagId] } } : null;
  const sums = await lineSums(tenantId, {
    basis: input.basis ?? 'accrual', companyId, adjusting: null, from: null, to: windows[PERIODS - 1]!.to,
    accountTypes: PL_TYPES, lens, windows,
  });
  const byAccount = new Map<string, Dec[]>();
  for (const s of sums) {
    const cells = byAccount.get(s.accountId) ?? Array.from({ length: PERIODS }, ZERO);
    cells[s.window] = cells[s.window]!.plus(naturalAmount(s.accountType, s.debit, s.credit));
    byAccount.set(s.accountId, cells);
  }
  await db.transaction(async (tx) => {
    const locked = await lockBudget(tx, tenantId, companyId, budgetId);
    checkVersion(locked, input.version);
    const accts = (await loadPlAccounts(tenantId, companyId, tx)).filter((a) => a.isActive || byAccount.has(a.id));
    const lines = accts.map((a) => ({ accountId: a.id, cells: (byAccount.get(a.id) ?? Array.from({ length: PERIODS }, ZERO)).map(cent) }));
    await writeLines(tx, tenantId, companyId, budgetId, lines);
    const v = await bump(tx, locked);
    await claimAndRecord(tx, 'budget', budgetId);
    await auditLog(tenantId, 'update', 'budget_lines', budgetId, { version: locked.version }, linesAudit('fill_from_actuals', v, lines.length), userId, tx);
  });
}

/** Copy: the source budget's lines replace the same accounts' lines on the target. */
export async function copyFromBudget(tenantId: string, companyId: string | null, targetId: string, sourceId: string,
  input: { version?: number }, userId?: string): Promise<void> {
  await budgetForAccess(tenantId, companyId, sourceId);
  await db.transaction(async (tx) => {
    const locked = await lockBudget(tx, tenantId, companyId, targetId);
    checkVersion(locked, input.version);
    const src = await readLines(sourceId, tx);
    await writeLines(tx, tenantId, companyId, targetId, src.map((l) => ({ accountId: l.accountId, cells: l.cells })), false);
    const v = await bump(tx, locked);
    await claimAndRecord(tx, 'budget', targetId);
    await auditLog(tenantId, 'update', 'budget_lines', targetId, { version: locked.version }, { ...linesAudit('copy', v, src.length), sourceBudgetId: sourceId }, userId, tx);
  });
}

const PERCENT_RE = /^-?\d{1,6}(\.\d{1,4})?$/;

/** The percent of adjust % from a decimal string or (older callers) a number; -100 or more. */
export function parsePercent(v: unknown): Dec {
  const s = typeof v === 'number' && Number.isFinite(v) ? String(v) : typeof v === 'string' ? v.trim() : '';
  if (!PERCENT_RE.test(s)) throw AppError.badRequest('percent must be a number like 5 or -2.5', 'VALIDATION_ERROR', { field: 'percent' });
  const p = dec(s);
  if (p.lt(-100)) throw AppError.badRequest('percent must be -100 or more', 'VALIDATION_ERROR', { field: 'percent' });
  return p;
}

/** Adjust %: every cell times (1 + percent / 100), rounded to the cent, half away from zero. */
export async function adjustByPercent(tenantId: string, companyId: string | null, budgetId: string,
  input: { version?: number; percent: Dec }, userId?: string): Promise<void> {
  const factor = dec(1).plus(input.percent.div(100));
  await db.transaction(async (tx) => {
    const locked = await lockBudget(tx, tenantId, companyId, budgetId);
    checkVersion(locked, input.version);
    const lines = (await readLines(budgetId, tx)).map((l) => ({ accountId: l.accountId, cells: l.cells.map((c) => cent(c.times(factor))) }));
    // Lines already on the budget: written back without the account check
    // (an account later moved off the P&L keeps its line, as before).
    for (const l of lines) {
      await tx.execute(sql`UPDATE budget_lines SET
        ${sql.join(l.cells.map((c, i) => sql`${sql.raw(`month_${i + 1}`)} = ${c.toFixed()}::numeric`), sql`, `)}
        WHERE budget_id = ${budgetId} AND account_id = ${l.accountId}`);
    }
    const v = await bump(tx, locked);
    await claimAndRecord(tx, 'budget', budgetId);
    await auditLog(tenantId, 'update', 'budget_lines', budgetId, { version: locked.version }, { ...linesAudit('adjust_percent', v, lines.length), percent: input.percent.toFixed() }, userId, tx);
  });
}

// ── Budget vs. Actual (exact) ──────────────────────────────────────

export interface BvaOptions {
  /** Company for the budget lookup (and actuals unless `consolidated`). */
  companyId: string | null;
  consolidated: boolean;
  /** Each range is one whole budget period; null = the budget's twelve calendar months. */
  ranges: DateRange[] | null;
  /** The budget period of the first range, 1..12. */
  firstPeriod: number;
  basis: 'accrual' | 'cash';
  adjusting: AdjustingFilter;
  tagSplitGroupId: string | null;
}

export class BvaParamError extends Error {
  constructor(public param: string, message: string, public code: 'INVALID_PARAM' | 'NOT_FOUND' = 'INVALID_PARAM') { super(message); }
}

export interface BvaCell { actualExact: string; budgetExact: string | null; overExact: string | null; pctOfBudgetExact: string | null }
type Pair = { actual: Dec; budget: Dec | null };

function cellOf(p: Pair): BvaCell {
  if (p.budget === null) return { actualExact: exactStr(p.actual), budgetExact: null, overExact: null, pctOfBudgetExact: null };
  return {
    actualExact: exactStr(p.actual),
    budgetExact: exactStr(p.budget),
    overExact: exactStr(p.actual.minus(p.budget)),
    pctOfBudgetExact: percent1(p.actual, p.budget),
  };
}

const addPairs = (a: Pair[], b: Pair[]): Pair[] => a.map((x, i) => ({
  actual: x.actual.plus(b[i]!.actual),
  budget: x.budget === null && b[i]!.budget === null ? null : (x.budget ?? ZERO()).plus(b[i]!.budget ?? ZERO()),
}));

export interface BvaRow {
  rowKind: 'account' | 'tag' | 'account_total';
  accountId: string;
  name: string;
  accountNumber: string | null;
  accountType: string;
  parentAccountId: string | null;
  depth: number;
  tagId?: string | null;
  tagNumber?: string | null;
  tagName?: string | null;
  /** One per column: the periods, then the total. */
  cells: BvaCell[];
  /** Parents: own + every descendant, per column. */
  rollupCells?: BvaCell[];
  /** Added to a column's drill and drillTarget.params, selects the row's lines on the General Ledger. */
  drill: Record<string, string>;
}

export async function buildBudgetVsActualExact(tenantId: string, budgetId: string, o: BvaOptions) {
  const budget = await budgetForAccess(tenantId, o.companyId, budgetId);
  const fyStart = fiscalStartOf(budget);
  const ranges = o.ranges ?? monthlyPeriods(fyStart);
  if (o.firstPeriod + ranges.length - 1 > PERIODS) {
    throw new BvaParamError(o.ranges ? 'period_ranges' : 'first_period', `first_period ${o.firstPeriod} with ${ranges.length} ranges runs past period ${PERIODS}`);
  }
  if (budget.tagId && o.tagSplitGroupId) throw new BvaParamError('tag_split', 'a budget for one tag cannot be split by a tag group');
  const groupTags: GroupTag[] | null = o.tagSplitGroupId ? await loadGroupTags(tenantId, o.tagSplitGroupId) : null;
  if (o.tagSplitGroupId && groupTags === null) throw new BvaParamError('tag_group_id', 'tag group not found', 'NOT_FOUND');

  const lens: LineLens | null = budget.tagId ? { tag: { kind: 'ids', ids: [budget.tagId] } } : null;
  const actualsCompany = o.consolidated ? null : o.companyId;
  const [sums, stored, accounts, tree] = await Promise.all([
    lineSums(tenantId, {
      basis: o.basis, companyId: actualsCompany, adjusting: o.adjusting, from: null, to: ranges[ranges.length - 1]!.to,
      accountTypes: PL_TYPES, lens, windows: ranges,
      dimension: o.tagSplitGroupId ? { kind: 'tag_group', groupId: o.tagSplitGroupId } : null,
    }),
    readLines(budget.id),
    loadPlAccounts(tenantId, null),
    loadAccountTree(tenantId),
  ]);

  const n = ranges.length;
  const cols = n + 1; // periods + total
  // actual[account][key][window]
  const actual = new Map<string, Map<string | null, Dec[]>>();
  for (const s of sums) {
    const byKey = actual.get(s.accountId) ?? new Map<string | null, Dec[]>();
    const arr = byKey.get(s.key) ?? Array.from({ length: n }, ZERO);
    arr[s.window] = arr[s.window]!.plus(naturalAmount(s.accountType, s.debit, s.credit));
    byKey.set(s.key, arr);
    actual.set(s.accountId, byKey);
  }
  const budgetOf = new Map<string, Dec[]>();
  for (const l of stored) budgetOf.set(l.accountId, Array.from({ length: n }, (_, i) => l.cells[o.firstPeriod - 1 + i]!));

  const withTotal = (vals: Pair[]): Pair[] => [...vals, vals.reduce((acc, p) => ({
    actual: acc.actual.plus(p.actual),
    budget: acc.budget === null && p.budget === null ? null : (acc.budget ?? ZERO()).plus(p.budget ?? ZERO()),
  }), { actual: ZERO(), budget: null } as Pair)];
  const actualFor = (accountId: string, pick: (k: string | null) => boolean): Dec[] => {
    const out = Array.from({ length: n }, ZERO);
    for (const [k, arr] of actual.get(accountId) ?? []) if (pick(k)) arr.forEach((v, i) => { out[i] = out[i]!.plus(v); });
    return out;
  };
  const fullPairs = (accountId: string): Pair[] => {
    const a = actualFor(accountId, () => true);
    const b = budgetOf.get(accountId) ?? Array.from({ length: n }, ZERO);
    return withTotal(a.map((x, i) => ({ actual: x, budget: b[i]! })));
  };
  const nonZero = (ps: Pair[]) => ps.some((p) => !p.actual.isZero() || (p.budget !== null && !p.budget.isZero()));

  const columns = [
    ...ranges.map((r, i) => ({
      key: `p${i}`, caption: rangeCaption(r), kind: 'period' as const, periodIndex: o.firstPeriod + i, from: r.from, to: r.to,
      drill: { start_date: r.from, end_date: r.to } as Record<string, string> | null,
    })),
    (() => {
      const contiguous = ranges.every((r, i) => i === 0 || dayBefore(r.from) === ranges[i - 1]!.to);
      const from = ranges[0]!.from; const to = ranges[n - 1]!.to;
      return { key: 'total', caption: 'Total', kind: 'total' as const, periodIndex: null, from, to,
        drill: contiguous ? { start_date: from, end_date: to } : null };
    })(),
  ];

  const inGroup = new Set((groupTags ?? []).map((t) => t.id));
  const zeroPairs = (): Pair[] => Array.from({ length: cols }, () => ({ actual: ZERO(), budget: ZERO() }));
  const sectionTotals = {} as Record<SectionKey, Pair[]>;
  const sectionRows = {} as Record<SectionKey, BvaRow[]>;

  for (const sk of SECTIONS) {
    const own = new Map<string, Pair[]>();
    const entries: Array<{ accountId: string; info: PlAccount }> = [];
    for (const a of accounts) {
      if (SECTION_OF[a.accountType] !== sk) continue;
      const p = fullPairs(a.id);
      if (!nonZero(p)) continue;
      own.set(a.id, p);
      entries.push({ accountId: a.id, info: a });
    }
    let total = zeroPairs();
    for (const p of own.values()) total = addPairs(total, p);
    sectionTotals[sk] = total;

    const placed = applyAccountTree(entries, tree, () => ZERO(), (node: AccountTreeNode) => ({
      accountId: node.id,
      info: { id: node.id, name: node.name, accountNumber: node.accountNumber, accountType: node.accountType, isActive: true },
    }));
    const hasKids = new Set(placed.map((p) => p.parentAccountId).filter((x): x is string => !!x));
    // Own + every descendant (the tree is acyclic once placed: children hang off their parent's row).
    const rollupOf = (id: string, seen: Set<string> = new Set()): Pair[] => {
      let acc = own.get(id) ?? zeroPairs();
      seen.add(id);
      for (const c of placed) if (c.parentAccountId === id && !seen.has(c.accountId)) acc = addPairs(acc, rollupOf(c.accountId, seen));
      return acc;
    };
    const rows: BvaRow[] = [];
    for (const p of placed) {
      const base = {
        accountId: p.accountId, name: p.info.name, accountNumber: p.info.accountNumber, accountType: p.info.accountType,
        parentAccountId: p.parentAccountId, depth: p.depth,
      };
      const ownPairs = own.get(p.accountId) ?? zeroPairs();
      const roll = hasKids.has(p.accountId) ? { rollupCells: rollupOf(p.accountId).map(cellOf) } : {};
      if (!o.tagSplitGroupId) {
        rows.push({ rowKind: 'account', ...base, cells: ownPairs.map(cellOf), ...roll, drill: { account_ids: p.accountId } });
        continue;
      }
      const untagged = withTotal(actualFor(p.accountId, (k) => k === null || !inGroup.has(k)).map((x) => ({ actual: x, budget: null })));
      rows.push({
        rowKind: 'account', ...base, tagId: null, tagNumber: null, tagName: null, cells: untagged.map(cellOf), ...roll,
        drill: { account_ids: p.accountId, tag_scope: 'untagged_in_group', tag_group_id: o.tagSplitGroupId },
      });
      if (own.has(p.accountId)) {
        for (const t of groupTags!) {
          const tp = withTotal(actualFor(p.accountId, (k) => k === t.id).map((x) => ({ actual: x, budget: null })));
          if (!tp.some((x) => !x.actual.isZero())) continue;
          rows.push({
            rowKind: 'tag', ...base, tagId: t.id, tagNumber: t.tagNumber, tagName: t.name, cells: tp.map(cellOf),
            drill: { account_ids: p.accountId, tag_id: t.id },
          });
        }
      }
      rows.push({
        rowKind: 'account_total', ...base, tagId: null, tagNumber: null, tagName: null, cells: ownPairs.map(cellOf),
        drill: { account_ids: p.accountId },
      });
    }
    sectionRows[sk] = rows;
  }

  const combine = (f: (s: Record<SectionKey, Pair>) => Pair): Pair[] =>
    Array.from({ length: cols }, (_, i) => f(Object.fromEntries(SECTIONS.map((k) => [k, sectionTotals[k][i]!])) as Record<SectionKey, Pair>));
  const pick = (s: Record<SectionKey, Pair>, w: 'actual' | 'budget') =>
    Object.fromEntries(SECTIONS.map((k) => [k, s[k][w] ?? ZERO()])) as Record<SectionKey, Dec>;
  const net = combine((s) => ({ actual: netOf(pick(s, 'actual')), budget: netOf(pick(s, 'budget')) }));
  const gross = combine((s) => ({ actual: s.revenue.actual.minus(s.cogs.actual), budget: (s.revenue.budget ?? ZERO()).minus(s.cogs.budget ?? ZERO()) }));
  const hasCogs = sectionRows.cogs.length > 0;

  return {
    title: 'Budget vs. Actual',
    layout: 'budget_vs_actual' as const,
    budget: {
      id: budget.id, name: budget.name, fiscalYear: budget.fiscalYear, fiscalYearStart: fyStart, tagId: budget.tagId ?? null,
      version: budget.version,
    },
    basis: o.basis,
    firstPeriod: o.firstPeriod,
    startDate: ranges[0]!.from,
    endDate: ranges[n - 1]!.to,
    columns,
    revenue: sectionRows.revenue, cogs: sectionRows.cogs, expenses: sectionRows.expenses,
    otherRevenue: sectionRows.otherRevenue, otherExpenses: sectionRows.otherExpenses,
    totalsExact: {
      totalRevenue: sectionTotals.revenue.map(cellOf),
      totalCogs: sectionTotals.cogs.map(cellOf),
      totalExpenses: sectionTotals.expenses.map(cellOf),
      totalOtherRevenue: sectionTotals.otherRevenue.map(cellOf),
      totalOtherExpenses: sectionTotals.otherExpenses.map(cellOf),
      grossProfit: hasCogs ? gross.map(cellOf) : null,
      netIncome: net.map(cellOf),
    },
    tagSplit: o.tagSplitGroupId
      ? { tagGroupId: o.tagSplitGroupId, tags: groupTags!.map((t) => ({ tagId: t.id, tagNumber: t.tagNumber, tagName: t.name })) }
      : null,
  };
}
