// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Statement of cash flows — indirect method. Every non-cash balance sheet
// account contributes −Δ(closed balance) between the fiscal-year opening
// and period end, classified operating / noncash adjustment / investing /
// financing (per-account override → per-leadsheet override → default by
// leadsheet code → account type). The retained-earnings fold account's
// change excludes the year's net income, which starts the statement.
// Because a closed trial balance nets to zero, net income + every
// classified change = Δcash exactly; anything classified 'excluded'
// surfaces as TB_FS_CF_UNRECONCILED.

import type { FsCashFlowClass, FsStatementConfig } from '../schemas.js';
import type { FsColumnDef, FsRenderedStatement, FsRow } from '../model.js';
import type { Balances, EngineCtx } from './context.js';
import { applyDollarSigns, formulaOf } from './face.js';
import { fsIsAccumulatedDepreciation } from '../defaults.js';
import { roundTo, toDisplay } from './util.js';

export interface CashFlowInputs {
  title: string;
  dateLine: string;
  niRounded: { cy: number | null; py: number | null };
  // Rounded cash per balance-sheet column (debit-positive), when the
  // balance sheet isolates cash on its own lines.
  cashTarget: { cy: number | null; py: number | null };
  // Rounded opening cash when the opening date is a shown balance-sheet date.
  openCashTarget: { cy: number | null; py: number | null };
  fullYear: boolean;
}

interface CfLine {
  key: string;
  cls: 'noncash_adjustment' | 'operating' | 'investing' | 'financing';
  caption: string;
  exact: Array<number | null>;
  rounded: Array<number | null>;
}

const lc = (s: string) => s.toLowerCase();

export function buildCashFlows(ctx: EngineCtx, stmt: FsStatementConfig, inp: CashFlowInputs): FsRenderedStatement | null {
  const years: Array<'cy' | 'py'> = ctx.comparative ? ['cy', 'py'] : ['cy'];
  const avail = years.map((y) => !!ctx.bsClosed(y));
  if (!avail[0]) return null;
  const fold = ctx.source.reAccountId;
  const detailByAccount = stmt.cashFlow?.detailByAccount === true;
  const cap = stmt.cashFlow?.captions ?? {};

  const lines = new Map<string, CfLine>();
  const cashBegin: Array<number | null> = [];
  const cashEnd: Array<number | null> = [];
  const niExact: Array<number | null> = [];
  const excludedAccounts = new Set<string>();
  const unreconciled: Array<number | null> = [];

  const lineFor = (id: string, cls: CfLine['cls'], effectCy: number): CfLine => {
    const a = ctx.accounts.get(id)!;
    const g = ctx.groupingOfAccount.get(id);
    let key: string;
    let caption: string;
    if (cls === 'noncash_adjustment' && fsIsAccumulatedDepreciation(a.name, a.detailType)) {
      key = 'noncash:depr';
      caption = 'Depreciation and amortization';
    } else if (a.accountType === 'equity') {
      const role = id === fold ? 'retained' : ctx.source.equityRoles[id] ?? 'other';
      key = `${cls}:equity:${role}`;
      caption = role === 'distributions' ? 'Distributions paid' : role === 'contributions' ? 'Capital contributions' : 'Other equity transactions';
    } else {
      const byAcct = detailByAccount || !g;
      key = `${cls}:${byAcct ? id : g!.id}`;
      const name = byAcct ? a.name : g!.name;
      if (cls === 'operating') caption = a.accountType === 'asset' ? `(Increase) decrease in ${lc(name)}` : `Increase (decrease) in ${lc(name)}`;
      else if (cls === 'investing') caption = a.accountType === 'asset' ? (effectCy < 0 ? `Purchase of ${lc(name)}` : `Proceeds from sale of ${lc(name)}`) : `Change in ${lc(name)}`;
      else if (cls === 'financing') caption = a.accountType === 'liability' ? (effectCy >= 0 ? `Proceeds from ${lc(name)}` : `Repayment of ${lc(name)}`) : `Change in ${lc(name)}`;
      else caption = name;
    }
    let l = lines.get(key);
    if (!l) {
      l = { key, cls, caption, exact: years.map((_, i) => (avail[i] ? 0 : null)), rounded: [] };
      lines.set(key, l);
    }
    return l;
  };

  // First pass (CY) decides captions by the current-year direction.
  const effects: Array<Map<string, number>> = [];
  years.forEach((y, yi) => {
    if (!avail[yi]) { cashBegin.push(null); cashEnd.push(null); niExact.push(null); unreconciled.push(null); effects.push(new Map()); return; }
    const open: Balances = ctx.bsClosed(y === 'cy' ? 'cyOpen' : 'pyOpen') ?? new Map();
    const close: Balances = ctx.bsClosed(y)!;
    const niSigned = [...(ctx.plActivityUntagged(y) ?? new Map()).values()].reduce((s, v) => s + v, 0);
    niExact.push(-niSigned);
    let cb = 0; let ce = 0; let sumEffects = 0;
    const eff = new Map<string, number>();
    const ids = new Set<string>([...open.keys(), ...close.keys()]);
    for (const id of ids) {
      const t = ctx.accounts.get(id)?.accountType;
      if (t !== 'asset' && t !== 'liability' && t !== 'equity') continue;
      const cls: FsCashFlowClass = ctx.cfClass(id);
      const o = open.get(id) ?? 0;
      const c = close.get(id) ?? 0;
      if (cls === 'cash') { cb += o; ce += c; continue; }
      let delta = c - o;
      if (id === fold) delta -= niSigned;
      const effect = -delta;
      if (effect === 0) continue;
      if (cls === 'excluded') { excludedAccounts.add(id); continue; }
      eff.set(id, effect);
      sumEffects += effect;
    }
    cashBegin.push(cb); cashEnd.push(ce);
    unreconciled.push((ce - cb) - (-niSigned + sumEffects));
    effects.push(eff);
  });
  years.forEach((_, yi) => {
    for (const [id, effect] of effects[yi]!) {
      const cls = ctx.cfClass(id) as CfLine['cls'];
      const l = lineFor(id, cls, yi === 0 ? effect : (effects[0]!.get(id) ?? effect));
      l.exact[yi] = (l.exact[yi] ?? 0) + effect;
    }
  });

  unreconciled.forEach((u, yi) => {
    if (u !== null && u !== 0) {
      ctx.checks.push({
        code: 'TB_FS_CF_UNRECONCILED', severity: 'error', statementId: stmt.id, amount: toDisplay(u),
        accountIds: [...excludedAccounts],
        message: `Cash flows ${years[yi] === 'py' ? '(prior year) ' : ''}do not reconcile to the change in cash by ${toDisplay(u).toLocaleString('en-US')}. Check accounts marked "excluded" on the cash-flow classification panel.`,
      });
    }
  });

  // ── Rounding: lines independently, then anchor the net change ──
  for (const l of lines.values()) l.rounded = l.exact.map((v) => (v === null ? null : roundTo(v, ctx.unit)));
  const niR = years.map((y, yi) => (avail[yi] ? (inp.niRounded[y] ?? roundTo(niExact[yi]!, ctx.unit)) : null));
  const beginR = years.map((y, yi) => (avail[yi] ? (inp.openCashTarget[y] ?? roundTo(cashBegin[yi]!, ctx.unit)) : null));
  const endR = years.map((y, yi) => (avail[yi] ? (inp.cashTarget[y] ?? roundTo(cashEnd[yi]!, ctx.unit)) : null));
  years.forEach((_, yi) => {
    if (!avail[yi]) return;
    const target = endR[yi]! - beginR[yi]!;
    let cur = niR[yi]!;
    for (const l of lines.values()) cur += l.rounded[yi] ?? 0;
    const diff = target - cur;
    if (diff === 0) return;
    // Rounding lands on a working-capital change line when there is one
    // (never on a clean capex / debt / distribution figure), choosing the
    // line whose rounded amount stays closest to its exact value.
    const all = [...lines.values()].filter((l) => l.exact[yi] !== null && l.exact[yi] !== 0);
    const operating = all.filter((l) => l.cls === 'operating');
    const pool = operating.length ? operating : all;
    const best = pool.sort((a, b) => {
      const da = Math.abs((a.rounded[yi] ?? 0) + diff - (a.exact[yi] ?? 0));
      const db = Math.abs((b.rounded[yi] ?? 0) + diff - (b.exact[yi] ?? 0));
      return da - db || Math.abs(b.exact[yi] ?? 0) - Math.abs(a.exact[yi] ?? 0);
    })[0];
    if (best) best.rounded[yi] = (best.rounded[yi] ?? 0) + diff;
    else ctx.checks.push({ code: 'TB_FS_ROUNDING_UNPLACED', severity: 'warning', statementId: stmt.id, amount: toDisplay(diff), message: `A cash-flow rounding difference of ${toDisplay(diff)} could not be placed.` });
  });

  // ── Rows ──
  const columns: FsColumnDef[] = years.map((y, yi) => ({ key: y, label: ctx.comparative ? ctx.bsCols[yi]?.label ?? '' : '', kind: 'amount' as const }));
  const rows: FsRow[] = [];
  const vals = (v: Array<number | null>) => v.map((x) => (x === null ? null : toDisplay(x)));
  const push = (r: Omit<FsRow, 'dollarSign' | 'ruleAbove' | 'ruleBelow'> & Partial<FsRow>) => {
    rows.push({ dollarSign: false, ruleAbove: 'none', ruleBelow: 'none', ...r });
    return rows.length - 1;
  };
  const heading = (key: string, caption: string, level = 0) => push({ key, kind: 'heading', caption, level, styleRole: level === 0 ? 'sectionHeading' : 'detail', values: years.map(() => null) });
  const nonZero = (l: CfLine) => l.rounded.some((v) => v !== null && v !== 0);
  const byCls = (cls: CfLine['cls']) => [...lines.values()].filter((l) => l.cls === cls && nonZero(l));
  const sectionTotals: number[] = [];
  const addSection = (key: string, title: string, totalCaption: string, cls: Array<CfLine['cls']>, withNi: boolean) => {
    const members = cls.flatMap(byCls);
    if (!withNi && !members.length) return;
    heading(`${key}:h`, title);
    const termRows: number[] = [];
    if (withNi) termRows.push(push({ key: 'ni', kind: 'detail', caption: cap.netIncome ?? 'Net income', level: 1, styleRole: 'detail', values: vals(niR) }));
    const adj = members.filter((l) => l.cls === 'noncash_adjustment' || l.cls === 'operating');
    if (withNi && adj.length) heading(`${key}:adj`, cap.adjustmentsHeading ?? 'Adjustments to reconcile net income to net cash provided by (used in) operating activities:', 1);
    const list = withNi ? adj : members;
    list.forEach((l, i) => {
      termRows.push(push({ key: l.key, kind: 'detail', caption: l.caption, level: withNi ? 2 : 1, styleRole: 'detail', values: vals(l.rounded), ruleBelow: i === list.length - 1 ? 'single' : 'none' }));
    });
    const tot = years.map((_, yi) => (avail[yi] ? (withNi ? niR[yi]! : 0) + list.reduce((s, l) => s + (l.rounded[yi] ?? 0), 0) : null));
    const r = push({ key: `${key}:t`, kind: 'subtotal', caption: totalCaption, level: 1, styleRole: 'subtotal', values: vals(tot), formula: formulaOf(termRows.map((row) => ({ row, sign: 1 }))) });
    sectionTotals.push(r);
    push({ key: `${key}:b`, kind: 'blank', caption: '', level: 0, styleRole: 'text', values: years.map(() => null) });
  };
  addSection('op', cap.operatingHeading ?? 'CASH FLOWS FROM OPERATING ACTIVITIES', cap.netOperating ?? 'Net cash provided by (used in) operating activities', ['noncash_adjustment', 'operating'], true);
  addSection('inv', cap.investingHeading ?? 'CASH FLOWS FROM INVESTING ACTIVITIES', cap.netInvesting ?? 'Net cash provided by (used in) investing activities', ['investing'], false);
  addSection('fin', cap.financingHeading ?? 'CASH FLOWS FROM FINANCING ACTIVITIES', cap.netFinancing ?? 'Net cash provided by (used in) financing activities', ['financing'], false);

  const netChange = years.map((_, yi) => (avail[yi] ? endR[yi]! - beginR[yi]! : null));
  const ncRow = push({ key: 'net_change', kind: 'subtotal', caption: cap.netChange ?? 'NET INCREASE (DECREASE) IN CASH', level: 0, styleRole: 'subtotal', values: vals(netChange), formula: formulaOf(sectionTotals.map((row) => ({ row, sign: 1 }))) });
  const period = inp.fullYear ? 'year' : 'period';
  const bRow = push({ key: 'begin_cash', kind: 'detail', caption: cap.beginningCash ?? `Cash, beginning of ${period}`, level: 0, styleRole: 'detail', values: vals(beginR), ruleBelow: 'single' });
  push({ key: 'end_cash', kind: 'total', caption: cap.endingCash ?? `CASH, END OF ${period.toUpperCase()}`, level: 0, styleRole: 'total', values: vals(endR), ruleBelow: 'double', formula: formulaOf([{ row: ncRow, sign: 1 }, { row: bRow, sign: 1 }]) });
  applyDollarSigns(ctx, rows);

  const pageSetup = { ...ctx.style.page, ...(stmt.pageSetup ?? {}), margins: { ...ctx.style.page.margins, ...(stmt.pageSetup?.margins ?? {}) } };
  return { id: stmt.id, kind: 'cash_flows', title: inp.title, dateLine: inp.dateLine, pageSetup, columns, rows };
}
