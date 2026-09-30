// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Engine context: closed balance sheets per date, P&L activity per income
// statement column, account/grouping lookups, cash-flow classification and
// the shared check list. Built once per compute.

import type { FsCashFlowClass, FsLayout, FsReportSettings, FsStyle } from '../schemas.js';
import type { FsCheck, FsSourceAccount, FsSourceData, FsSourceGrouping, FsSourcePeriod } from '../model.js';
import { fsDefaultCashFlowClass } from '../defaults.js';
import { isBsType, presUnit, toUnits } from './util.js';

export type BsColKey = 'cy' | 'py';
export type PlColKey = 'cy' | 'py' | 'month' | 'ytd';

export interface AmountCol<K extends string> {
  key: K;
  label: string;
  available: boolean;
}

export type Balances = Map<string, number>;

export interface EngineCtx {
  settings: FsReportSettings;
  layout: FsLayout;
  style: FsStyle;
  source: FsSourceData;
  decimals: 0 | 2;
  unit: number;
  accounts: Map<string, FsSourceAccount>;
  groupingById: Map<string, FsSourceGrouping>;
  groupingByCode: Map<string, FsSourceGrouping>;
  groupingOfAccount: Map<string, FsSourceGrouping>;
  bsCols: AmountCol<BsColKey>[];
  plCols: AmountCol<PlColKey>[];
  // Closed (P&L folded into RE) balance sheet at a column's date.
  bsClosed(key: BsColKey | 'cyOpen' | 'pyOpen'): Balances | null;
  // P&L activity for an income-statement column (tag-filtered when set).
  plActivity(key: PlColKey): Balances | null;
  // Untagged P&L activity (for equity / cash flows).
  plActivityUntagged(key: 'cy' | 'py'): Balances | null;
  cfClass(accountId: string): FsCashFlowClass;
  checks: FsCheck[];
  comparative: boolean;
}

function toMap(p: FsSourcePeriod | undefined): Balances | null {
  if (!p || !p.hasData) return null;
  const m = new Map<string, number>();
  for (const [k, v] of Object.entries(p.balances)) {
    const u = toUnits(v);
    if (u !== 0) m.set(k, u);
  }
  return m;
}

function yearLabel(iso: string | undefined): string {
  return iso ? iso.slice(0, 4) : '';
}

export function buildContext(settings: FsReportSettings, layout: FsLayout, style: FsStyle, source: FsSourceData): EngineCtx {
  const accounts = new Map(source.accounts.map((a) => [a.id, a]));
  // Cloned: the RE fold below adds a member without touching the caller's source.
  const groupings = source.groupings.map((g) => ({ ...g, accountIds: [...g.accountIds] }));
  const groupingById = new Map(groupings.map((g) => [g.id, g]));
  const groupingByCode = new Map<string, FsSourceGrouping>();
  for (const g of groupings) if (g.code && !groupingByCode.has(g.code)) groupingByCode.set(g.code, g);
  const groupingOfAccount = new Map<string, FsSourceGrouping>();
  for (const g of groupings) for (const a of g.accountIds) groupingOfAccount.set(a, g);

  // The RE fold account (virtual when no system RE) rides with the
  // leadsheet holding the most equity accounts so closed balance sheets
  // (RE + current income) always have a home.
  if (!groupingOfAccount.has(source.reAccountId)) {
    let best: FsSourceGrouping | null = null;
    let bestN = 0;
    for (const g of groupings) {
      const n = g.accountIds.filter((id) => accounts.get(id)?.accountType === 'equity').length;
      if (n > bestN) { best = g; bestN = n; }
    }
    if (!best) best = groupingByCode.get('J') ?? null;
    if (best) {
      groupingOfAccount.set(source.reAccountId, best);
      best.accountIds.push(source.reAccountId);
    }
  }
  if (!accounts.has(source.reAccountId)) {
    accounts.set(source.reAccountId, {
      id: source.reAccountId, number: null, name: 'Retained earnings', accountType: 'equity',
      detailType: 'retained_earnings', systemTag: 'retained_earnings', isVirtual: true,
    });
  }

  const raw = {
    cy: toMap(source.periods.cy),
    py: toMap(source.periods.py),
    cyOpen: toMap(source.periods.cyOpen),
    pyOpen: toMap(source.periods.pyOpen),
    cyPriorMonth: toMap(source.periods.cyPriorMonth),
  };
  const tagged = source.tagged
    ? { cy: toMap(source.tagged.cy), py: toMap(source.tagged.py), cyPriorMonth: toMap(source.tagged.cyPriorMonth) }
    : null;

  const isBsAcct = (id: string) => isBsType(accounts.get(id)?.accountType ?? 'expense');

  const closedCache = new Map<string, Balances | null>();
  const closed = (key: 'cy' | 'py' | 'cyOpen' | 'pyOpen'): Balances | null => {
    if (closedCache.has(key)) return closedCache.get(key)!;
    const src = raw[key];
    let out: Balances | null = null;
    if (src) {
      out = new Map();
      let pl = 0;
      for (const [id, v] of src) {
        if (isBsAcct(id)) out.set(id, (out.get(id) ?? 0) + v);
        else pl += v;
      }
      if (pl !== 0) out.set(source.reAccountId, (out.get(source.reAccountId) ?? 0) + pl);
    }
    closedCache.set(key, out);
    return out;
  };

  const plOnly = (m: Balances | null): Balances | null => {
    if (!m) return null;
    const out: Balances = new Map();
    for (const [id, v] of m) if (!isBsAcct(id)) out.set(id, v);
    return out;
  };

  const sameFy = source.periods.cyPriorMonth && source.periods.cy
    && source.periods.cyPriorMonth.fyStart === source.periods.cy.fyStart;

  const plFrom = (set: { cy: Balances | null; py: Balances | null; cyPriorMonth: Balances | null }, key: PlColKey): Balances | null => {
    if (key === 'cy' || key === 'ytd') return plOnly(set.cy);
    if (key === 'py') return plOnly(set.py);
    // month = YTD − prior month-end YTD within the same fiscal year; the
    // first fiscal month's month column IS the YTD.
    const ytd = plOnly(set.cy);
    if (!ytd) return null;
    if (!sameFy) return ytd;
    const prior = plOnly(set.cyPriorMonth) ?? new Map();
    const out: Balances = new Map(ytd);
    for (const [id, v] of prior) out.set(id, (out.get(id) ?? 0) - v);
    return out;
  };

  const mode = settings.columns.mode;
  const bsCols: AmountCol<BsColKey>[] = mode === 'cy_py'
    ? [
      { key: 'cy', label: yearLabel(source.periods.cy?.date ?? settings.periodEnd), available: !!raw.cy },
      { key: 'py', label: yearLabel(source.periods.py?.date), available: !!raw.py },
    ]
    : [{ key: 'cy', label: '', available: !!raw.cy }];
  const plCols: AmountCol<PlColKey>[] = mode === 'cy_py'
    ? [
      { key: 'cy', label: yearLabel(source.periods.cy?.date ?? settings.periodEnd), available: !!raw.cy },
      { key: 'py', label: yearLabel(source.periods.py?.date), available: !!raw.py },
    ]
    : mode === 'month_ytd'
      ? [
        { key: 'month', label: 'Month', available: !!raw.cy },
        { key: 'ytd', label: 'Year to Date', available: !!raw.cy },
      ]
      : [{ key: 'cy', label: '', available: !!raw.cy }];

  const overrideByAccount = new Map<string, FsCashFlowClass>();
  const overrideByGrouping = new Map<string, FsCashFlowClass>();
  for (const o of source.cashFlowOverrides) {
    if (o.accountId) overrideByAccount.set(o.accountId, o.classification);
    else if (o.groupingId) overrideByGrouping.set(o.groupingId, o.classification);
  }
  const cfClass = (accountId: string): FsCashFlowClass => {
    const o = overrideByAccount.get(accountId);
    if (o) return o;
    const g = groupingOfAccount.get(accountId);
    if (g && overrideByGrouping.has(g.id)) return overrideByGrouping.get(g.id)!;
    const a = accounts.get(accountId);
    if (!a) return 'excluded';
    if (accountId === source.reAccountId) return 'financing';
    return fsDefaultCashFlowClass(a, g?.code ?? null);
  };

  const decimals = style.number.decimals;
  return {
    settings, layout, style, source, decimals, unit: presUnit(decimals),
    accounts, groupingById, groupingByCode, groupingOfAccount,
    bsCols, plCols,
    bsClosed: closed,
    plActivity: (k) => plFrom(tagged ?? raw, k),
    plActivityUntagged: (k) => plFrom(raw, k),
    cfClass,
    checks: [],
    comparative: mode === 'cy_py',
  };
}
