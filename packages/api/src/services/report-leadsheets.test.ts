// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect } from 'vitest';
import { groupByLeadsheet, leadsheetLabel, NO_LEADSHEET_LABEL, type LeadsheetInfo } from './report-leadsheets.js';

const ls = (code: string | null, name: string, rank: number): LeadsheetInfo =>
  ({ key: `${code ?? ''}|${name.toLowerCase()}`, code, label: leadsheetLabel(code, name), rank });

describe('groupByLeadsheet', () => {
  const map = new Map<string, LeadsheetInfo>([
    ['a1', ls('B', 'Accounts Receivable', 1)],
    ['a2', ls('A', 'Cash', 0)],
    ['a3', ls('A', 'Cash', 0)],
  ]);
  const entries = [
    { accountId: 'a1', amount: 10 },
    { accountId: 'a2', amount: 5 },
    { accountId: 'x9', amount: 7 }, // on no leadsheet
    { accountId: 'a3', amount: 1.25 },
    { accountId: null, amount: 3 }, // computed row, no account
  ];
  const groups = groupByLeadsheet(entries, map, (members, label, code) => ({
    label, code, ids: members.map((m) => m.accountId), total: members.reduce((t, m) => t + m.amount, 0),
  }));

  it('orders leadsheets by sort order and trails unassigned accounts', () => {
    expect(groups.map((g) => g.label)).toEqual(['A — Cash', 'B — Accounts Receivable', NO_LEADSHEET_LABEL]);
  });

  it('keeps member order and subtotals per leadsheet', () => {
    expect(groups[0]).toEqual({ label: 'A — Cash', code: 'A', ids: ['a2', 'a3'], total: 6.25 });
    expect(groups[2]).toEqual({ label: NO_LEADSHEET_LABEL, code: null, ids: ['x9', null], total: 10 });
  });

  it('labels a leadsheet without a code by name alone', () => {
    expect(leadsheetLabel(null, 'Equity')).toBe('Equity');
  });
});
