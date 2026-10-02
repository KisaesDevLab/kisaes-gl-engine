// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Leadsheet grouping for the P&L / Balance Sheet (?group_by=leadsheet).
// Leadsheets are the Trial Balance module's account groupings
// (tb_groupings + tb_grouping_accounts): per company, an account sits on
// at most one. This is the leadsheet analog of the detail-type grouping —
// same group shape, so the screens and exports render either one.

import { and, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { tbGroupings, tbGroupingAccounts } from '../db/schema/index.js';

export const NO_LEADSHEET_LABEL = 'Not on a leadsheet';

export interface LeadsheetInfo {
  key: string;
  code: string | null;
  label: string;
  rank: number;
}

export function leadsheetLabel(code: string | null, name: string): string {
  return code ? `${code} — ${name}` : name;
}

// accountId → leadsheet. With companyId null (consolidated scope) every
// company's leadsheets load; the same code + name across companies merge
// into one group so a consolidated report reads like a single company's.
export async function getLeadsheetMap(tenantId: string, companyId: string | null): Promise<Map<string, LeadsheetInfo>> {
  const conds = [eq(tbGroupingAccounts.tenantId, tenantId), eq(tbGroupings.tenantId, tenantId)];
  if (companyId) conds.push(eq(tbGroupingAccounts.companyId, companyId));
  const rows = await db.select({
    accountId: tbGroupingAccounts.accountId,
    name: tbGroupings.name,
    code: tbGroupings.leadsheetCode,
    sortOrder: tbGroupings.sortOrder,
  })
    .from(tbGroupingAccounts)
    .innerJoin(tbGroupings, eq(tbGroupings.id, tbGroupingAccounts.groupingId))
    .where(and(...conds));
  const map = new Map<string, LeadsheetInfo>();
  for (const r of rows) {
    const code = r.code?.trim() || null;
    map.set(r.accountId, {
      key: `${code ?? ''}|${r.name.trim().toLowerCase()}`,
      code,
      label: leadsheetLabel(code, r.name.trim()),
      rank: r.sortOrder,
    });
  }
  return map;
}

// Leadsheet groups appear by the leadsheet's sort order (then code, then
// label); accounts on no leadsheet trail in a 'Not on a leadsheet' group.
// Within a group, entries keep their incoming (account-number) order.
// `finish` turns a group's members into its subtotal fields, so the
// standard (one amount) and comparative (per-column values) builders
// share the keying and ordering.
export function groupByLeadsheet<T extends { accountId?: string | null }, G>(
  entries: T[],
  map: Map<string, LeadsheetInfo>,
  finish: (members: T[], label: string, code: string | null) => G,
): G[] {
  const groups = new Map<string, { info: LeadsheetInfo | null; members: T[] }>();
  for (const e of entries) {
    const info = (e.accountId && map.get(e.accountId)) || null;
    const key = info ? info.key : '__none__';
    let g = groups.get(key);
    if (!g) { g = { info, members: [] }; groups.set(key, g); }
    g.members.push(e);
  }
  return Array.from(groups.values())
    .sort((a, b) => {
      if (!a.info || !b.info) return a.info ? -1 : b.info ? 1 : 0;
      if (a.info.rank !== b.info.rank) return a.info.rank - b.info.rank;
      const ca = a.info.code ?? '';
      const cb = b.info.code ?? '';
      if (ca !== cb) return ca.localeCompare(cb, undefined, { numeric: true });
      return a.info.label.localeCompare(b.info.label);
    })
    .map((g) => finish(g.members, g.info ? g.info.label : NO_LEADSHEET_LABEL, g.info?.code ?? null));
}
