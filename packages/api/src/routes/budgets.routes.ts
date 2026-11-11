// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

// Budgets. Since U-203 (budgets-exact-v1, ClientLedger P28 PR-C):
//   - company-scoped: a request sees its company's budgets (X-Company-Id,
//     else the first company) plus the budgets saved before budgets had a
//     company; new budgets take the request's company;
//   - every write (PUT /:id, PUT /:id/lines, fill-from-actuals, copy-from,
//     adjust-by-percent) bumps budgets.version; a body `version` that is not
//     the current one is 409 STALE_VERSION {details.current}; without one
//     the write still happens (last write wins, the pre-U-203 behaviour);
//   - POST / and those writes take Idempotency-Key (the budget lookup runs
//     ahead of idempotent(), so a replay still needs the budget in scope);
//   - PUT /:id/lines is validated: P&L accounts of the company only, cells
//     with at most 2 decimal places, periods month1..month12, else 400
//     BUDGET_LINE_INVALID {details.index, details.field};
//   - GET /:id/lines and every write response add periodsExact[12] and
//     totalExact per line and totalsExact per section and net income;
//   - GET /:id/vs-actual?exact=1 is the exact Budget vs. Actual
//     (services/budget-exact.service.ts). Without exact=1 the response is
//     unchanged.

import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { authenticate } from '../middleware/auth.js';
import { requireResource } from '../middleware/permission.js';
import { companyContext } from '../middleware/company.js';
import { validate } from '../middleware/validate.js';
import { describe } from '../middleware/describe.js';
import { idempotent } from '../middleware/idempotent.js';
import { AppError } from '../utils/errors.js';
import * as budgetService from '../services/budget.service.js';
import * as exact from '../services/budget-exact.service.js';
import { normalizeReportDates, reportMeta } from '../services/report-exact.js';
import {
  basis as readBasis, flag, posInt, qs, readExact, readPeriodRanges, uuid as uuidQuery,
} from './reports-exact.routes.js';
import { REPORT_SCHEMA_VERSION } from './reports.routes.js';

// Explicit field allowlists. Previously req.body was spread straight into
// db.update().set(), so any column (tenantId, companyId, createdBy,
// fiscalYearStart, id) was client-settable — setting tenantId re-homed the
// row into another tenant.
const budgetStatus = z.enum(['draft', 'active', 'archived']);
const createBudgetSchema = z.object({
  name: z.string().trim().min(1).max(255),
  fiscalYear: z.number().int().min(1900).max(2200),
  tagId: z.string().uuid().nullable().optional(),
  description: z.string().max(2000).nullable().optional(),
  periodType: z.enum(['monthly', 'quarterly', 'annual']).optional(),
  status: budgetStatus.optional(),
}).strict();
const versionField = z.number().int().min(1).optional()
  .describe('The version read (budgets-exact-v1); a different current version is 409 STALE_VERSION {details.current}. Absent: last write wins.');
const updateBudgetSchema = z.object({
  name: z.string().trim().min(1).max(255).optional(),
  isActive: z.boolean().optional(),
  tagId: z.string().uuid().nullable().optional(),
  description: z.string().max(2000).nullable().optional(),
  status: budgetStatus.optional(),
  version: versionField,
}).strict();
const cellDoc = z.union([z.string(), z.number()]).optional()
  .describe('Decimal string with at most 2 places by value (e.g. "1234.50"; "1234.5000" is fine); absent or empty = 0');
const linesBodyDoc = z.object({
  version: versionField,
  lines: z.array(z.object({
    accountId: z.string().uuid(),
    ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`month${i + 1}`, cellDoc])),
  }).strict()).max(exact.MAX_LINES_PER_PUT)
    .describe('Each line replaces its account\'s twelve periods (month1..month12 = budget periods 1..12). P&L accounts of the company only.'),
});
const linesBodySchema = z.object({ version: versionField, lines: z.unknown() }).strict();
const fillBodySchema = z.object({
  version: versionField,
  basis: z.enum(['accrual', 'cash']).optional().describe('Default accrual'),
}).strict();
const versionBodySchema = z.object({ version: versionField }).strict();
const adjustBodySchema = z.object({
  version: versionField,
  percent: z.union([z.string(), z.number()]).describe('Decimal string like "5" or "-2.5" (a number is accepted); -100 or more'),
}).strict();

const idParams = z.object({ id: z.string().uuid() });

export const budgetsRouter = Router();
budgetsRouter.use(authenticate);
budgetsRouter.use(companyContext);
budgetsRouter.use(requireResource('budgets'));

function budgetIdOf(req: Request, name = 'id'): string {
  const v = req.params[name];
  if (!v || !z.string().uuid().safeParse(v).success) throw exact.budgetNotFound();
  return v;
}

/** 404 for a budget outside the company (ahead of idempotent(), so a replay still needs it in scope). */
async function budgetInScope(req: Request, _res: Response, next: NextFunction) {
  await exact.budgetForAccess(req.tenantId, req.companyId, budgetIdOf(req));
  next();
}

const LINES_DOC = 'Response adds (budgets-exact-v1) `lines[]` {..., periodsExact[12], totalExact}, `version`, and `totalsExact` '
  + '{revenue|cogs|expenses|otherRevenue|otherExpenses|netIncome: {periodsExact[12], totalExact}} (net income = revenue + other revenue '
  + '- cogs - expenses - other expenses). Exact strings, 4 places.';

/** Lines plus the exact view, the GET /:id/lines shape and every write response. */
async function linesView(req: Request, id: string) {
  const budget = await exact.budgetForAccess(req.tenantId, req.companyId, id);
  const rows = await budgetService.getLines(req.tenantId, id, req.companyId) as Array<Record<string, unknown>>;
  const { perLine, totalsExact } = await exact.linesTotals(req.tenantId, id);
  return {
    budget,
    version: budget.version,
    lines: rows.map((r) => ({ ...r, ...(perLine.get(String(r['account_id'])) ?? {}) })),
    totalsExact,
  };
}

/** The old fill / copy / adjust handlers read no body: a POST without one (no Content-Type) is an empty body. */
function bodyOrEmpty(req: Request, _res: Response, next: NextFunction) {
  if (req.body === undefined || req.body === null) req.body = {};
  next();
}

const replayLines = (message: string) => async (req: Request) => ({ message, ...(await linesView(req, budgetIdOf(req))) });

budgetsRouter.get('/', async (req, res) => {
  const limit = req.query['limit'] ? Number(req.query['limit']) : undefined;
  const offset = req.query['offset'] ? Number(req.query['offset']) : undefined;
  const result = await budgetService.list(req.tenantId, { limit, offset, companyId: req.companyId });
  // Legacy shape `{ budgets }` preserved for existing callers; new
  // pagination metadata added alongside.
  res.json({ budgets: result.data, total: result.total, limit: result.limit, offset: result.offset });
});

budgetsRouter.post('/', describe({
  summary: 'Create a budget',
  description: 'Response 201 `{budget}` (with `version`, budgets-exact-v1). The budget belongs to the request\'s company. Takes Idempotency-Key. '
    + '409 when the tenant already has a budget for the fiscal year.',
}), validate(createBudgetSchema), idempotent({
  successStatus: 201,
  replay: async (req, entity) => ({ budget: await exact.budgetForAccess(req.tenantId, req.companyId, entity!.id) }),
}), async (req, res) => {
  const budget = await budgetService.create(req.tenantId, req.body, req.userId, req.companyId);
  res.status(201).json({ budget });
});

budgetsRouter.get('/:id', async (req, res) => {
  const budget = await budgetService.getById(req.tenantId, budgetIdOf(req), req.companyId);
  res.json({ budget });
});

budgetsRouter.put('/:id', describe({
  summary: 'Change a budget',
  description: 'Body fields as before plus `version` (budgets-exact-v1). Response `{budget}` with the next version. 409 STALE_VERSION '
    + '{details.current}. Takes Idempotency-Key.',
  params: idParams,
}), budgetInScope, idempotent({
  successStatus: 200,
  replay: async (req) => ({ budget: await exact.budgetForAccess(req.tenantId, req.companyId, budgetIdOf(req)) }),
}), validate(updateBudgetSchema), async (req, res) => {
  const budget = await budgetService.update(req.tenantId, budgetIdOf(req), req.body, req.userId, req.companyId);
  res.json({ budget });
});

budgetsRouter.delete('/:id', async (req, res) => {
  await budgetService.remove(req.tenantId, budgetIdOf(req), req.userId, req.companyId);
  res.json({ message: 'Budget deleted' });
});

budgetsRouter.get('/:id/lines', describe({
  summary: 'Budget lines',
  description: `Response \`{lines}\` as before. ${LINES_DOC}`,
  params: idParams,
}), async (req, res) => {
  res.json(await linesView(req, budgetIdOf(req)));
});

budgetsRouter.put('/:id/lines', describe({
  summary: 'Save budget lines',
  description: 'Body `{version?, lines: [{accountId, month1..month12}]}` (budgets-exact-v1 validation): P&L accounts of the company only, '
    + 'cells with at most 2 decimal places, periods month1..month12, an account once; else 400 BUDGET_LINE_INVALID {details.index, '
    + `details.field}. 409 STALE_VERSION {details.current}. Takes Idempotency-Key. Response \`{message, budget, version, lines, totalsExact}\`. ${LINES_DOC}`,
  params: idParams,
}), budgetInScope, idempotent({ successStatus: 200, replay: replayLines('Lines saved') }),
validate(linesBodySchema), describe({ body: linesBodyDoc }), async (req, res) => {
  const id = budgetIdOf(req);
  await budgetService.updateLines(req.tenantId, id, req.body.lines, { companyId: req.companyId, version: req.body.version, userId: req.userId });
  res.json({ message: 'Lines saved', ...(await linesView(req, id)) });
});

budgetsRouter.post('/:id/fill-from-actuals', describe({
  summary: 'Fill a budget from last year\'s actuals',
  description: 'Each P&L account\'s actual for the twelve months before the budget\'s fiscal year (the company\'s lines, the budget\'s tag '
    + 'when it has one, natural sign), computed in Decimal and rounded to the cent, half away from zero. Body `{version?, basis?}`. '
    + `409 STALE_VERSION. Takes Idempotency-Key. Response \`{message, ...lines}\`. ${LINES_DOC}`,
  params: idParams,
}), budgetInScope, idempotent({ successStatus: 200, replay: replayLines('Filled from actuals') }),
bodyOrEmpty, validate(fillBodySchema), async (req, res) => {
  const id = budgetIdOf(req);
  await budgetService.fillFromActuals(req.tenantId, id, { companyId: req.companyId, version: req.body.version, basis: req.body.basis, userId: req.userId });
  res.json({ message: 'Filled from actuals', ...(await linesView(req, id)) });
});

budgetsRouter.post('/:id/copy-from/:sourceId', describe({
  summary: 'Copy another budget\'s lines',
  description: `The source's lines replace all of the target's lines (U-211; accounts not on the source are removed). Body \`{version?}\` (the target's). 409 STALE_VERSION changes nothing. Takes Idempotency-Key. Response \`{message, ...lines}\`. ${LINES_DOC}`,
  params: z.object({ id: z.string().uuid(), sourceId: z.string().uuid() }),
}), budgetInScope, idempotent({ successStatus: 200, replay: replayLines('Copied from source budget') }),
bodyOrEmpty, validate(versionBodySchema), async (req, res) => {
  const id = budgetIdOf(req);
  await budgetService.copyFromBudget(req.tenantId, id, budgetIdOf(req, 'sourceId'), { companyId: req.companyId, version: req.body.version, userId: req.userId });
  res.json({ message: 'Copied from source budget', ...(await linesView(req, id)) });
});

budgetsRouter.post('/:id/adjust-by-percent', describe({
  summary: 'Adjust every budget cell by a percent',
  description: 'Each cell times (1 + percent / 100) in Decimal, rounded to the cent, half away from zero. Body `{percent, version?}`; '
    + `a bad percent is 400 VALIDATION_ERROR. 409 STALE_VERSION. Takes Idempotency-Key. Response \`{message, ...lines}\`. ${LINES_DOC}`,
  params: idParams,
}), budgetInScope, idempotent({ successStatus: 200, replay: replayLines('Adjustment applied') }),
bodyOrEmpty, validate(adjustBodySchema), async (req, res) => {
  const id = budgetIdOf(req);
  await budgetService.adjustByPercent(req.tenantId, id, req.body.percent, { companyId: req.companyId, version: req.body.version, userId: req.userId });
  res.json({ message: 'Adjustment applied', ...(await linesView(req, id)) });
});

// ── Budget vs. Actual, exact (budgets-exact-v1) ────────────────────

function bad(param: string, message: string): AppError {
  return AppError.badRequest(message, 'INVALID_PARAM', { param });
}

function readAdjustingParam(req: Request): 'include' | 'exclude' | 'only' {
  const v = qs(req, 'adjusting');
  if (v === undefined || v === 'include' || v === 'exclude' || v === 'only') return v ?? 'include';
  throw bad('adjusting', 'adjusting must be include, exclude or only');
}

const BVA_EXACT_PARAMS = ['period_ranges', 'first_period', 'tag_split', 'tag_group_id', 'basis', 'adjusting'];

const BVA_DOC = 'With exact=1 (budgets-exact-v1): period_ranges=YYYY-MM-DD..YYYY-MM-DD,… (at most 12, in date order, not overlapping) gives '
  + 'each budget period\'s dates (4-4-5 or calendar months, from the caller\'s fiscal calendar); range i is budget period first_period + i '
  + '(first_period 1..12, default 1), taken whole. Without period_ranges: the twelve calendar months from the budget\'s fiscal year start. '
  + 'Actuals: the P&L\'s lines for the basis, adjusting filter and company (scope=consolidated: every company), matched by account id, '
  + 'the budget\'s tag when it has one, summed in Decimal. Rows: every P&L account with a budget or activity in the periods, in sections '
  + 'revenue / cogs / expenses / otherRevenue / otherExpenses, with parentAccountId, depth (zero ancestors added) and rollupCells on '
  + 'parents. Each row has cells[] aligned with columns[] (the periods, then Total): {actualExact, budgetExact, overExact (actual - '
  + 'budget), pctOfBudgetExact (actual / budget x 100, 1 place, half away from zero, null on a zero budget)}. totalsExact {totalRevenue, '
  + 'totalCogs, totalExpenses, totalOtherRevenue, totalOtherExpenses, grossProfit (null without cogs rows), netIncome}: cells[] each. '
  + 'tag_split=1&tag_group_id=: under each account rowKind account = actual of lines without a tag from the group, tag = one per group '
  + 'tag with activity, account_total = the whole account; the budget is per account, so budgetExact / overExact / pctOfBudgetExact '
  + 'are null on account and tag rows and set on account_total (and the totals). A cell drills to GET /reports/general-ledger with '
  + 'drillTarget.params + column.drill + row.drill (exact=1); its actualExact is that ledger\'s netChangeExact. Response {title, layout: '
  + "'budget_vs_actual', budget {id, name, fiscalYear, fiscalYearStart, tagId, version}, basis, firstPeriod, startDate, endDate, columns "
  + '[{key, caption, kind period|total, periodIndex, from, to, drill}], sections, totalsExact, tagSplit, drillTarget, meta}. Errors 400 '
  + 'INVALID_PARAM / INVALID_DATE_RANGE {details.param} (incl. ranges past period 12, tag_split on a budget for one tag, start_date / '
  + 'end_date with exact=1), 404 budget or tag group. Without exact=1 the response is unchanged (start_date / end_date, accrual).';

budgetsRouter.get('/:id/vs-actual', describe({
  summary: 'Budget vs. Actual',
  description: BVA_DOC,
  params: idParams,
  query: z.object({
    exact: z.enum(['1', '0', 'true', 'false']).optional(),
    period_ranges: z.string().optional(),
    first_period: z.string().optional().describe('1..12, default 1'),
    basis: z.enum(['accrual', 'cash']).optional(),
    adjusting: z.enum(['include', 'exclude', 'only']).optional(),
    scope: z.enum(['consolidated']).optional(),
    tag_split: z.enum(['1', '0']).optional(),
    tag_group_id: z.string().uuid().optional(),
    start_date: z.string().optional().describe('Without exact=1 only'),
    end_date: z.string().optional().describe('Without exact=1 only'),
    format: z.enum(['csv', 'pdf']).optional().describe('Without exact=1 only'),
  }),
}), async (req, res, next) => {
  const isExact = readExact(req);
  const exported = req.query['format'] !== undefined && req.query['format'] !== '';
  if (!isExact || exported) {
    const hit = BVA_EXACT_PARAMS.find((p) => req.query[p] !== undefined && req.query[p] !== '' && p !== 'basis' && p !== 'adjusting');
    if (hit) throw bad(hit, `${hit} needs exact=1 and no export format (budgets-exact-v1)`);
    next();
    return;
  }
  if (qs(req, 'start_date') !== undefined || qs(req, 'end_date') !== undefined) {
    throw bad(qs(req, 'start_date') !== undefined ? 'start_date' : 'end_date', 'with exact=1 use period_ranges (whole budget periods)');
  }
  const ranges = readPeriodRanges(req);
  if (ranges && ranges.length > exact.PERIODS) throw bad('period_ranges', `period_ranges takes at most ${exact.PERIODS} ranges`);
  const firstPeriod = posInt(req, 'first_period', exact.PERIODS) ?? 1;
  const tagSplit = flag(req, 'tag_split');
  const groupId = uuidQuery(req, 'tag_group_id', false) ?? null;
  if (tagSplit && !groupId) throw bad('tag_group_id', 'tag_split needs tag_group_id');
  if (!tagSplit && groupId) throw bad('tag_group_id', 'tag_group_id needs tag_split=1');
  const b = readBasis(req);
  const adjusting = readAdjustingParam(req);
  const consolidated = req.query['scope'] === 'consolidated';
  const data = await exact.buildBudgetVsActualExact(req.tenantId, budgetIdOf(req), {
    companyId: req.companyId, consolidated, ranges, firstPeriod, basis: b, adjusting, tagSplitGroupId: tagSplit ? groupId : null,
  }).catch((e: unknown) => {
    if (e instanceof exact.BvaParamError) throw e.code === 'NOT_FOUND' ? AppError.notFound(e.message) : bad(e.param, e.message);
    throw e;
  });
  res.json(normalizeReportDates({
    ...data,
    drillTarget: {
      path: '/reports/general-ledger', amount: 'netChangeExact',
      params: {
        basis: b, adjusting,
        ...(consolidated ? { scope: 'consolidated' } : {}),
        ...(data.budget.tagId ? { tag_id: data.budget.tagId } : {}),
      },
    },
    meta: reportMeta({ basis: b, from: data.startDate, to: data.endDate, reportSchemaVersion: REPORT_SCHEMA_VERSION }),
  }));
});

// Legacy Budget vs. Actual (without exact=1): unchanged, except that the
// budget must be the company's (or have no company).
budgetsRouter.get('/:id/vs-actual', budgetInScope, async (req, res) => {
  const { start_date, end_date, format } = req.query as Record<string, string>;
  const today = new Date();
  const data = await budgetService.buildBudgetVsActual(
    req.tenantId, req.params['id']!,
    start_date || `${today.getFullYear()}-01-01`,
    end_date || today.toISOString().split('T')[0]!,
  );

  if (format === 'csv' || format === 'pdf') {
    // Build export rows
    const fmtN = (n: any) => { const v = parseFloat(n); return isNaN(v) ? '' : v.toFixed(2); };
    const fmtP = (n: any) => { if (n === null || n === undefined || !isFinite(n)) return ''; return `${n >= 0 ? '+' : ''}${parseFloat(n).toFixed(1)}%`; };
    const columns = [
      { key: 'account', label: 'Account' },
      { key: 'budget', label: 'Budget' },
      { key: 'actual', label: 'Actual' },
      { key: 'variance', label: '$ Variance' },
      { key: 'pct', label: '% Variance' },
    ];
    // Row shape used by both PDF export and the HTML table generator
    // downstream. Includes the index signature because the HTML helper
    // does dynamic key lookups against the `columns` map above; without
    // it TS complains on `row[col.key]` access in the body builder.
    interface VarianceRow {
      _section?: boolean;
      _total?: boolean;
      account: string;
      budget: string;
      actual: string;
      variance: string;
      pct: string;
      [key: string]: unknown;
    }
    interface VarianceDetail {
      accountName: string;
      budget: number | string;
      actual: number | string;
      varianceDollar: number | string;
      // The aggregator emits `null` when the budget is zero (% is
      // undefined in that case); the formatter handles null safely.
      variancePercent: number | string | null;
    }
    const rows: VarianceRow[] = [];
    const section = (label: string) => rows.push({ _section: true, account: label, budget: '', actual: '', variance: '', pct: '' });
    const detailRow = (r: VarianceDetail) => rows.push({
      account: r.accountName,
      budget: fmtN(r.budget),
      actual: fmtN(r.actual),
      variance: fmtN(r.varianceDollar),
      pct: fmtP(r.variancePercent),
    });
    const totalRow = (label: string, budget: number, actual: number) => rows.push({
      _total: true,
      account: label,
      budget: fmtN(budget),
      actual: fmtN(actual),
      variance: fmtN(actual - budget),
      pct: '',
    });

    const hasCogs = (data.cogs?.length ?? 0) > 0;
    const hasOtherRev = (data.otherRevenue?.length ?? 0) > 0;
    const hasOtherExp = (data.otherExpenses?.length ?? 0) > 0;

    const L = (data as any).labels as import('@kis-books/shared').PLSectionLabels | undefined;
    const revenueLabel = L?.revenue || 'Revenue';
    const cogsLabel = L?.cogs || 'Cost of Goods Sold';
    const grossProfitLabel = L?.grossProfit || 'Gross Profit';
    const expensesLabel = L?.expenses || 'Expenses';
    const otherRevenueLabel = L?.otherRevenue || 'Other Revenue';
    const otherExpensesLabel = L?.otherExpenses || 'Other Expenses';
    const netIncomeLabel = L?.netIncome || 'Net Income';

    section(`--- ${revenueLabel.toUpperCase()} ---`);
    for (const r of data.revenue) detailRow(r);
    totalRow(`Total ${revenueLabel}`, data.totalRevenueBudget, data.totalRevenueActual);

    if (hasCogs) {
      section(`--- ${cogsLabel.toUpperCase()} ---`);
      for (const r of data.cogs) detailRow(r);
      totalRow(`Total ${cogsLabel}`, data.totalCogsBudget, data.totalCogsActual);
      totalRow(grossProfitLabel,
        data.totalRevenueBudget - data.totalCogsBudget,
        data.totalRevenueActual - data.totalCogsActual);
    }

    section(`--- ${expensesLabel.toUpperCase()} ---`);
    for (const e of data.expenses) detailRow(e);
    totalRow(`Total ${expensesLabel}`, data.totalExpenseBudget, data.totalExpenseActual);

    if (hasOtherRev) {
      section(`--- ${otherRevenueLabel.toUpperCase()} ---`);
      for (const r of data.otherRevenue) detailRow(r);
      totalRow(`Total ${otherRevenueLabel}`, data.totalOtherRevenueBudget, data.totalOtherRevenueActual);
    }

    if (hasOtherExp) {
      section(`--- ${otherExpensesLabel.toUpperCase()} ---`);
      for (const r of data.otherExpenses) detailRow(r);
      totalRow(`Total ${otherExpensesLabel}`, data.totalOtherExpenseBudget, data.totalOtherExpenseActual);
    }

    totalRow(netIncomeLabel.toUpperCase(), data.netIncomeBudget, data.netIncomeActual);

    if (format === 'csv') {
      const { toCsv } = await import('../services/report-export.service.js');
      const csv = toCsv(rows, columns);
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="Budget_vs_Actual.csv"');
      return res.send(csv);
    }
    // PDF
    const { toReportHtml, toPdf, escapeHtml } = await import('../services/report-export.service.js');
    const header = columns.map((c) => `<th>${escapeHtml(c.label)}</th>`).join('');
    const body = rows.map((r) => {
      const first = r.account;
      const style = r._section ? ' style="background:#f3f4f6;font-weight:600"' : r._total ? ' style="font-weight:700;border-top:2px solid #111"' : '';
      return `<tr${style}>${columns.map((c) => {
        const val = r._section && c.key === 'account'
          ? first.replace(/^---\s*|\s*---$/g, '')
          : r[c.key];
        return `<td${c.key !== 'account' ? ' class="amount"' : ''}>${escapeHtml(val || '')}</td>`;
      }).join('')}</tr>`;
    }).join('');
    const tableHtml = `<table><thead><tr>${header}</tr></thead><tbody>${body}</tbody></table>`;
    const html = toReportHtml(data.title || 'Budget vs Actual', 'Company', `${data.startDate} to ${data.endDate}`, tableHtml);
    const pdf = await toPdf(html);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="Budget_vs_Actual.pdf"');
    return res.send(pdf);
  }

  res.json(data);
});

budgetsRouter.get('/:id/overview', budgetInScope, async (req, res) => {
  const data = await budgetService.buildBudgetOverview(req.tenantId, req.params['id']!);
  res.json(data);
});

// ADR 0XW — tag-scoped Budget vs. Actuals. Respects the budget's tag_id
// scope when aggregating actuals from journal_lines. Requires the
// TAG_BUDGETS_V1 env flag to be enabled. Returns a per-account,
// per-month matrix with variances.
budgetsRouter.get('/:id/tag-actuals', budgetInScope, async (req, res) => {
  // Actuals stay tenant-wide, as before the router had a company context
  // (authenticate never set req.companyId, so this passed null).
  const data = await budgetService.runTagScopedBudgetVsActuals(
    req.tenantId,
    req.params['id']!,
    null,
  );
  res.json(data);
});
