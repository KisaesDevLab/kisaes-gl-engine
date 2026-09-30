// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Balance sheet / income statement builder: claims accounts for layout
// nodes, evaluates the node tree per amount column, rounds with anchored
// plugs so every total foots, builds supplementary schedules, and emits
// rows (with XLSX formulas) for the renderers.

import type { FsLeadsheetNode, FsNode, FsPolarity, FsStatementConfig } from '../schemas.js';
import type { FsColumnDef, FsRenderedStatement, FsRow, FsRowFormula } from '../model.js';
import type { AmountCol, Balances, EngineCtx } from './context.js';
import { compareAccountNumbers, isBsType, isCreditNatural, pct, roundTo, scheduleLabel, toDisplay } from './util.js';

export interface Line {
  key: string;
  nodeId: string;
  caption: string;
  accounts: string[];
  pol: FsPolarity;
  exact: Array<number | null>;
  rounded: Array<number | null>;
  fixed: boolean;
  plug: number[];
  locked: boolean[];
}

interface ENode {
  node: FsNode;
  depth: number;
  pol: FsPolarity;
  accounts: string[];
  lines: Line[];
  children: ENode[];
  schedule?: ScheduleBuild;
  parent: ENode | null;
}

interface ScheduleBuild {
  label: string;
  title: string;
  caption: string;
  lines: Line[];
  totalExact: Array<number | null>;
  totalRounded: Array<number | null>;
}

export interface FaceResult {
  statement: FsRenderedStatement;
  schedules: FsRenderedStatement[];
  // Rounded values of role nodes per amount column (presented sign).
  roleRounded: Partial<Record<'net_income' | 'total_assets' | 'total_liabilities_equity', Array<number | null>>>;
  roleExact: Partial<Record<'net_income' | 'total_assets' | 'total_liabilities_equity', Array<number | null>>>;
  lines: Line[];
}

export interface FaceOptions {
  scope: 'bs' | 'pl';
  cols: AmountCol<string>[];
  balances: (colIndex: number) => Balances | null;
  title: string;
  dateLine: string;
  scheduleCounter: { n: number };
  withPct: boolean;
  withVariance: boolean;
  // Role anchors with an externally-derived rounded target (net income
  // derived from the rounded equity roll-forward).
  anchorTargets?: Partial<Record<'net_income', Array<number | null>>>;
}

// ─── Columns ───────────────────────────────────────────────────────

export function buildColumnDefs(ctx: EngineCtx, cols: AmountCol<string>[], withPct: boolean, withVariance: boolean): FsColumnDef[] {
  const defs: FsColumnDef[] = [];
  for (const c of cols) {
    defs.push({ key: c.key, label: c.label, kind: 'amount' });
    if (withPct && ctx.settings.columns.pctOfRevenue) defs.push({ key: `${c.key}_pct`, label: '%', kind: 'pct' });
  }
  if (withVariance && ctx.settings.columns.mode === 'cy_py' && cols.length === 2) {
    if (ctx.settings.columns.varianceAmt) defs.push({ key: 'var_amt', label: '$ Change', kind: 'variance_amt' });
    if (ctx.settings.columns.variancePct) defs.push({ key: 'var_pct', label: '% Change', kind: 'variance_pct' });
  }
  return defs;
}

// Expand per-amount-column values (1e-4 units) into the statement's
// column layout (amount, pct, variance).
export function expandValues(
  ctx: EngineCtx,
  defs: FsColumnDef[],
  amounts: Array<number | null>,
  base: Array<number | null> | null,
): Array<number | null> {
  const out: Array<number | null> = [];
  let ai = 0;
  for (const d of defs) {
    if (d.kind === 'amount') {
      const v = amounts[ai];
      out.push(v === null || v === undefined ? null : toDisplay(v));
      ai++;
    } else if (d.kind === 'pct') {
      const v = amounts[ai - 1];
      const b = base?.[ai - 1];
      out.push(v === null || v === undefined || b === null || b === undefined ? null : pct(v, b));
    } else if (d.kind === 'variance_amt') {
      const [a, b] = amounts;
      out.push(a === null || a === undefined || b === null || b === undefined ? null : toDisplay(a - b));
    } else {
      const [a, b] = amounts;
      out.push(a === null || a === undefined || b === null || b === undefined || b === 0 ? null : pct(a - b, Math.abs(b)));
    }
  }
  void ctx;
  return out;
}

// ─── Dollar signs ──────────────────────────────────────────────────

export function applyDollarSigns(ctx: EngineCtx, rows: FsRow[]): void {
  if (ctx.style.number.dollarSigns === 'none') return;
  let needFirst = true;
  for (const r of rows) {
    const numeric = r.values.some((v) => v !== null) && (r.kind === 'detail' || r.kind === 'subtotal' || r.kind === 'total');
    if (!numeric) continue;
    if (needFirst) { r.dollarSign = true; needFirst = false; }
    if (r.ruleBelow === 'double') { r.dollarSign = true; needFirst = true; }
  }
}

// ─── Builder ───────────────────────────────────────────────────────

export function buildFace(ctx: EngineCtx, stmt: FsStatementConfig, opt: FaceOptions): FaceResult {
  const nCols = opt.cols.length;
  const inScope = (id: string) => {
    const a = ctx.accounts.get(id);
    if (!a) return false;
    return opt.scope === 'bs' ? isBsType(a.accountType) : !isBsType(a.accountType);
  };
  const bal = Array.from({ length: nCols }, (_, i) => (opt.cols[i]!.available ? opt.balances(i) : null));
  const accountValue = (id: string, c: number): number | null => {
    const m = bal[c];
    if (!m) return null;
    return m.get(id) ?? 0;
  };

  const resolveRefs = (refs: Array<{ accountId?: string; systemTag?: string }>): string[] => {
    const out: string[] = [];
    for (const r of refs) {
      if (r.accountId && ctx.accounts.has(r.accountId)) out.push(r.accountId);
      else if (r.systemTag) {
        for (const a of ctx.accounts.values()) if (a.systemTag === r.systemTag) out.push(a.id);
      }
    }
    return out.filter(inScope);
  };

  // ── Claims: pulled-out account lines first, then leadsheets ──
  const claimedBy = new Map<string, string>();
  const nodeAccounts = new Map<string, string[]>();
  const walk = (nodes: FsNode[], fn: (n: FsNode) => void) => {
    for (const n of nodes) { fn(n); if (n.type === 'section') walk(n.children, fn); }
  };
  walk(stmt.body, (n) => {
    if (n.type !== 'account') return;
    const ids: string[] = [];
    for (const id of resolveRefs(n.refs)) {
      const prior = claimedBy.get(id);
      if (prior) {
        ctx.checks.push({ code: 'TB_FS_DOUBLE_COUNTED', severity: 'error', statementId: stmt.id, nodeId: n.id, accountIds: [id], message: `${ctx.accounts.get(id)?.name ?? id} is placed on more than one line.` });
        continue;
      }
      claimedBy.set(id, n.id);
      ids.push(id);
    }
    nodeAccounts.set(n.id, ids);
  });
  const usedGroupings = new Map<string, string>();
  walk(stmt.body, (n) => {
    if (n.type !== 'leadsheet') return;
    const g = (n.ref.groupingId ? ctx.groupingById.get(n.ref.groupingId) : undefined)
      ?? (n.ref.leadsheetCode ? ctx.groupingByCode.get(n.ref.leadsheetCode) : undefined);
    if (!g) {
      ctx.checks.push({ code: 'TB_FS_UNBOUND_LEADSHEET', severity: 'error', statementId: stmt.id, nodeId: n.id, message: `"${n.caption ?? n.ref.leadsheetCode ?? 'Leadsheet'}" is not linked to a leadsheet for this client.` });
      nodeAccounts.set(n.id, []);
      return;
    }
    if (usedGroupings.has(g.id)) {
      ctx.checks.push({ code: 'TB_FS_LEADSHEET_REPEATED', severity: 'warning', statementId: stmt.id, nodeId: n.id, message: `Leadsheet "${g.name}" is placed more than once; only the first placement carries its accounts.` });
    }
    usedGroupings.set(g.id, n.id);
    const ids: string[] = [];
    for (const id of g.accountIds) {
      if (!inScope(id) || claimedBy.has(id)) continue;
      claimedBy.set(id, n.id);
      ids.push(id);
    }
    nodeAccounts.set(n.id, ids);
  });

  // Unassigned accounts with a balance in any shown column.
  const unassigned: string[] = [];
  for (const a of ctx.accounts.values()) {
    if (!inScope(a.id) || claimedBy.has(a.id)) continue;
    if (bal.some((m) => m && (m.get(a.id) ?? 0) !== 0)) unassigned.push(a.id);
  }
  if (unassigned.length) {
    const names = unassigned.map((id) => ctx.accounts.get(id)!).sort(compareAccountNumbers)
      .map((a) => (a.number ? `${a.number} ${a.name}` : a.name));
    ctx.checks.push({
      code: 'TB_FS_UNASSIGNED', severity: 'error', statementId: stmt.id, accountIds: unassigned,
      message: `${unassigned.length} account${unassigned.length === 1 ? '' : 's'} with a balance ${unassigned.length === 1 ? 'is' : 'are'} not on the ${opt.scope === 'bs' ? 'balance sheet' : 'income statement'}: ${names.slice(0, 8).join(', ')}${names.length > 8 ? '…' : ''}`,
    });
  }

  // ── Build the evaluation tree ──
  const index = new Map<string, ENode>();
  const naturalPol = (ids: string[]): FsPolarity => {
    let credit = 0;
    let debit = 0;
    for (const id of ids) {
      const t = ctx.accounts.get(id)?.accountType ?? 'expense';
      if (isCreditNatural(t)) credit++; else debit++;
    }
    return credit > debit ? 'credit' : 'debit';
  };
  const subtreeAccounts = (n: FsNode): string[] => {
    if (n.type === 'section') return n.children.flatMap(subtreeAccounts);
    return nodeAccounts.get(n.id) ?? [];
  };

  const makeLine = (node: FsNode, key: string, caption: string, accounts: string[], pol: FsPolarity): Line => {
    const exact: Array<number | null> = [];
    for (let c = 0; c < nCols; c++) {
      if (!bal[c]) { exact.push(null); continue; }
      let s = 0;
      for (const id of accounts) s += accountValue(id, c) ?? 0;
      exact.push(pol === 'credit' ? -s : s);
    }
    return {
      key, nodeId: node.id, caption, accounts, pol, exact,
      rounded: exact.map((v) => (v === null ? null : roundTo(v, ctx.unit))),
      fixed: false, plug: new Array(nCols).fill(0), locked: new Array(nCols).fill(false),
    };
  };

  const accountCaption = (id: string) => ctx.accounts.get(id)?.name ?? id;

  const scheduleLinesFor = (n: FsLeadsheetNode, accounts: string[], pol: FsPolarity): Line[] => {
    const remaining = new Set(accounts);
    const lines: Line[] = [];
    for (const sl of n.scheduleLines ?? []) {
      const ids = resolveRefs(sl.accountRefs).filter((id) => remaining.has(id));
      if (!ids.length) continue;
      ids.forEach((id) => remaining.delete(id));
      lines.push(makeLine(n, `${n.id}:${sl.id}`, sl.caption || (ids.length === 1 ? accountCaption(ids[0]!) : 'Other'), ids, pol));
    }
    const rest = [...remaining].map((id) => ctx.accounts.get(id)!).sort(compareAccountNumbers);
    for (const a of rest) lines.push(makeLine(n, `${n.id}:${a.id}`, a.name, [a.id], pol));
    return lines;
  };

  const schedulesOn = ctx.layout.schedules.enabled;
  const scheduleBuilds: ScheduleBuild[] = [];

  const build = (n: FsNode, depth: number, parent: ENode | null): ENode => {
    const accounts = subtreeAccounts(n);
    const explicit = 'polarity' in n ? n.polarity : undefined;
    const pol: FsPolarity = explicit ?? parent?.pol ?? naturalPol(accounts);
    const e: ENode = { node: n, depth, pol, accounts, lines: [], children: [], parent };
    index.set(n.id, e);
    if (n.type === 'section') {
      e.children = n.children.map((c) => build(c, depth + 1, e));
    } else if (n.type === 'account') {
      e.lines = [makeLine(n, n.id, n.caption, nodeAccounts.get(n.id) ?? [], pol)];
    } else if (n.type === 'leadsheet') {
      const ids = nodeAccounts.get(n.id) ?? [];
      const g = (n.ref.groupingId ? ctx.groupingById.get(n.ref.groupingId) : undefined)
        ?? (n.ref.leadsheetCode ? ctx.groupingByCode.get(n.ref.leadsheetCode) : undefined);
      const caption = n.caption || g?.name || 'Leadsheet';
      if (n.display === 'detail') {
        e.lines = scheduleLinesFor(n, ids, pol);
      } else if (n.display === 'summary_with_schedule' && schedulesOn) {
        const lines = scheduleLinesFor(n, ids, pol);
        opt.scheduleCounter.n += 1;
        const sb: ScheduleBuild = {
          label: scheduleLabel(opt.scheduleCounter.n, ctx.layout.schedules.numbering),
          title: n.scheduleTitle || `Schedule of ${caption}`,
          caption,
          lines,
          totalExact: [],
          totalRounded: [],
        };
        // Settle the schedule: its total is anchored to round(exact).
        for (let c = 0; c < nCols; c++) {
          if (!bal[c]) { sb.totalExact.push(null); sb.totalRounded.push(null); continue; }
          const exact = lines.reduce((s, l) => s + (l.exact[c] ?? 0), 0);
          const target = roundTo(exact, ctx.unit);
          const cur = lines.reduce((s, l) => s + (l.rounded[c] ?? 0), 0);
          const diff = target - cur;
          if (diff !== 0 && lines.length) {
            const plugLine = [...lines].sort((a, b) => Math.abs(b.exact[c] ?? 0) - Math.abs(a.exact[c] ?? 0))[0]!;
            plugLine.rounded[c] = (plugLine.rounded[c] ?? 0) + diff;
            plugLine.plug[c] = (plugLine.plug[c] ?? 0) + diff;
          }
          sb.totalExact.push(exact);
          sb.totalRounded.push(target);
        }
        e.schedule = sb;
        scheduleBuilds.push(sb);
        const face = makeLine(n, n.id, caption, ids, pol);
        face.fixed = true;
        face.rounded = [...sb.totalRounded];
        face.exact = [...sb.totalExact];
        e.lines = [face];
      } else {
        e.lines = [makeLine(n, n.id, caption, ids, pol)];
      }
    }
    return e;
  };
  const roots = stmt.body.map((n) => build(n, 0, null));

  // ── Contributions (line → net sign) ──
  const contribCache = new Map<string, Map<Line, number>>();
  const visiting = new Set<string>();
  const contrib = (e: ENode): Map<Line, number> => {
    const cached = contribCache.get(e.node.id);
    if (cached) return cached;
    const out = new Map<Line, number>();
    if (visiting.has(e.node.id)) {
      ctx.checks.push({ code: 'TB_FS_TOTAL_CYCLE', severity: 'error', statementId: stmt.id, nodeId: e.node.id, message: `Total "${'caption' in e.node ? e.node.caption : e.node.id}" refers to itself.` });
      return out;
    }
    visiting.add(e.node.id);
    const add = (m: Map<Line, number>, f: number) => {
      for (const [l, s] of m) out.set(l, (out.get(l) ?? 0) + s * f);
    };
    const n = e.node;
    if (n.type === 'section') {
      for (const ch of e.children) {
        if (ch.node.type === 'total' || ch.node.type === 'text' || ch.node.type === 'blank' || ch.node.type === 'page_break') continue;
        add(contrib(ch), ch.pol === e.pol ? 1 : -1);
      }
    } else if (n.type === 'leadsheet' || n.type === 'account') {
      for (const l of e.lines) out.set(l, 1);
    } else if (n.type === 'total') {
      for (const t of n.terms) {
        const target = index.get(t.nodeId);
        if (!target) {
          ctx.checks.push({ code: 'TB_FS_TOTAL_MISSING_TERM', severity: 'error', statementId: stmt.id, nodeId: n.id, message: `"${n.caption}" refers to a line that is no longer on the statement.` });
          continue;
        }
        add(contrib(target), t.sign);
      }
    }
    visiting.delete(e.node.id);
    contribCache.set(e.node.id, out);
    return out;
  };
  const valueOf = (e: ENode, c: number, which: 'exact' | 'rounded'): number | null => {
    if (!bal[c]) return null;
    let s = 0;
    for (const [l, sign] of contrib(e)) s += sign * (l[which][c] ?? 0);
    return s;
  };

  // ── Anchored rounding ──
  const anchors: ENode[] = [];
  for (const e of index.values()) {
    const n = e.node;
    if ((n.type === 'section' || n.type === 'total') && (n.role || n.anchor)) anchors.push(e);
    else if (n.type === 'leadsheet' && n.anchor) anchors.push(e);
  }
  anchors.sort((a, b) => contrib(a).size - contrib(b).size);
  for (const a of anchors) {
    const m = contrib(a);
    for (let c = 0; c < nCols; c++) {
      if (!bal[c]) continue;
      const role = (a.node.type === 'section' || a.node.type === 'total') ? a.node.role : undefined;
      const override = role === 'net_income' ? opt.anchorTargets?.net_income?.[c] : undefined;
      const target = override ?? roundTo(valueOf(a, c, 'exact') ?? 0, ctx.unit);
      const diff = target - (valueOf(a, c, 'rounded') ?? 0);
      if (diff !== 0) {
        const eligible = [...m.entries()].filter(([l, s]) => s !== 0 && !l.fixed && !l.locked[c]);
        const plugNodeId = stmt.plugs?.[a.node.id];
        const preferred = plugNodeId ? eligible.filter(([l]) => l.nodeId === plugNodeId) : [];
        // Default: never move cash (it ties to the bank reconciliation)
        // when another line can take the rounding.
        const nonCash = eligible.filter(([l]) => !l.accounts.some((id) => ctx.cfClass(id) === 'cash'));
        const pool = preferred.length ? preferred : nonCash.length ? nonCash : eligible;
        if (pool.length) {
          const [line, sign] = pool.sort((x, y) => Math.abs(y[0].exact[c] ?? 0) - Math.abs(x[0].exact[c] ?? 0))[0]!;
          const adj = diff * Math.sign(sign);
          line.rounded[c] = (line.rounded[c] ?? 0) + adj;
          line.plug[c] = (line.plug[c] ?? 0) + adj;
          const lineCount = eligible.length;
          if (Math.abs(diff) > Math.max(1, Math.ceil(lineCount / 2)) * ctx.unit) {
            ctx.checks.push({ code: 'TB_FS_ROUNDING_LARGE', severity: 'warning', statementId: stmt.id, nodeId: line.nodeId, amount: toDisplay(adj), message: `Rounding of ${toDisplay(adj)} was placed on "${line.caption}".` });
          }
        } else {
          ctx.checks.push({ code: 'TB_FS_ROUNDING_UNPLACED', severity: 'warning', statementId: stmt.id, nodeId: a.node.id, amount: toDisplay(diff), message: `A rounding difference of ${toDisplay(diff)} could not be placed for "${'caption' in a.node ? a.node.caption : a.node.id}".` });
        }
      }
      for (const [l] of m) l.locked[c] = true;
    }
  }

  // ── Revenue base for % columns ──
  const baseNode = [...index.values()].find((e) => 'revenueBase' in e.node && e.node.revenueBase);
  const base = baseNode ? Array.from({ length: nCols }, (_, c) => valueOf(baseNode, c, 'rounded')) : null;
  if (opt.withPct && ctx.settings.columns.pctOfRevenue && !baseNode) {
    ctx.checks.push({ code: 'TB_FS_NO_REVENUE_BASE', severity: 'warning', statementId: stmt.id, message: 'No line is marked as the revenue base, so % of revenue is blank.' });
  }
  const defs = buildColumnDefs(ctx, opt.cols, opt.withPct, opt.withVariance);

  // ── Emit rows ──
  type Pending = FsRow & { hidden?: boolean; ref?: { line?: Line; node?: ENode; totalOf?: ENode } };
  const out: Pending[] = [];
  const hideDefault = ctx.style.number.hideZeroLines;
  const isZero = (vals: Array<number | null>) => vals.every((v) => v === null || v === 0);
  const styleOf = (n: FsNode) => ({
    bold: n.style?.bold, italic: n.style?.italic, caps: n.style?.caps, sizeDelta: n.style?.sizeDelta,
  });
  const row = (partial: Partial<Pending> & Pick<Pending, 'key' | 'kind' | 'caption' | 'level' | 'styleRole'>, amounts: Array<number | null>): Pending => ({
    values: expandValues(ctx, defs, amounts, base),
    dollarSign: false,
    ruleAbove: 'none',
    ruleBelow: 'none',
    ...partial,
    // keep raw amounts for formulas / hiding
    ...({ _amounts: amounts } as object),
  });
  const lineAmounts = (l: Line) => l.rounded;
  const nodeAmounts = (e: ENode) => Array.from({ length: nCols }, (_, c) => valueOf(e, c, 'rounded'));
  const isProtected = (e: ENode) => {
    const n = e.node;
    return ((n.type === 'section' || n.type === 'total') && !!n.role);
  };

  const emit = (e: ENode): boolean => {
    // returns true when something visible was emitted
    const n = e.node;
    const indent = n.style?.indent ?? 0;
    const hideZero = n.hideWhenZero ?? hideDefault;
    const startLen = out.length;
    const common = { nodeId: n.id, breakBefore: n.breakBefore || undefined };
    if (n.type === 'section') {
      const headingIdx = out.length;
      if (n.showHeading !== false && n.caption) {
        out.push(row({ key: `${n.id}:h`, ...common, kind: 'heading', caption: n.caption, level: e.depth + indent, styleRole: 'sectionHeading', ...styleOf(n), ruleAbove: n.ruleAbove ?? 'none' }, new Array(nCols).fill(null)));
      }
      let anyChild = false;
      for (const ch of e.children) anyChild = emit(ch) || anyChild;
      const amounts = nodeAmounts(e);
      if (n.showTotal !== false) {
        const top = e.depth === 0;
        // Grand totals (role / double rule) are bold 'total' rows; other
        // section totals are subtotals, indented past their detail lines.
        const strong = !!n.role || (n.totalRuleBelow ?? n.ruleBelow) === 'double';
        out.push(row({
          key: `${n.id}:t`, nodeId: n.id, kind: strong ? 'total' : 'subtotal',
          caption: n.totalCaption || `Total ${n.caption.toLowerCase()}`,
          level: (top ? 0 : e.depth + 2) + indent, styleRole: strong ? 'total' : 'subtotal',
          bold: n.totalStyle?.bold, italic: n.totalStyle?.italic, caps: n.totalStyle?.caps, sizeDelta: n.totalStyle?.sizeDelta,
          ruleAbove: n.totalRuleAbove ?? 'single', ruleBelow: n.totalRuleBelow ?? n.ruleBelow ?? 'none',
          ref: { totalOf: e },
        }, amounts));
      }
      if (!anyChild && hideZero && isZero(amounts) && !isProtected(e)) {
        for (let i = headingIdx; i < out.length; i++) out[i]!.hidden = true;
        return false;
      }
      return true;
    }
    if (n.type === 'leadsheet' && n.display === 'detail') {
      const top = e.depth === 0;
      if (top && (n.caption || e.lines.length)) {
        out.push(row({ key: `${n.id}:h`, ...common, kind: 'heading', caption: n.caption || 'Detail', level: indent, styleRole: 'sectionHeading', ...styleOf(n) }, new Array(nCols).fill(null)));
      }
      let any = false;
      for (const l of e.lines) {
        const amounts = lineAmounts(l);
        const hidden = hideZero && isZero(amounts) && l.plug.every((p) => p === 0);
        out.push({ ...row({ key: l.key, nodeId: n.id, kind: 'detail', caption: l.caption, level: (top ? 1 : e.depth) + indent, styleRole: 'detail', ...styleOf(n), ref: { line: l }, plug: l.plug.some((p) => p !== 0) ? l.plug.map(toDisplay) : undefined }, amounts), hidden });
        any = any || !hidden;
      }
      // Rules on a detail leadsheet land on its last visible line.
      const vis = out.slice(startLen).filter((r) => !r.hidden && r.kind === 'detail');
      const last = vis[vis.length - 1];
      if (last) last.ruleBelow = n.ruleBelow ?? 'none';
      if (top) {
        out.push(row({ key: `${n.id}:t`, nodeId: n.id, kind: 'subtotal', caption: `Total ${(n.caption || 'detail').toLowerCase()}`, level: indent, styleRole: 'subtotal', ruleAbove: 'single', ref: { totalOf: e } }, nodeAmounts(e)));
      }
      if (!any && !top) return false;
      return true;
    }
    if (n.type === 'leadsheet' || n.type === 'account') {
      const l = e.lines[0]!;
      const amounts = lineAmounts(l);
      const hidden = hideZero && isZero(amounts) && l.plug.every((p) => p === 0) && !(n.type === 'leadsheet' && n.anchor);
      out.push({
        ...row({
          key: l.key, ...common, kind: 'detail', caption: l.caption, level: e.depth + indent, styleRole: 'detail', ...styleOf(n),
          ruleAbove: n.ruleAbove ?? 'none', ruleBelow: n.ruleBelow ?? 'none',
          scheduleRef: e.schedule?.label, ref: { line: l },
          plug: l.plug.some((p) => p !== 0) ? l.plug.map(toDisplay) : undefined,
        }, amounts),
        hidden,
      });
      return !hidden;
    }
    if (n.type === 'total') {
      const amounts = nodeAmounts(e);
      const hidden = hideZero && isZero(amounts) && !n.role && n.hideWhenZero === true;
      const strong = !!n.role || n.ruleBelow === 'double';
      out.push({
        ...row({
          key: n.id, ...common, kind: strong ? 'total' : 'subtotal', caption: n.caption, level: e.depth + indent,
          styleRole: strong ? 'total' : 'subtotal', ...styleOf(n),
          ruleAbove: n.ruleAbove ?? 'none', ruleBelow: n.ruleBelow ?? 'none', ref: { node: e },
        }, amounts),
        hidden,
      });
      return !hidden;
    }
    if (n.type === 'text') {
      out.push(row({ key: n.id, ...common, kind: 'text', caption: n.text, level: e.depth + indent, styleRole: 'text', ...styleOf(n) }, new Array(nCols).fill(null)));
      return true;
    }
    out.push(row({ key: n.id, ...common, kind: n.type === 'blank' ? 'blank' : 'page_break', caption: '', level: 0, styleRole: 'text' }, new Array(nCols).fill(null)));
    return false;
  };
  for (const r of roots) emit(r);

  // Drop hidden rows; collapse runs of blank rows and leading/trailing blanks.
  const visible: Pending[] = [];
  for (const r of out) {
    if (r.hidden) continue;
    if (r.kind === 'blank') {
      const prev = visible[visible.length - 1];
      if (!prev || prev.kind === 'blank' || prev.kind === 'page_break') continue;
    }
    visible.push(r);
  }
  while (visible.length && visible[visible.length - 1]!.kind === 'blank') visible.pop();

  // ── XLSX formulas (row-index terms) ──
  const rowOfLine = new Map<Line, number>();
  const totalRowOf = new Map<ENode, number>();
  const nodeRowOf = new Map<ENode, number>();
  visible.forEach((r, i) => {
    if (r.ref?.line) rowOfLine.set(r.ref.line, i);
    if (r.ref?.totalOf) totalRowOf.set(r.ref.totalOf, i);
    if (r.ref?.node) nodeRowOf.set(r.ref.node, i);
  });
  const valueTerms = (e: ENode, sign: 1 | -1, depthGuard = 0): Array<{ row: number; sign: 1 | -1 }> | null => {
    if (depthGuard > 50) return null;
    const n = e.node;
    if (n.type === 'section') {
      const tr = totalRowOf.get(e);
      if (tr !== undefined) return [{ row: tr, sign }];
      const acc: Array<{ row: number; sign: 1 | -1 }> = [];
      for (const ch of e.children) {
        if (ch.node.type === 'total' || ch.node.type === 'text' || ch.node.type === 'blank' || ch.node.type === 'page_break') continue;
        const t = valueTerms(ch, (ch.pol === e.pol ? sign : -sign) as 1 | -1, depthGuard + 1);
        if (!t) return null;
        acc.push(...t);
      }
      return acc;
    }
    if (n.type === 'total') {
      const r = nodeRowOf.get(e);
      if (r !== undefined) return [{ row: r, sign }];
      const acc: Array<{ row: number; sign: 1 | -1 }> = [];
      for (const t of n.terms) {
        const target = index.get(t.nodeId);
        if (!target) return null;
        const v = valueTerms(target, (sign * t.sign) as 1 | -1, depthGuard + 1);
        if (!v) return null;
        acc.push(...v);
      }
      return acc;
    }
    if (n.type === 'leadsheet' || n.type === 'account') {
      if (n.type === 'leadsheet' && n.display === 'detail') {
        const tr = totalRowOf.get(e);
        if (tr !== undefined) return [{ row: tr, sign }];
      }
      const acc: Array<{ row: number; sign: 1 | -1 }> = [];
      for (const l of e.lines) {
        const r = rowOfLine.get(l);
        if (r !== undefined) acc.push({ row: r, sign });
      }
      return acc;
    }
    return [];
  };
  visible.forEach((r) => {
    let terms: Array<{ row: number; sign: 1 | -1 }> | null = null;
    if (r.ref?.totalOf) {
      const e = r.ref.totalOf;
      if (e.node.type === 'section') {
        terms = [];
        for (const ch of e.children) {
          if (ch.node.type === 'total' || ch.node.type === 'text' || ch.node.type === 'blank' || ch.node.type === 'page_break') continue;
          const t = valueTerms(ch, ch.pol === e.pol ? 1 : -1);
          if (!t) { terms = null; break; }
          terms.push(...t);
        }
      } else {
        terms = e.lines.map((l) => rowOfLine.get(l)).filter((x): x is number => x !== undefined).map((row) => ({ row, sign: 1 as const }));
      }
    } else if (r.ref?.node && r.ref.node.node.type === 'total') {
      terms = [];
      for (const t of r.ref.node.node.terms) {
        const target = index.get(t.nodeId);
        const v = target ? valueTerms(target, t.sign) : null;
        if (!v) { terms = null; break; }
        terms.push(...v);
      }
    }
    if (terms) r.formula = formulaOf(terms);
  });

  const rows: FsRow[] = visible.map(({ hidden: _h, ref: _r, ...rest }) => {
    const clean = { ...rest } as FsRow & { _amounts?: unknown };
    delete clean._amounts;
    return clean;
  });
  applyDollarSigns(ctx, rows);

  const pageSetup = { ...ctx.style.page, ...(stmt.pageSetup ?? {}), margins: { ...ctx.style.page.margins, ...(stmt.pageSetup?.margins ?? {}) } };

  // ── Schedules ──
  const schedules: FsRenderedStatement[] = scheduleBuilds.map((sb) => {
    const srows: Array<FsRow & { _line?: Line }> = [];
    for (const l of sb.lines) {
      const amounts = l.rounded;
      if (hideDefault && isZero(amounts) && l.plug.every((p) => p === 0)) continue;
      srows.push({ ...row({ key: l.key, nodeId: l.nodeId, kind: 'detail', caption: l.caption, level: 0, styleRole: 'detail', plug: l.plug.some((p) => p !== 0) ? l.plug.map(toDisplay) : undefined }, amounts) });
    }
    const lineRows = srows.map((_, i) => i);
    srows.push({
      ...row({ key: `${sb.label}:t`, kind: 'total', caption: `Total ${sb.caption.toLowerCase()}`, level: 0, styleRole: 'total', ruleAbove: 'single', ruleBelow: 'double' }, sb.totalRounded),
      formula: { kind: 'sum', rows: lineRows },
    });
    const clean: FsRow[] = srows.map((r) => {
      const c = { ...r } as FsRow & { _amounts?: unknown };
      delete c._amounts;
      return c;
    });
    applyDollarSigns(ctx, clean);
    return {
      id: `sched_${sb.label.replace(/\s+/g, '_').toLowerCase()}`,
      kind: 'schedule' as const,
      title: sb.title,
      dateLine: opt.dateLine,
      scheduleNo: sb.label,
      pageSetup,
      columns: defs,
      rows: clean,
    };
  });

  // ── Role values ──
  const roleRounded: FaceResult['roleRounded'] = {};
  const roleExact: FaceResult['roleExact'] = {};
  for (const e of index.values()) {
    const n = e.node;
    if ((n.type === 'section' || n.type === 'total') && n.role) {
      roleRounded[n.role] = Array.from({ length: nCols }, (_, c) => valueOf(e, c, 'rounded'));
      roleExact[n.role] = Array.from({ length: nCols }, (_, c) => valueOf(e, c, 'exact'));
    }
  }

  const allLines: Line[] = [];
  for (const e of index.values()) allLines.push(...e.lines);

  return {
    statement: { id: stmt.id, kind: stmt.kind, title: opt.title, dateLine: opt.dateLine, pageSetup, columns: defs, rows },
    schedules,
    roleRounded,
    roleExact,
    lines: allLines,
  };
}

export function formulaOf(terms: Array<{ row: number; sign: 1 | -1 }>): FsRowFormula {
  // Collapse duplicate rows; a run of +1 terms becomes a SUM.
  const net = new Map<number, number>();
  for (const t of terms) net.set(t.row, (net.get(t.row) ?? 0) + t.sign);
  const clean = [...net.entries()].filter(([, s]) => s !== 0).map(([row, s]) => ({ row, sign: (s > 0 ? 1 : -1) as 1 | -1 }));
  if (clean.every((t) => t.sign === 1)) return { kind: 'sum', rows: clean.map((t) => t.row) };
  return { kind: 'terms', terms: clean };
}
