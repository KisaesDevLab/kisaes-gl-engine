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
import { applyDollarSigns, formulaOf, fsStatementPageSetup } from './face.js';
import { fsAddDays, type FsPlanRange } from '../periods.js';
import { compareAccountNumbers, roundTo, toDisplay } from './util.js';
import { fsLongDate } from '../titles.js';

export const rangeId = (r: { start: string; end: string }) => `${r.start}|${r.end}`;

export interface EquityInputs {
  title: string;
  dateLine: string;
  // Rounded net income (credit-positive) from the income statement, by
  // range id (start|end).
  niRounded: Map<string, number | null>;
  // Rounded total equity (credit-positive) at balance-sheet dates, when
  // the balance sheet isolates equity on its own lines.
  equityTarget: Map<string, number | null>;
}

interface Col { key: string; caption: string; accounts: string[]; hasFold: boolean }

type RowKey = 'begin' | 'ni' | 'contrib' | 'dist' | 'other' | 'end';

function captionsFor(entity: FsEntityKind) {
  return {
    contributions: entity === 'corporation' ? 'Capital contributions' : entity === 'partnership' ? 'Partner contributions' : entity === 'llc' ? 'Member contributions' : 'Owner contributions',
    distributions: entity === 'corporation' ? 'Distributions to shareholders' : entity === 'partnership' ? 'Partner distributions' : entity === 'llc' ? 'Member distributions' : 'Owner withdrawals',
  };
}

interface Block { range: FsPlanRange; openDate: string; contiguous: boolean }

export interface EquityRollforward {
  cols: Col[];
  blocks: Block[];
  rounded: Map<string, Record<RowKey, number[]>>;
  // Net income each block needs so its rounded ending equity equals the
  // rounded balance sheet, by range id.
  niTarget: Map<string, number>;
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

  const blocks: Block[] = [];
  for (const range of ctx.plan.equityBlocks) {
    if (!ctx.bsClosed(range.end)) continue;
    const openDate = fsAddDays(range.start, -1);
    const prev = blocks[blocks.length - 1];
    blocks.push({ range, openDate, contiguous: !!prev && prev.range.end === openDate });
  }
  if (!blocks.length) return null;

  const openOf = (b: Block): Balances => ctx.bsClosed(b.openDate, 'open') ?? new Map();
  const closeOf = (b: Block): Balances => ctx.bsClosed(b.range.end)!;

  const ids = new Set<string>();
  for (const b of blocks) {
    for (const m of [openOf(b), closeOf(b)]) for (const [id, v] of m) if (isEquity(id) && v !== 0) ids.add(id);
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

  const rounded = new Map<string, Record<RowKey, number[]>>();
  const niTarget = new Map<string, number>();
  let prevEnd: number[] | null = null;
  for (const b of blocks) {
    const open = openOf(b);
    const close = closeOf(b);
    const niSigned = [...(ctx.plActivityUntagged(b.range) ?? new Map()).values()].reduce((s, v) => s + v, 0);
    const e: Record<RowKey, number[]> = { begin: [], ni: [], contrib: [], dist: [], other: [], end: [] };
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
      e.begin.push(begin); e.end.push(end); e.ni.push(ni); e.dist.push(dist); e.contrib.push(contrib);
      e.other.push(end - begin - ni - dist - contrib);
    }

    const r: Record<RowKey, number[]> = {
      begin: b.contiguous && prevEnd ? [...prevEnd] : e.begin.map((v) => roundTo(v, ctx.unit)),
      ni: e.ni.map(() => 0),
      contrib: e.contrib.map((v) => roundTo(v, ctx.unit)),
      dist: e.dist.map((v) => roundTo(v, ctx.unit)),
      other: e.other.map((v) => roundTo(v, ctx.unit)),
      end: new Array(cols.length).fill(0),
    };
    // A fresh beginning ties to the rounded balance sheet at that date
    // when one is shown (difference lands in the fold column).
    const beginTarget = !b.contiguous ? inp.equityTarget.get(b.openDate) ?? null : null;
    if (beginTarget !== null && beginTarget !== undefined) {
      const tot = r.begin.reduce((sum, v) => sum + v, 0);
      r.begin[foldCol] = (r.begin[foldCol] ?? 0) + (beginTarget - tot);
    }
    const plugInto = (ci: number, diff: number) => {
      const cand = (['other', 'dist', 'contrib'] as const)
        .map((k) => ({ k, mag: Math.abs(e[k][ci] ?? 0) }))
        .sort((x, y) => y.mag - x.mag)[0]!;
      const k = cand.mag === 0 ? 'other' : cand.k;
      r[k][ci] = (r[k][ci] ?? 0) + diff;
    };
    const colSum = (ci: number) => r.begin[ci]! + r.ni[ci]! + r.contrib[ci]! + r.dist[ci]! + r.other[ci]!;
    for (let ci = 0; ci < cols.length; ci++) {
      if (ci === foldCol) continue;
      const target = roundTo(e.end[ci]!, ctx.unit);
      if (colSum(ci) !== target) plugInto(ci, target - colSum(ci));
      r.end[ci] = colSum(ci);
    }
    const others = r.end.reduce((sum, v, ci) => (ci === foldCol ? sum : sum + v), 0);
    const eqTarget = inp.equityTarget.get(b.range.end);
    const totalTarget = eqTarget ?? roundTo(e.end.reduce((sum, v) => sum + v, 0), ctx.unit);
    const foldEnd = totalTarget - others;
    const withoutNi = colSum(foldCol);
    const id = rangeId(b.range);
    const given = inp.niRounded.get(id);
    r.ni[foldCol] = given ?? foldEnd - withoutNi;
    niTarget.set(id, foldEnd - withoutNi);
    if (colSum(foldCol) !== foldEnd) {
      plugInto(foldCol, foldEnd - colSum(foldCol));
      if (!quiet) ctx.checks.push({ code: 'TB_FS_EQUITY_ROUNDING', severity: 'info', statementId: stmt.id, message: 'A rounding difference was placed in the equity statement because net income was rounded independently.' });
    }
    r.end[foldCol] = colSum(foldCol);
    if ((eqTarget === null || eqTarget === undefined) && ctx.plan.bsPoints.some((p) => p.date === b.range.end) && !quiet) {
      ctx.checks.push({ code: 'TB_FS_EQUITY_NOT_TIED', severity: 'info', statementId: stmt.id, message: 'Equity is shown on a balance-sheet line that also holds non-equity accounts, so the equity statement is rounded independently.' });
    }
    rounded.set(id, r);
    prevEnd = r.end;
  }
  return { cols, blocks, rounded, niTarget };
}

export function buildEquity(ctx: EngineCtx, stmt: FsStatementConfig, inp: EquityInputs): FsRenderedStatement | null {
  const rf = equityRollforward(ctx, stmt, inp);
  if (!rf) return null;
  const { cols, blocks, rounded } = rf;
  const entity = ctx.source.entityKind;

  // Columns (+ Total when several).
  const showTotal = cols.length > 1;
  const columns: FsColumnDef[] = cols.map((c) => ({ key: c.key, label: c.caption, kind: 'amount' as const }));
  if (showTotal) columns.push({ key: 'total', label: stmt.equity?.captions?.total ?? 'Total', kind: 'amount' });
  const withTotal = (vals: number[]): number[] => (showTotal ? [...vals, vals.reduce((sum, v) => sum + v, 0)] : vals);

  const cap = { ...captionsFor(entity), ...stmt.equity?.captions };
  const rows: FsRow[] = [];
  const mk = (key: string, caption: string, vals: number[], kind: FsRow['kind'], extra: Partial<FsRow> = {}): FsRow => ({
    key, kind, caption, level: kind === 'detail' ? 1 : 0, styleRole: kind === 'detail' ? 'detail' : kind === 'total' ? 'total' : 'subtotal',
    values: withTotal(vals).map((v) => toDisplay(v)), dollarSign: false, ruleAbove: 'none', ruleBelow: 'none', ...extra,
  });
  blocks.forEach((b, bi) => {
    const id = rangeId(b.range);
    const r = rounded.get(id)!;
    const last = bi === blocks.length - 1;
    let firstTermRow: number;
    if (b.contiguous) {
      firstTermRow = rows.length - 1; // previous block's ending row
    } else {
      if (bi > 0) rows.push({ key: `${id}:gap`, kind: 'blank', caption: '', level: 0, styleRole: 'text', values: columns.map(() => null), dollarSign: false, ruleAbove: 'none', ruleBelow: 'none' });
      firstTermRow = rows.length;
      rows.push(mk(`${id}:begin`, cap.beginning ?? `Balance, ${fsLongDate(b.openDate)}`, r.begin, 'subtotal'));
    }
    const activity: Array<[RowKey, string]> = [
      ['ni', cap.netIncome ?? 'Net income'],
      ['contrib', cap.contributions],
      ['dist', cap.distributions],
      ['other', cap.other ?? 'Other changes'],
    ];
    for (const [k, caption] of activity) {
      if (k !== 'ni' && r[k].every((v) => v === 0)) continue;
      rows.push(mk(`${id}:${k}`, caption, r[k], 'detail'));
    }
    const termRows: number[] = [];
    for (let i = firstTermRow; i < rows.length; i++) termRows.push(i);
    rows.push(mk(`${id}:end`, cap.ending ?? `Balance, ${fsLongDate(b.range.end)}`, r.end, last || !blocks[bi + 1]?.contiguous ? 'total' : 'subtotal', {
      ruleAbove: 'single', ruleBelow: last || !blocks[bi + 1]?.contiguous ? 'double' : 'none', formula: formulaOf(termRows.map((row) => ({ row, sign: 1 }))),
    }));
  });
  applyDollarSigns(ctx, rows);

  const pageSetup = fsStatementPageSetup(ctx, stmt as FsStatementConfig, columns);
  return { id: stmt.id, kind: 'equity', title: inp.title, dateLine: inp.dateLine, pageSetup, columns, rows };
}
