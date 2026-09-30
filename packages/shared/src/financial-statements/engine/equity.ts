// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Statement of changes in equity / retained earnings. Roll-forward from
// the closed balance sheet at the fiscal-year opening to the closed
// balance sheet at period end, split by equity role (the same roles the
// M-2 schedule uses). Corporations get one column per equity account
// (retained earnings + distributions share a column); pass-throughs get
// a single column. Ending balances are anchored to the rounded balance
// sheet so the two statements always agree.

import type { FsEntityKind, FsStatementConfig } from '../schemas.js';
import type { FsColumnDef, FsRenderedStatement, FsRow } from '../model.js';
import type { Balances, EngineCtx } from './context.js';
import { applyDollarSigns, formulaOf } from './face.js';
import { compareAccountNumbers, roundTo, toDisplay } from './util.js';
import { fsLongDate } from '../titles.js';

export interface EquityInputs {
  title: string;
  dateLine: string;
  // Rounded net income (credit-positive) per year from the income statement.
  niRounded: { cy: number | null; py: number | null };
  // Rounded total equity per year from the balance sheet (credit-positive),
  // null when the balance sheet can't isolate equity lines.
  equityTarget: { cy: number | null; py: number | null };
  openDates: { cy: string; py: string | null };
  closeDates: { cy: string; py: string | null };
}

interface Col { key: string; caption: string; accounts: string[]; hasFold: boolean }

const ROWS = ['begin', 'ni', 'contrib', 'dist', 'other', 'end'] as const;
type RowKey = (typeof ROWS)[number];

function captionsFor(entity: FsEntityKind) {
  return {
    contributions: entity === 'corporation' ? 'Capital contributions' : entity === 'partnership' ? 'Partner contributions' : entity === 'llc' ? 'Member contributions' : 'Owner contributions',
    distributions: entity === 'corporation' ? 'Distributions to shareholders' : entity === 'partnership' ? 'Partner distributions' : entity === 'llc' ? 'Member distributions' : 'Owner withdrawals',
  };
}

export interface EquityRollforward {
  cols: Col[];
  years: Array<'py' | 'cy'>;
  rounded: Record<string, Record<RowKey, number[]>>;
  // Net income each year's roll-forward needs so the rounded ending equity
  // equals the rounded balance sheet (credit-positive).
  niTarget: { cy: number | null; py: number | null };
}

export function equityRollforward(
  ctx: EngineCtx,
  stmt: Pick<FsStatementConfig, 'id' | 'equity'>,
  inp: Pick<EquityInputs, 'niRounded' | 'equityTarget'>,
  quiet = false,
): EquityRollforward | null {
  const entity = ctx.source.entityKind;
  const fold = ctx.source.reAccountId;
  const roleOf = (id: string) => (id === fold ? 'retained' : ctx.source.equityRoles[id] ?? 'other');
  const isEquity = (id: string) => ctx.accounts.get(id)?.accountType === 'equity';

  const years: Array<'py' | 'cy'> = [];
  if (ctx.comparative && ctx.bsClosed('py')) years.push('py');
  if (ctx.bsClosed('cy')) years.push('cy');
  if (!years.length) return null;

  const openOf = (y: 'cy' | 'py'): Balances => ctx.bsClosed(y === 'cy' ? 'cyOpen' : 'pyOpen') ?? new Map();
  const closeOf = (y: 'cy' | 'py'): Balances => ctx.bsClosed(y)!;

  const ids = new Set<string>();
  for (const y of years) {
    for (const m of [openOf(y), closeOf(y)]) for (const [id, v] of m) if (isEquity(id) && v !== 0) ids.add(id);
  }
  ids.add(fold);

  const mode = stmt.equity?.columns ?? 'auto';
  const byAccount = mode === 'by_account' || (mode === 'auto' && entity === 'corporation');
  const colCaption = (id: string, fallback: string) => stmt.equity?.columnCaptions?.[id] ?? fallback;
  let cols: Col[];
  if (byAccount) {
    const reAccts = [...ids].filter((id) => id === fold || roleOf(id) === 'retained' || roleOf(id) === 'distributions');
    const others = [...ids].filter((id) => !reAccts.includes(id)).map((id) => ctx.accounts.get(id)!).sort(compareAccountNumbers);
    cols = others.map((a) => ({ key: a.id, caption: colCaption(a.id, a.name), accounts: [a.id], hasFold: false }));
    cols.push({ key: fold, caption: colCaption(fold, 'Retained Earnings'), accounts: reAccts, hasFold: true });
  } else {
    cols = [{ key: 'all', caption: '', accounts: [...ids], hasFold: true }];
  }
  const foldCol = cols.findIndex((c) => c.hasFold);

  const exact: Record<string, Record<RowKey, number[]>> = {};
  for (const y of years) {
    const open = openOf(y);
    const close = closeOf(y);
    const niSigned = [...(ctx.plActivityUntagged(y) ?? new Map()).values()].reduce((s, v) => s + v, 0);
    const r: Record<RowKey, number[]> = { begin: [], ni: [], contrib: [], dist: [], other: [], end: [] };
    for (const col of cols) {
      let begin = 0; let end = 0; let dist = 0; let contrib = 0;
      for (const id of col.accounts) {
        const o = open.get(id) ?? 0;
        const c = close.get(id) ?? 0;
        begin += -o;
        end += -c;
        const role = roleOf(id);
        if (role === 'distributions') dist += -(c - o);
        else if (role === 'contributions') contrib += -(c - o);
      }
      const ni = col.hasFold ? -niSigned : 0;
      r.begin.push(begin); r.end.push(end); r.ni.push(ni); r.dist.push(dist); r.contrib.push(contrib);
      r.other.push(end - begin - ni - dist - contrib);
    }
    exact[y] = r;
  }

  const rounded: Record<string, Record<RowKey, number[]>> = {};
  const niTarget: { cy: number | null; py: number | null } = { cy: null, py: null };
  let prevEnd: number[] | null = null;
  for (const y of years) {
    const e = exact[y]!;
    const r: Record<RowKey, number[]> = {
      begin: prevEnd ? [...prevEnd] : e.begin.map((v) => roundTo(v, ctx.unit)),
      ni: e.ni.map(() => 0),
      contrib: e.contrib.map((v) => roundTo(v, ctx.unit)),
      dist: e.dist.map((v) => roundTo(v, ctx.unit)),
      other: e.other.map((v) => roundTo(v, ctx.unit)),
      end: new Array(cols.length).fill(0),
    };
    const plugInto = (ci: number, diff: number) => {
      const cand = (['other', 'dist', 'contrib'] as const)
        .map((k) => ({ k, mag: Math.abs(e[k][ci] ?? 0) }))
        .sort((a, b) => b.mag - a.mag)[0]!;
      const k = cand.mag === 0 ? 'other' : cand.k;
      r[k][ci] = (r[k][ci] ?? 0) + diff;
    };
    const colSum = (ci: number) => r.begin[ci]! + r.ni[ci]! + r.contrib[ci]! + r.dist[ci]! + r.other[ci]!;
    // Non-fold columns (stock, APIC …) tie to their own rounded ending.
    for (let ci = 0; ci < cols.length; ci++) {
      if (ci === foldCol) continue;
      const target = roundTo(e.end[ci]!, ctx.unit);
      if (colSum(ci) !== target) plugInto(ci, target - colSum(ci));
      r.end[ci] = colSum(ci);
    }
    const others = r.end.reduce((s, v, ci) => (ci === foldCol ? s : s + v), 0);
    const totalTarget = inp.equityTarget[y] ?? roundTo(e.end.reduce((s, v) => s + v, 0), ctx.unit);
    const foldEnd = totalTarget - others;
    const withoutNi = colSum(foldCol);
    // The income statement's rounded net income makes the fold column
    // land exactly on the balance sheet; derive it when not supplied.
    const niGiven = inp.niRounded[y];
    r.ni[foldCol] = niGiven ?? foldEnd - withoutNi;
    niTarget[y] = foldEnd - withoutNi;
    if (colSum(foldCol) !== foldEnd) {
      plugInto(foldCol, foldEnd - colSum(foldCol));
      if (!quiet) ctx.checks.push({ code: 'TB_FS_EQUITY_ROUNDING', severity: 'info', statementId: stmt.id, message: 'A rounding difference was placed in the equity statement because net income was rounded independently.' });
    }
    r.end[foldCol] = colSum(foldCol);
    if (inp.equityTarget[y] === null && !quiet) {
      ctx.checks.push({ code: 'TB_FS_EQUITY_NOT_TIED', severity: 'info', statementId: stmt.id, message: 'Equity is shown on a balance-sheet line that also holds non-equity accounts, so the equity statement is rounded independently.' });
    }
    rounded[y] = r;
    prevEnd = r.end;
  }
  return { cols, years, rounded, niTarget };
}

export function buildEquity(ctx: EngineCtx, stmt: FsStatementConfig, inp: EquityInputs): FsRenderedStatement | null {
  const rf = equityRollforward(ctx, stmt, inp);
  if (!rf) return null;
  const { cols, years, rounded } = rf;
  const entity = ctx.source.entityKind;

  // Columns (+ Total when several).
  const showTotal = cols.length > 1;
  const columns: FsColumnDef[] = cols.map((c) => ({ key: c.key, label: c.caption, kind: 'amount' as const }));
  if (showTotal) columns.push({ key: 'total', label: stmt.equity?.captions?.total ?? 'Total', kind: 'amount' });
  const withTotal = (vals: number[]): Array<number | null> => (showTotal ? [...vals, vals.reduce((s, v) => s + v, 0)] : vals).map((v) => v);

  const cap = { ...captionsFor(entity), ...stmt.equity?.captions };
  const rows: FsRow[] = [];
  const mk = (key: string, caption: string, vals: number[], kind: FsRow['kind'], extra: Partial<FsRow> = {}): FsRow => ({
    key, kind, caption, level: kind === 'detail' ? 1 : 0, styleRole: kind === 'detail' ? 'detail' : kind === 'total' ? 'total' : 'subtotal',
    values: withTotal(vals).map((v) => (v === null ? null : toDisplay(v))), dollarSign: false, ruleAbove: 'none', ruleBelow: 'none', ...extra,
  });
  years.forEach((y, yi) => {
    const r = rounded[y]!;
    const last = yi === years.length - 1;
    const beginDate = fsLongDate(inp.openDates[y] ?? inp.openDates.cy);
    const endDate = fsLongDate(inp.closeDates[y] ?? inp.closeDates.cy);
    const blockStart = rows.length;
    if (yi === 0) rows.push(mk(`${y}:begin`, cap.beginning ?? `Balance, ${beginDate}`, r.begin, 'subtotal'));
    const activity: Array<[RowKey, string]> = [
      ['ni', cap.netIncome ?? 'Net income'],
      ['contrib', cap.contributions],
      ['dist', cap.distributions],
      ['other', cap.other ?? 'Other changes'],
    ];
    for (const [k, caption] of activity) {
      if (k !== 'ni' && r[k].every((v) => v === 0)) continue;
      rows.push(mk(`${y}:${k}`, caption, r[k], 'detail'));
    }
    const termRows = rows.slice(yi === 0 ? blockStart : blockStart - 1).map((_, i) => (yi === 0 ? blockStart : blockStart - 1) + i);
    rows.push(mk(`${y}:end`, cap.ending ?? `Balance, ${endDate}`, r.end, last ? 'total' : 'subtotal', {
      ruleAbove: 'single', ruleBelow: last ? 'double' : 'none', formula: formulaOf(termRows.map((row) => ({ row, sign: 1 }))),
    }));
  });
  applyDollarSigns(ctx, rows);

  const pageSetup = { ...ctx.style.page, ...(stmt.pageSetup ?? {}), margins: { ...ctx.style.page.margins, ...(stmt.pageSetup?.margins ?? {}) } };
  return { id: stmt.id, kind: 'equity', title: inp.title, dateLine: inp.dateLine, pageSetup, columns, rows };
}
