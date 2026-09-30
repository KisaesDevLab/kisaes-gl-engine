// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Firm templates are portable (leadsheet codes / system tags only). Binding
// resolves them against one client's leadsheets; toPortableLayout strips a
// client layout back down so it can be saved as a firm template.

import type { FsLayout, FsNode } from './schemas.js';

export interface FsBindableGrouping { id: string; code: string | null; name: string }

export interface FsUnresolvedBinding { nodeId: string; statementId: string; leadsheetCode: string | null; caption: string }

function mapNodes(nodes: FsNode[], fn: (n: FsNode) => FsNode | null): FsNode[] {
  const out: FsNode[] = [];
  for (const n of nodes) {
    const m = fn(n);
    if (!m) continue;
    out.push(m.type === 'section' ? { ...m, children: mapNodes(m.children, fn) } : m);
  }
  return out;
}

// resolutions: nodeId → groupingId (bind) | null (drop the line).
export function bindLayout(
  template: FsLayout,
  groupings: FsBindableGrouping[],
  resolutions: Record<string, string | null> = {},
): { layout: FsLayout; unresolved: FsUnresolvedBinding[] } {
  const byCode = new Map<string, FsBindableGrouping>();
  for (const g of groupings) if (g.code && !byCode.has(g.code)) byCode.set(g.code, g);
  const byId = new Map(groupings.map((g) => [g.id, g]));
  const unresolved: FsUnresolvedBinding[] = [];
  const statements = template.statements.map((st) => ({
    ...st,
    body: mapNodes(st.body, (n) => {
      if (n.type !== 'leadsheet') return n;
      if (Object.prototype.hasOwnProperty.call(resolutions, n.id)) {
        const r = resolutions[n.id];
        if (r === null) return null;
        const g = r ? byId.get(r) : undefined;
        if (g) return { ...n, ref: { groupingId: g.id, leadsheetCode: g.code ?? n.ref.leadsheetCode } };
      }
      if (n.ref.groupingId && byId.has(n.ref.groupingId)) return n;
      const g = n.ref.leadsheetCode ? byCode.get(n.ref.leadsheetCode) : undefined;
      if (g) return { ...n, ref: { groupingId: g.id, leadsheetCode: g.code ?? undefined } };
      unresolved.push({ nodeId: n.id, statementId: st.id, leadsheetCode: n.ref.leadsheetCode ?? null, caption: n.caption ?? n.ref.leadsheetCode ?? n.id });
      return n;
    }),
  }));
  return { layout: { ...template, statements }, unresolved };
}

// Strip client identity: grouping ids → codes, account-level lines and
// schedule customizations removed (they only make sense for one client).
export function toPortableLayout(layout: FsLayout, groupings: FsBindableGrouping[]): FsLayout {
  const byId = new Map(groupings.map((g) => [g.id, g]));
  const statements = layout.statements.map((st) => {
    const body = mapNodes(st.body, (n) => {
      if (n.type === 'account') {
        const portable = n.refs.filter((r) => r.systemTag);
        return portable.length ? { ...n, refs: portable } : null;
      }
      if (n.type !== 'leadsheet') return n;
      const code = n.ref.leadsheetCode ?? (n.ref.groupingId ? byId.get(n.ref.groupingId)?.code : undefined) ?? undefined;
      const scheduleLines = n.scheduleLines
        ?.map((l) => ({ ...l, accountRefs: l.accountRefs.filter((r) => r.systemTag) }))
        .filter((l) => l.accountRefs.length);
      const next: FsNode = { ...n, ref: { leadsheetCode: code } };
      if (scheduleLines?.length) (next as Extract<FsNode, { type: 'leadsheet' }>).scheduleLines = scheduleLines;
      else delete (next as Extract<FsNode, { type: 'leadsheet' }>).scheduleLines;
      return code ? next : null;
    });
    // Drop plugs that pointed at removed nodes.
    const ids = new Set<string>();
    const collect = (ns: FsNode[]) => ns.forEach((n) => { ids.add(n.id); if (n.type === 'section') collect(n.children); });
    collect(body);
    const plugs = st.plugs ? Object.fromEntries(Object.entries(st.plugs).filter(([k, v]) => ids.has(k) && ids.has(v))) : undefined;
    const { equity, ...rest } = st;
    const eq = equity ? { ...equity, columnCaptions: undefined } : undefined;
    return { ...rest, body, ...(plugs ? { plugs } : {}), ...(eq ? { equity: eq } : {}) };
  });
  return { ...layout, statements };
}
