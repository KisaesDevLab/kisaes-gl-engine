// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// computeFsReport — the one pure function behind the live preview, the
// server's authoritative compute, finalize snapshots and every export.

import type { FsLayout, FsReportSettings, FsStatementConfig, FsStyle } from '../schemas.js';
import type { FsRenderedReport, FsRenderedStatement, FsSourceData } from '../model.js';
import { buildContext, type EngineCtx } from './context.js';
import { buildFace, type FaceResult } from './face.js';
import { buildEquity, equityRollforward } from './equity.js';
import { buildCashFlows } from './cash-flow.js';
import { fsBalanceSheetDateLine, fsFlowDateLine, fsMonthsInPeriod, fsStatementTitle } from '../titles.js';
import { dayBefore, roundTo, scheduleLabel, toDisplay } from './util.js';

export function computeFsReport(
  settings: FsReportSettings,
  layout: FsLayout,
  style: FsStyle,
  source: FsSourceData,
): FsRenderedReport {
  const ctx = buildContext(settings, layout, style, source);
  const mode = settings.columns.mode;
  const pyDate = source.periods.py?.date ?? null;
  const dl = { fyStart: source.fyStart, periodEnd: source.periodEnd, mode, priorPeriodEnd: pyDate };
  const bsDateLine = fsBalanceSheetDateLine(dl);
  const flowDateLine = fsFlowDateLine(dl);
  const flowYtdLine = fsFlowDateLine({ ...dl, mode: mode === 'month_ytd' ? 'single' : mode });

  const titleFor = (st: FsStatementConfig, equityColumns?: 'single' | 'by_account') => st.titleOverride || fsStatementTitle(st.kind, {
    framework: settings.framework, entityKind: source.entityKind, comparative: ctx.comparative, equityColumns,
  });

  const runFace = (st: FsStatementConfig, c: EngineCtx, cnt: { n: number }, niTargets?: Array<number | null>) => {
    if (st.kind === 'balance_sheet') {
      return buildFace(c, st, {
        scope: 'bs', cols: c.bsCols, balances: (i) => c.bsClosed(c.bsCols[i]!.key),
        title: titleFor(st), dateLine: bsDateLine, scheduleCounter: cnt, withPct: false, withVariance: true,
      });
    }
    return buildFace(c, st, {
      scope: 'pl', cols: c.plCols, balances: (i) => c.plActivity(c.plCols[i]!.key),
      title: titleFor(st), dateLine: flowDateLine, scheduleCounter: cnt, withPct: true, withVariance: true,
      anchorTargets: niTargets ? { net_income: niTargets } : undefined,
    });
  };
  const bsCfg = layout.statements.find((s) => s.kind === 'balance_sheet');
  const isCfg = layout.statements.find((s) => s.kind === 'income_statement');
  const eqCfg = layout.statements.find((s) => s.kind === 'equity');
  const shadowCtx = () => ({ ...ctx, checks: [] as typeof ctx.checks });

  // Balance sheet first: its rounded equity + cash anchor everything else.
  // (Disabled statements still run, silently, to feed the tie-outs.)
  const bs = bsCfg ? runFace({ ...bsCfg, enabled: true }, bsCfg.enabled ? ctx : shadowCtx(), { n: 0 }) : null;

  const bsIndex = (key: 'cy' | 'py') => ctx.bsCols.findIndex((c) => c.key === key);
  const derive = (pred: (id: string) => boolean, sign: 'credit' | 'debit') => {
    const out: { cy: number | null; py: number | null } = { cy: null, py: null };
    if (!bs) return out;
    for (const key of ['cy', 'py'] as const) {
      const i = bsIndex(key);
      if (i < 0) continue;
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
      out[key] = ok && any ? total : ok ? 0 : null;
    }
    return out;
  };
  const equityTarget = derive((id) => ctx.accounts.get(id)?.accountType === 'equity', 'credit');
  const cashTarget = derive((id) => ctx.cfClass(id) === 'cash', 'debit');

  // Net income the rounded equity roll-forward needs (CPA-software style:
  // the income statement absorbs the rounding so every statement agrees).
  const tagged = !!settings.tagId;
  let niTargets: Array<number | null> | undefined;
  if (!tagged) {
    const rf = equityRollforward(shadowCtx(), eqCfg ?? { id: 'eq', equity: { columns: 'auto' } }, { niRounded: { cy: null, py: null }, equityTarget }, true);
    if (rf) {
      niTargets = ctx.plCols.map((c) => {
        const y = c.key === 'ytd' ? 'cy' : c.key === 'month' ? null : c.key;
        if (!y) return null;
        const t = rf.niTarget[y];
        const m = ctx.plActivityUntagged(y);
        if (t === null || !m) return null;
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
  if (bs && faces.has(bs.statement.id)) {
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
  const niExactFor = (key: 'cy' | 'py' | 'month' | 'ytd'): number | null => {
    const m = ctx.plActivity(key);
    if (!m) return null;
    let s = 0;
    for (const v of m.values()) s += v;
    return -s;
  };
  if (is && faces.has(is.statement.id)) {
    const ni = is.roleExact.net_income;
    if (!ni) {
      ctx.checks.push({ code: 'TB_FS_NO_NET_INCOME', severity: 'warning', statementId: is.statement.id, message: 'Mark the net income line so it can be checked against the ledger.' });
    } else {
      ni.forEach((v, i) => {
        const expected = niExactFor(ctx.plCols[i]!.key);
        if (v !== null && expected !== null && v !== expected) {
          ctx.checks.push({ code: 'TB_FS_NI_MISMATCH', severity: 'error', statementId: is.statement.id, amount: toDisplay(v - expected), message: `Net income on the statement differs from the ledger by ${toDisplay(v - expected).toLocaleString('en-US')}; a revenue or expense leadsheet is missing or counted twice.` });
        }
      });
    }
  }

  // ── Tie-out values for equity + cash flows ──
  const plIndex = (key: 'cy' | 'py') => {
    const k = mode === 'month_ytd' && key === 'cy' ? 'ytd' : key;
    return ctx.plCols.findIndex((c) => c.key === k);
  };
  const niRounded = {
    cy: is?.roleRounded.net_income?.[plIndex('cy')] ?? null,
    py: plIndex('py') >= 0 ? is?.roleRounded.net_income?.[plIndex('py')] ?? null : null,
  };
  // Opening cash ties to the prior-year balance sheet only when the
  // opening date IS the prior balance-sheet date (period end = FYE).
  const cyOpenDate = source.periods.cyOpen?.date ?? dayBefore(source.fyStart);
  const openCashTarget = { cy: pyDate && pyDate === cyOpenDate ? cashTarget.py : null, py: null };

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
      const entity = source.entityKind;
      const colMode = st.equity?.columns ?? 'auto';
      const byAccount = colMode === 'by_account' || (colMode === 'auto' && entity === 'corporation');
      const eq = buildEquity(ctx, st, {
        title: titleFor(st, byAccount ? 'by_account' : 'single'),
        dateLine: flowYtdLine,
        niRounded, equityTarget,
        openDates: { cy: cyOpenDate, py: source.periods.pyOpen?.date ?? null },
        closeDates: { cy: source.periods.cy?.date ?? source.periodEnd, py: pyDate },
      });
      if (eq) out.push(eq);
    } else if (st.kind === 'cash_flows') {
      const cf = buildCashFlows(ctx, st, {
        title: titleFor(st), dateLine: flowYtdLine, niRounded, cashTarget, openCashTarget,
        fullYear: fsMonthsInPeriod(source.fyStart, source.periodEnd) === 12,
      });
      if (cf) out.push(cf);
    }
  }

  if (tagged) {
    ctx.checks.push({ code: 'TB_FS_TAG_PARTIAL', severity: 'warning', message: `Income statement is limited to tag "${source.tagName ?? 'selected tag'}"; the balance sheet shows the whole company.` });
  }
  if (mode === 'cy_py' && !source.periods.py?.hasData) {
    ctx.checks.push({ code: 'TB_FS_PY_NO_DATA', severity: 'info', message: 'The ledger has no prior-year activity, so the prior-year column is blank.' });
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
      periodEnd: source.periodEnd,
      fyStart: source.fyStart,
      framework: settings.framework,
      basis: source.basis,
      entityKind: source.entityKind,
      columnMode: mode,
      glVersionStamp: source.glVersionStamp,
      decimals: style.number.decimals,
      tagName: source.tagName ?? null,
    },
    statements: out,
    schedules: layout.schedules.enabled ? schedules : [],
    checks,
  };
}

export function fsHasBlockingErrors(report: FsRenderedReport): boolean {
  return report.checks.some((c) => c.severity === 'error');
}
