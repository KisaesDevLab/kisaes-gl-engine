// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Pure helpers behind the per-unit AI run: candidate codes narrow to
// common + the unit's activity, and the work list is per (account, unit).

import { describe, it, expect, afterAll } from 'vitest';
import { pool } from '../../db/index.js';
import { candidateCodes, unassignedRows } from './ai-tax-assign.service.js';
import { buildResolveContext, type AssignmentRow } from './diagnostics.service.js';
import type { TbWorkpaperRow } from './balance-engine.service.js';

afterAll(async () => { await pool.end(); });

const slice = (unitId: string, adj: number) => ({ unitId, unadjusted: adj, aje: 0, adjusted: adj, taxRje: 0, tax: adj });
const row = (accountId: string, accountType: string, units: ReturnType<typeof slice>[]): TbWorkpaperRow => ({
  accountId, accountNumber: null, name: accountId, accountType, detailType: null, isVirtualRe: false,
  unadjusted: 0, aje: 0, adjusted: 0, taxRje: 0, tax: 0, units, byTag: units,
});
const ctx = buildResolveContext('unit', [
  { id: 'main', activityType: 'business', isDefault: true, archivedAt: null },
  { id: 'oak', activityType: 'rental', isDefault: false, archivedAt: null },
]);

describe('candidateCodes', () => {
  it('keeps only common + the unit type; no unit = everything', () => {
    const codes = [{ code: 'A', activityType: 'business' }, { code: 'B', activityType: 'rental' }, { code: 'C', activityType: 'common' }];
    expect(candidateCodes(codes, 'rental').map((c) => c.code)).toEqual(['B', 'C']);
    expect(candidateCodes(codes, null).map((c) => c.code)).toEqual(['A', 'B', 'C']);
  });
});

describe('unassignedRows', () => {
  const rows = [
    row('sales', 'revenue', [slice('main', 600), slice('oak', 400)]),
    row('rent', 'expense', [slice('main', 200)]),
    row('cash', 'asset', [slice('main', 800)]),
    row('zero', 'expense', [slice('oak', 0)]),
  ];
  const assignments: AssignmentRow[] = [
    { accountId: 'rent', activityUnitId: null, seedCode: 'X', seedActivityType: 'business', firmCodeId: null },
  ];
  it('per-unit run lists P&L rows whose slice carries and lacks a unit row', () => {
    const out = unassignedRows(rows, assignments, ctx, { id: 'oak', activityType: 'rental' }, new Set());
    expect(out.map((r) => r.accountId)).toEqual(['sales']); // rent: no oak slice; cash: BS; zero: no balance
  });
  it('default-unit / account-level run uses strict resolution on the first slice', () => {
    const out = unassignedRows(rows, assignments, ctx, { id: 'main', activityType: 'business' }, new Set());
    expect(out.map((r) => r.accountId).sort()).toEqual(['cash', 'sales', 'zero']);
    expect(unassignedRows(rows, assignments, ctx, null, new Set(['sales'])).map((r) => r.accountId).sort()).toEqual(['cash', 'zero']);
  });
});
