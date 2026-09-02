// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Server-side twin of the workpaper grid's "Activity view" so the
// Workpaper report (CSV/PDF) and the Excel Working TB can export
// exactly what the screen shows:
//
//   ''        consolidated — one line per account
//   'tags'    by tag / unit # — one line per account × segment; the
//             account number carries the unit number the way vendor
//             exports do (1000-2 / 2-1000 per "Unit # on exports"),
//             untagged activity and balance sheet accounts are unit 0
//   <unitId>  a single activity unit — accounts with no activity in
//             that unit are dropped
//
// Optional account-type / search / non-zero filters mirror the grid's
// toolbar so an on-screen download foots to the rows on screen.

import { and, eq } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { activityUnits, companyTaxProfiles } from '../../db/schema/index.js';
import { AppError } from '../../utils/errors.js';
import { ZERO_UUID, type TbUnitSplit, type TbWorkpaperRow } from './balance-engine.service.js';

export const TB_VIEW_BY_TAG = 'tags';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type TbActivityView = '' | typeof TB_VIEW_BY_TAG | string;

export interface TbViewFilters {
  activityView?: TbActivityView | null;
  accountType?: string | null;
  search?: string | null;
  nonZeroOnly?: boolean;
}

// Parses a request/query value into an activity view: blank →
// consolidated, 'tags' → by tag, otherwise a unit UUID.
export function parseActivityView(v: unknown): TbActivityView {
  if (v == null || v === '' || v === 'consolidated') return '';
  if (v === TB_VIEW_BY_TAG) return TB_VIEW_BY_TAG;
  if (typeof v === 'string' && UUID_RE.test(v)) return v;
  throw AppError.badRequest("activityView must be blank, 'tags', or an activity unit id");
}

export interface UnitFormatting {
  numberOf: (unitId: string) => number;
  nameOf: (unitId: string) => string;
  placement: 'suffix' | 'prefix';
}

export async function loadUnitFormatting(tenantId: string, companyId: string): Promise<UnitFormatting> {
  const [units, [profile]] = await Promise.all([
    db.select({ id: activityUnits.id, number: activityUnits.instanceNumber, name: activityUnits.displayName })
      .from(activityUnits)
      .where(and(eq(activityUnits.tenantId, tenantId), eq(activityUnits.companyId, companyId))),
    db.select({ placement: companyTaxProfiles.unitNumberPlacement }).from(companyTaxProfiles)
      .where(and(eq(companyTaxProfiles.tenantId, tenantId), eq(companyTaxProfiles.companyId, companyId))).limit(1),
  ]);
  const numbers = new Map(units.map((u) => [u.id, u.number]));
  const names = new Map(units.map((u) => [u.id, u.name]));
  return {
    numberOf: (unitId) => (unitId === ZERO_UUID ? 0 : numbers.get(unitId) ?? 0),
    nameOf: (unitId) => names.get(unitId) ?? 'Unmapped unit',
    placement: profile?.placement === 'prefix' ? 'prefix' : 'suffix',
  };
}

// Same formatting the grid and vendor exports use.
export function unitAccountNumber(accountNumber: string | null, unitNumber: number, placement: 'suffix' | 'prefix'): string {
  const base = accountNumber ?? '';
  return placement === 'prefix' ? `${unitNumber}-${base}` : `${base}-${unitNumber}`;
}

export const isBalanceSheetType = (accountType: string) =>
  accountType === 'asset' || accountType === 'liability' || accountType === 'equity';

export interface TbSegmentRow {
  row: TbWorkpaperRow;
  // Unit the amounts belong to: null when consolidated, ZERO_UUID for
  // the "no tag / not segmented" bucket, else the activity unit id.
  unitId: string | null;
  accountNumber: string;
  // Human label for the segment in by-tag view ('' otherwise).
  segment: string;
  // First line emitted for the account — per-account extras (LS ref,
  // tickmarks) belong on this one only, like the grid.
  primary: boolean;
  unadjusted: number;
  aje: number;
  adjusted: number;
  taxRje: number;
  tax: number;
}

const zeroSplit = (): Omit<TbUnitSplit, 'unitId'> => ({ unadjusted: 0, aje: 0, adjusted: 0, taxRje: 0, tax: 0 });
const amounts = (s: Omit<TbUnitSplit, 'unitId'> | undefined) => {
  const a = s ?? zeroSplit();
  return { unadjusted: a.unadjusted, aje: a.aje, adjusted: a.adjusted, taxRje: a.taxRje, tax: a.tax };
};

export function segmentWorkpaperRows(rows: TbWorkpaperRow[], filters: TbViewFilters, fmt: UnitFormatting): TbSegmentRow[] {
  const view = filters.activityView ?? '';
  const byTag = view === TB_VIEW_BY_TAG;
  const filterUnit = byTag ? '' : view;
  const term = (filters.search ?? '').trim().toLowerCase();

  const out: TbSegmentRow[] = [];
  for (const row of rows) {
    if (filters.accountType && row.accountType !== filters.accountType) continue;
    if (term && !row.name.toLowerCase().includes(term) && !(row.accountNumber ?? '').includes(term)) continue;

    if (filterUnit) {
      const u = row.units.find((x) => x.unitId === filterUnit);
      if (!u) continue;
      out.push({ row, unitId: filterUnit, accountNumber: row.accountNumber ?? '', segment: '', primary: true, ...amounts(u) });
      continue;
    }
    if (!byTag) {
      out.push({ row, unitId: null, accountNumber: row.accountNumber ?? '', segment: '', primary: true, ...amounts(row) });
      continue;
    }
    // By tag: unit 0 (no tag / balance sheet) first, then ascending
    // unit number — identical ordering to the grid.
    const segments = row.byTag.length ? row.byTag : [{ unitId: ZERO_UUID, ...zeroSplit() }];
    const balanceSheet = isBalanceSheetType(row.accountType);
    [...segments]
      .sort((a, b) => fmt.numberOf(a.unitId) - fmt.numberOf(b.unitId) || a.unitId.localeCompare(b.unitId))
      .forEach((s, i) => out.push({
        row,
        unitId: s.unitId,
        accountNumber: unitAccountNumber(row.accountNumber, fmt.numberOf(s.unitId), fmt.placement),
        segment: s.unitId === ZERO_UUID
          ? (balanceSheet ? 'balance sheet · not segmented' : 'no tag')
          : fmt.nameOf(s.unitId),
        primary: i === 0,
        ...amounts(s),
      }));
  }
  return filters.nonZeroOnly
    ? out.filter((d) => Math.abs(d.unadjusted) >= 0.005 || Math.abs(d.aje) >= 0.005 || Math.abs(d.taxRje) >= 0.005)
    : out;
}

// Short human description of a view for report titles / sheet
// subtitles ('' when consolidated).
export function activityViewLabel(view: TbActivityView, fmt: UnitFormatting): string {
  if (!view) return '';
  if (view === TB_VIEW_BY_TAG) return 'By tag / unit #';
  return `Unit: ${fmt.nameOf(view)}`;
}
