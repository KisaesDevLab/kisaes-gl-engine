// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Rule-based TB diagnostics (Phase 6.4) — authoritative for export
// gating (11.8); AI warnings (6C.5) are advisory and merge in the UI.
//
// Also home of THE tax-code resolver (`resolveCodeFor`) every server
// surface uses — exports, the working-TB download, the AI assist and
// these diagnostics — so the mapping-mode semantics live in one place.

import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import type { TbTaxCodeMappingMode } from '@kis-books/shared';
import { db } from '../../db/index.js';
import {
  accountTaxAssignments, activityUnits, companyTaxProfiles, firmTaxCodes, tagActivityMap, tags,
} from '../../db/schema/index.js';
import { computeWorkpaper, ZERO_UUID, type TbBasis, type TbWorkpaper } from './balance-engine.service.js';
import { isBalanceSheetType } from './activity-view.service.js';

export interface TbDiagnostic {
  kind:
    | 'unassigned' | 'out_of_balance' | 'split_gap' | 'archived_unit_mapping' | 'utility_code_usage' | 'no_units'
    // Unit mapping mode (migration 0170):
    | 'unit_gap'              // live non-default unit slice with balance and no unit-specific code
    | 'activity_mismatch'     // account-level code's activity ≠ the default unit's activity
    | 'default_unit_override' // legacy unit row for the default unit shadows the account-level row
    | 'unit_number_collision';// two units of different types share a number the export would print twice
  severity: 'error' | 'warning';
  accountId?: string;
  accountName?: string;
  unitId?: string;
  message: string;
}

export interface DiagnosticsResult {
  diagnostics: TbDiagnostic[];
  errorCount: number;
  warningCount: number;
  glVersionStamp: number;
}

export interface AssignmentRow {
  accountId: string;
  activityUnitId: string | null;
  seedCode: string | null;
  seedActivityType: string | null;
  firmCodeId: string | null;
}

// Everything the resolver needs to know about the company's mapping
// setup. Built once per request (never inside the per-slice call).
export interface ResolveContext {
  mode: TbTaxCodeMappingMode;
  // Live default unit, or null when the company has no live units.
  defaultUnitId: string | null;
  // Every unit (live + archived) → activity type.
  unitTypeById: Map<string, string>;
}

export const ACCOUNT_MODE_CONTEXT: ResolveContext = { mode: 'account', defaultUnitId: null, unitTypeById: new Map() };

export function buildResolveContext(
  mode: string | null | undefined,
  units: Array<{ id: string; activityType: string; isDefault: boolean; archivedAt: Date | null }>,
): ResolveContext {
  return {
    mode: mode === 'unit' ? 'unit' : 'account',
    defaultUnitId: units.find((u) => u.isDefault && !u.archivedAt)?.id ?? null,
    unitTypeById: new Map(units.map((u) => [u.id, u.activityType])),
  };
}

export async function loadResolveContext(tenantId: string, companyId: string): Promise<ResolveContext> {
  const [profile] = await db.select({ mode: companyTaxProfiles.taxCodeMappingMode }).from(companyTaxProfiles)
    .where(and(eq(companyTaxProfiles.tenantId, tenantId), eq(companyTaxProfiles.companyId, companyId))).limit(1);
  const units = await db.select().from(activityUnits)
    .where(and(eq(activityUnits.tenantId, tenantId), eq(activityUnits.companyId, companyId)));
  return buildResolveContext(profile?.mode, units);
}

// Resolution per ADR-TB-02. A (account, unit) balance resolves through
// the unit-specific assignment first. Whether it may then fall back to
// the account-level row depends on the mapping mode:
//   'account' — always (original behaviour).
//   'unit'    — only for the DEFAULT unit, the ZERO bucket (untagged /
//               archived-default routing) and balance-sheet accounts,
//               which never segment. Any other unit resolves ONLY via
//               its own row, so a farm slice can never silently export
//               the account's Schedule C code.
export function resolveCodeFor(
  assignments: AssignmentRow[],
  accountId: string,
  unitId: string,
  ctx: ResolveContext,
  accountType = '',
): AssignmentRow | null {
  const forAccount = assignments.filter((a) => a.accountId === accountId);
  const unitRow = forAccount.find((a) => a.activityUnitId === unitId);
  if (unitRow) return unitRow;
  if (
    ctx.mode === 'unit'
    && !isBalanceSheetType(accountType)
    && unitId !== ZERO_UUID
    && unitId !== ctx.defaultUnitId
  ) {
    return null;
  }
  return forAccount.find((a) => a.activityUnitId === null) ?? null;
}

// The same "does this slice carry anything" test the split-gap check,
// the activity view and the grid's non-zero filter use.
export const sliceCarries = (u: { unadjusted: number; aje: number; taxRje: number }) =>
  Math.abs(u.unadjusted) >= 0.005 || Math.abs(u.aje) >= 0.005 || Math.abs(u.taxRje) >= 0.005;

export async function runDiagnostics(
  tenantId: string,
  companyId: string,
  opts: { periodEnd: string; basis: TbBasis; taxYear?: number; workpaper?: TbWorkpaper },
): Promise<DiagnosticsResult> {
  const wp = opts.workpaper ?? await computeWorkpaper(tenantId, companyId, {
    periodEnd: opts.periodEnd, basis: opts.basis, taxYear: opts.taxYear,
  });
  const assignments: AssignmentRow[] = await db.select({
    accountId: accountTaxAssignments.accountId,
    activityUnitId: accountTaxAssignments.activityUnitId,
    seedCode: accountTaxAssignments.seedCode,
    seedActivityType: accountTaxAssignments.seedActivityType,
    firmCodeId: accountTaxAssignments.firmCodeId,
  }).from(accountTaxAssignments)
    .where(and(eq(accountTaxAssignments.tenantId, tenantId), eq(accountTaxAssignments.companyId, companyId)));

  const diagnostics: TbDiagnostic[] = [];

  // Column balance (invariant #2 surfaced to the user).
  const pairs: Array<[string, number, number]> = [
    ['Unadjusted', wp.totals.unadjustedDr, wp.totals.unadjustedCr],
    ['AJE', wp.totals.ajeDr, wp.totals.ajeCr],
    ['Adjusted', wp.totals.adjustedDr, wp.totals.adjustedCr],
    ['Tax RJE', wp.totals.taxRjeDr, wp.totals.taxRjeCr],
    ['Tax', wp.totals.taxDr, wp.totals.taxCr],
  ];
  for (const [label, dr, cr] of pairs) {
    if (Math.abs(dr - cr) >= 0.005) {
      diagnostics.push({
        kind: 'out_of_balance',
        severity: 'error',
        message: `${label} column is out of balance: DR ${dr.toFixed(2)} ≠ CR ${cr.toFixed(2)}`,
      });
    }
  }

  // No units configured at all → everything runs on the zero bucket.
  const units = await db.select().from(activityUnits)
    .where(and(eq(activityUnits.tenantId, tenantId), eq(activityUnits.companyId, companyId)));
  const liveUnits = units.filter((u) => !u.archivedAt);
  const unitById = new Map(units.map((u) => [u.id, u]));
  if (liveUnits.length === 0 && wp.rows.length > 0) {
    diagnostics.push({
      kind: 'no_units',
      severity: 'warning',
      message: 'No activity units configured — all balances fall to a single unresolved bucket. Add at least one unit in TB Settings.',
    });
  }
  const [profile] = await db.select({ mode: companyTaxProfiles.taxCodeMappingMode }).from(companyTaxProfiles)
    .where(and(eq(companyTaxProfiles.tenantId, tenantId), eq(companyTaxProfiles.companyId, companyId))).limit(1);
  const ctx = buildResolveContext(profile?.mode, units);
  const unitMode = ctx.mode === 'unit';
  const defaultUnit = ctx.defaultUnitId ? unitById.get(ctx.defaultUnitId) ?? null : null;
  const isLiveNonDefault = (unitId: string) => {
    const u = unitById.get(unitId);
    return !!u && !u.archivedAt && unitId !== ctx.defaultUnitId;
  };

  // Firm-code activity types for the account-level mismatch check.
  const firmCodeIds = [...new Set(assignments.map((a) => a.firmCodeId).filter((x): x is string => !!x))];
  const firmCodeType = new Map<string, string>();
  if (unitMode && firmCodeIds.length) {
    const rows = await db.select({ id: firmTaxCodes.id, activityType: firmTaxCodes.activityType }).from(firmTaxCodes)
      .where(inArray(firmTaxCodes.id, firmCodeIds));
    for (const r of rows) firmCodeType.set(r.id, r.activityType);
  }
  const codeActivityOf = (a: AssignmentRow): string | null =>
    a.firmCodeId ? (firmCodeType.get(a.firmCodeId) ?? null) : a.seedActivityType;

  // Per-account checks: unassigned, per-unit gaps, utility usage.
  const utilityCodes = new Set(['DONOTMAP', 'MEMO', 'SUSPENSE', 'REPORTING_ONLY']);
  for (const row of wp.rows) {
    if (row.isVirtualRe) continue;
    const bs = isBalanceSheetType(row.accountType);
    const unitIds = row.units.length ? row.units.map((u) => u.unitId) : [ZERO_UUID];
    const accountLevel = resolveCodeFor(assignments, row.accountId, ZERO_UUID, ctx, row.accountType);
    if (!accountLevel && row.units.every((u) => !resolveCodeFor(assignments, row.accountId, u.unitId, ctx, row.accountType))) {
      diagnostics.push({
        kind: 'unassigned',
        severity: 'error',
        accountId: row.accountId,
        accountName: row.name,
        message: `${row.accountNumber ? row.accountNumber + ' ' : ''}${row.name} has no tax code assignment`,
      });
      continue;
    }
    // Per-unit gaps: a unit carrying balance without a resolvable code.
    // Account mode: only multi-unit accounts can gap (single-unit
    // accounts resolve account-level). The ZERO bucket counts too — an
    // archived default unit routes balances there, and dropping it would
    // hide one side of an entry.
    // Unit mode: every live non-default P&L slice needs its own row
    // (`unit_gap`, strict); the ZERO / archived buckets keep the
    // `split_gap` wording.
    const checkSlices = unitMode ? !bs : row.units.length > 1;
    if (checkSlices) {
      for (const u of row.units) {
        if (!sliceCarries(u)) continue;
        if (resolveCodeFor(assignments, row.accountId, u.unitId, ctx, row.accountType)) continue;
        const unit = unitById.get(u.unitId);
        if (unitMode && isLiveNonDefault(u.unitId)) {
          diagnostics.push({
            kind: 'unit_gap',
            severity: 'error',
            accountId: row.accountId,
            accountName: row.name,
            unitId: u.unitId,
            message: `${row.accountNumber ? row.accountNumber + ' ' : ''}${row.name} has a balance in ${unit?.displayName ?? 'a unit'} (#${unit?.instanceNumber ?? '?'}) with no tax code for that unit`,
          });
          continue;
        }
        diagnostics.push({
          kind: 'split_gap',
          severity: 'error',
          accountId: row.accountId,
          accountName: row.name,
          unitId: u.unitId,
          message: u.unitId === ZERO_UUID
            ? `${row.name} routes balance to an unmapped bucket (archived default unit or no live units) with no resolvable tax code`
            : `${row.name} splits into ${unit?.displayName ?? 'a unit'} with no resolvable tax code for that activity`,
        });
      }
    }
    if (unitMode && !bs && accountLevel && accountLevel.activityUnitId === null) {
      // The account-level row IS the default unit's code in unit mode —
      // its activity must fit that unit (or be a common line).
      const codeType = codeActivityOf(accountLevel);
      if (defaultUnit && codeType && codeType !== 'common' && codeType !== defaultUnit.activityType) {
        diagnostics.push({
          kind: 'activity_mismatch',
          severity: 'error',
          accountId: row.accountId,
          accountName: row.name,
          unitId: defaultUnit.id,
          message: `${row.name}'s account-level code ${accountLevel.seedCode ?? 'FIRM'} is a ${codeType.replace('_', ' ')} code, but the default unit "${defaultUnit.displayName}" is ${defaultUnit.activityType.replace('_', ' ')}`,
        });
      }
    }
    if (unitMode && ctx.defaultUnitId && assignments.some((a) => a.accountId === row.accountId && a.activityUnitId === ctx.defaultUnitId)) {
      diagnostics.push({
        kind: 'default_unit_override',
        severity: 'warning',
        accountId: row.accountId,
        accountName: row.name,
        unitId: ctx.defaultUnitId,
        message: `${row.name} has a unit-specific code for the default unit "${defaultUnit?.displayName ?? ''}" — it overrides the account-level code. Clear it if that is not intended.`,
      });
    }
    // Vendor files suffix account numbers with the unit NUMBER, and units
    // of different activity types may share a number — an account that
    // carries balance in both would print the same account number twice.
    if (!bs && row.units.length > 1) {
      const seen = new Map<number, string>();
      for (const u of row.units) {
        const unit = unitById.get(u.unitId);
        if (!unit || !sliceCarries(u)) continue;
        const prior = seen.get(unit.instanceNumber);
        if (prior && prior !== unit.activityType) {
          diagnostics.push({
            kind: 'unit_number_collision',
            severity: 'warning',
            accountId: row.accountId,
            accountName: row.name,
            unitId: u.unitId,
            message: `${row.name} splits across two activity units that share unit #${unit.instanceNumber} — the vendor file would print ${row.accountNumber ?? row.name}-${unit.instanceNumber} twice. Renumber one unit in TB Settings.`,
          });
          break;
        }
        seen.set(unit.instanceNumber, unit.activityType);
      }
    }
    const resolved = accountLevel ?? resolveCodeFor(assignments, row.accountId, unitIds[0] ?? ZERO_UUID, ctx, row.accountType);
    if (resolved?.seedCode && utilityCodes.has(resolved.seedCode) && resolved.seedCode !== 'REPORTING_ONLY') {
      diagnostics.push({
        kind: 'utility_code_usage',
        severity: 'warning',
        accountId: row.accountId,
        accountName: row.name,
        message: `${row.name} is mapped to ${resolved.seedCode}`,
      });
    }
  }

  // Tags mapped to archived units still routing balances (6.4).
  const archivedMappings = await db.select({
    tagName: tags.name,
    unitName: activityUnits.displayName,
  }).from(tagActivityMap)
    .innerJoin(activityUnits, eq(tagActivityMap.activityUnitId, activityUnits.id))
    .innerJoin(tags, eq(tagActivityMap.tagId, tags.id))
    .where(and(
      eq(tagActivityMap.tenantId, tenantId),
      eq(tagActivityMap.companyId, companyId),
      isNotNull(activityUnits.archivedAt),
      sql`${tags.isActive} = TRUE`,
    ));
  for (const m of archivedMappings) {
    diagnostics.push({
      kind: 'archived_unit_mapping',
      severity: 'warning',
      message: `Tag "${m.tagName}" maps to archived unit "${m.unitName}" — balances still route there`,
    });
  }

  return {
    diagnostics,
    errorCount: diagnostics.filter((d) => d.severity === 'error').length,
    warningCount: diagnostics.filter((d) => d.severity === 'warning').length,
    glVersionStamp: wp.glVersionStamp,
  };
}
