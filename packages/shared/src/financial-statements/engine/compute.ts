// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// computeFsReport — the one pure function behind the live preview, the
// server's authoritative compute, finalize snapshots and every export.
// Columns and date ranges come from the reporting-period plan
// (fsPlanColumns): annual / quarter / month / YTD / custom ranges, with
// comparative, period + YTD and side-by-side layouts.

import type { FsLayout, FsReportSettings, FsStatementConfig, FsStyle } from '../schemas.js';
import type { FsRenderedReport, FsRenderedStatement, FsSourceData } from '../model.js';
import { buildContext, type EngineCtx } from './context.js';
import { buildFace, type FaceResult } from './face.js';
import { buildEquity, equityRollforward, rangeId } from './equity.js';
import { buildCashFlows } from './cash-flow.js';
import { fsStatementTitle } from '../titles.js';
import { fsPlanBalanceSheetDateLine, fsPlanFlowDateLine } from '../periods.js';
import { roundTo, scheduleLabel, toDisplay } from './util.js';

export function computeFsReport(
  settings: FsReportSettings,
  layout: FsLayout,
  style: FsStyle,
  source: FsSourceData,
): FsRenderedReport {
  const ctx = buildContext(settings, layout, style, source);
  const plan = ctx.plan;
  const fyM = source.fyStartMonth;
  const bsDateLine = fsPlanBalanceSheetDateLine(plan);
  const isDateLine = fsPlanFlowDateLine(plan, plan.isRanges, fyM);
  const cfDateLine = fsPlanFlowDateLine(plan, plan.cfRanges, fyM);
  const eqDateLine = fsPlanFlowDateLine(plan, plan.equityBlocks, fyM);

  // Plural statement titles whenever a statement shows two comparable
  // periods (AICPA: "Balance Sheets", "Statements of Income").
  const pluralTitles = ctx.comparative || plan.mode === 'cy_py';
  const titleFor = (st: FsStatementConfig, equityColumns?: 'single' | 'by_account') => st.titleOverride || fsStatementTitle(st.kind, {
    framework: settings.framework, entityKind: source.entityKind, comparative: pluralTitles, equityColumns,
  });

  const runFace = (st: FsStatementConfig, c: EngineCtx, cnt: { n: number }, niTargets?: Array<number | null>) => {
    if (st.kind === 'balance_sheet') {
      return buildFace(c, st, {
        scope: 'bs', cols: c.bsCols, balances: (i) => c.bsClosed(c.bsCols[i]!.date!),
        title: titleFor(st), dateLine: bsDateLine, scheduleCounter: cnt, withPct: false, withVariance: true,
      });
    }
    return buildFace(c, st, {
      scope: 'pl', cols: c.plCols, balances: (i) => c.plActivity(c.plCols[i]!.range!),
      title: titleFor(st), dateLine: isDateLine, scheduleCounter: cnt, withPct: true, withVariance: true,
      anchorTargets: niTargets ? { net_income: niTargets } : undefined,
    });
  };
  const bsCfg = layout.statements.find((s) => s.kind === 'balance_sheet');
  const isCfg = layout.statements.find((s) => s.kind === 'income_statement');
  const eqCfg = layout.statements.find((s) => s.kind === 'equity');
  const shadowCtx = (): EngineCtx => ({ ...ctx, checks: [] });

  // Balance sheet first: its rounded equity + cash anchor everything else.
  // (Disabled statements still run, silently, to feed the tie-outs.)
  const bs = bsCfg ? runFace({ ...bsCfg, enabled: true }, bsCfg.enabled ? ctx : shadowCtx(), { n: 0 }) : null;

  // Rounded equity / cash per balance-sheet date, when the balance sheet
  // shows them on lines of their own.
  const derive = (pred: (id: string) => boolean, sign: 'credit' | 'debit') => {
    const out = new Map<string, number | null>();
    if (!bs) return out;
    ctx.bsCols.forEach((col, i) => {
      let total = 0;
      let ok = true;
      let any = false;
      for (const l of bs.lines) {
        const hits = l.accounts.filter(pred).length;
        if (!hits) continue;
        if (hits !== l.accounts.length) { ok = false; break; }
        any = true;
        const r = l.rounded[i];
        if (r === null || r === undefined) { ok = false; break; }
        total += l.pol === sign ? r : -r;
      }
      out.set(col.date!, ok && any ? total : ok ? 0 : null);
    });
    return out;
  };
  const equityTarget = derive((id) => ctx.accounts.get(id)?.accountType === 'equity', 'credit');
  const cashTarget = derive((id) => ctx.cfClass(id) === 'cash', 'debit');

  // Net income each range needs so the rounded equity roll-forward lands
  // on the rounded balance sheet (CPA-software style: the income
  // statement absorbs the rounding so every statement agrees).
  const tagged = !!settings.tagId;
  let niTargets: Array<number | null> | undefined;
  if (!tagged) {
    const rf = equityRollforward(shadowCtx(), eqCfg ?? { id: 'eq', equity: { columns: 'auto' } }, { niRounded: new Map(), equityTarget }, true);
    if (rf) {
      niTargets = ctx.plCols.map((c) => {
        const t = rf.niTarget.get(rangeId(c.range!));
        const m = ctx.plActivityUntagged(c.range!);
        if (t === undefined || !m) return null;
        let exactNi = 0;
        for (const v of m.values()) exactNi -= v;
        // Only a rounding-sized nudge; anything bigger means the layout
        // is incomplete and the checks will say so.
        return Math.abs(t - roundTo(exactNi, ctx.unit)) <= 5 * ctx.unit ? t : null;
      });
    }
  }
  const is = isCfg ? runFace({ ...isCfg, enabled: true }, isCfg.enabled ? ctx : shadowCtx(), { n: 0 }, niTargets) : null;

  // Schedule numbering follows layout order (faces were built BS-first).
  const faces = new Map<string, FaceResult>();
  const counter = { n: 0 };
  for (const st of layout.statements) {
    if (!st.enabled) continue;
    const f = st === bsCfg ? bs : st === isCfg ? is : null;
    if (!f) continue;
    const relabel = new Map<string, string>();
    for (const sch of f.schedules) {
      counter.n += 1;
      const label = scheduleLabel(counter.n, layout.schedules.numbering);
      relabel.set(sch.scheduleNo ?? '', label);
      sch.scheduleNo = label;
      sch.id = `sched_${label.replace(/\s+/g, '_').toLowerCase()}`;
    }
    for (const r of f.statement.rows) if (r.scheduleRef) r.scheduleRef = relabel.get(r.scheduleRef) ?? r.scheduleRef;
    faces.set(st.id, f);
  }

  // ── Core checks ──
  if (bs && bsCfg?.enabled) {
    const a = bs.roleExact.total_assets;
    const le = bs.roleExact.total_liabilities_equity;
    if (!a || !le) {
      ctx.checks.push({ code: 'TB_FS_NO_BALANCE_CHECK', severity: 'warning', statementId: bs.statement.id, message: 'Mark the Total assets and Total liabilities & equity lines so the balance sheet can be checked.' });
    } else {
      a.forEach((v, i) => {
        const w = le[i];
        if (v !== null && w !== null && w !== undefined && v !== w) {
          ctx.checks.push({ code: 'TB_FS_BS_UNBALANCED', severity: 'error', statementId: bs.statement.id, amount: toDisplay(v - w), message: `The balance sheet${ctx.bsCols[i]?.label ? ` (${ctx.bsCols[i]!.label})` : ''} is out of balance by ${toDisplay(v - w).toLocaleString('en-US')}.` });
        }
      });
    }
  }
  if (is && isCfg?.enabled) {
    const ni = is.roleExact.net_income;
    if (!ni) {
      ctx.checks.push({ code: 'TB_FS_NO_NET_INCOME', severity: 'warning', statementId: is.statement.id, message: 'Mark the net income line so it can be checked against the ledger.' });
    } else {
      ni.forEach((v, i) => {
        const m = ctx.plActivity(ctx.plCols[i]!.range!);
        if (v === null || !m) return;
        let expected = 0;
        for (const x of m.values()) expected -= x;
        if (v !== expected) {
          ctx.checks.push({ code: 'TB_FS_NI_MISMATCH', severity: 'error', statementId: is.statement.id, amount: toDisplay(v - expected), message: `Net income on the statement differs from the ledger by ${toDisplay(v - expected).toLocaleString('en-US')}; a revenue or expense leadsheet is missing or counted twice.` });
        }
      });
    }
  }

  // ── Tie-out values for equity + cash flows ──
  const niRounded = new Map<string, number | null>();
  ctx.plCols.forEach((c, i) => {
    const v = is?.roleRounded.net_income?.[i];
    if (v !== undefined) niRounded.set(rangeId(c.range!), v);
  });

  const out: FsRenderedStatement[] = [];
  const schedules: FsRenderedStatement[] = [];
  for (const st of layout.statements) {
    if (!st.enabled) continue;
    if (st.kind === 'balance_sheet' || st.kind === 'income_statement') {
      const f = faces.get(st.id);
      if (!f) continue;
      out.push(f.statement);
      schedules.push(...f.schedules);
      continue;
    }
    if (tagged) {
      ctx.checks.push({ code: 'TB_FS_TAG_PARTIAL', severity: 'warning', statementId: st.id, message: `The ${st.kind === 'equity' ? 'equity statement' : 'statement of cash flows'} is left out because a tag filter is applied (only the income statement can be shown for one tag).` });
      continue;
    }
    if (st.kind === 'equity') {
      const colMode = st.equity?.columns ?? 'auto';
      const byAccount = colMode === 'by_account' || (colMode === 'auto' && source.entityKind === 'corporation');
      const eq = buildEquity(ctx, st, { title: titleFor(st, byAccount ? 'by_account' : 'single'), dateLine: eqDateLine, niRounded, equityTarget });
      if (eq) out.push(eq);
    } else if (st.kind === 'cash_flows') {
      const cf = buildCashFlows(ctx, st, { title: titleFor(st), dateLine: cfDateLine, niRounded, cashTarget });
      if (cf) out.push(cf);
    }
  }

  if (tagged) {
    ctx.checks.push({ code: 'TB_FS_TAG_PARTIAL', severity: 'warning', message: `Income statement is limited to tag "${source.tagName ?? 'selected tag'}"; the balance sheet shows the whole company.` });
  }
  const missingPy = [...ctx.plCols, ...ctx.bsCols].some((c) => !c.available);
  if (missingPy) {
    ctx.checks.push({ code: 'TB_FS_PY_NO_DATA', severity: 'info', message: 'The ledger has no activity for some columns (for example the prior year), so they are blank.' });
  }
  if (settings.framework === 'tax') {
    ctx.checks.push({ code: 'TB_FS_TAX_PY_RJE', severity: 'info', message: 'Tax adjustments apply to the current tax year only; beginning equity is the book amount.' });
  }

  // De-duplicate identical checks (the shadow faces never add any).
  const seen = new Set<string>();
  const checks = ctx.checks.filter((c) => {
    const k = `${c.code}|${c.statementId ?? ''}|${c.nodeId ?? ''}|${c.message}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  return {
    meta: {
      companyName: source.companyName,
      periodStart: plan.period.start,
      periodType: plan.period.type,
      periodEnd: plan.period.end,
      fyStart: source.fyStart,
      framework: settings.framework,
      basis: source.basis,
      entityKind: source.entityKind,
      columnMode: plan.mode,
      glVersionStamp: source.glVersionStamp,
      decimals: style.number.decimals,
      tagName: source.tagName ?? null,
      bsDateLine,
    },
    statements: out,
    schedules: layout.schedules.enabled ? schedules : [],
    checks,
  };
}

export function fsHasBlockingErrors(report: FsRenderedReport): boolean {
  return report.checks.some((c) => c.severity === 'error');
}
