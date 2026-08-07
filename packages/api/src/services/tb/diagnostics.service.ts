// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Rule-based TB diagnostics (Phase 6.4) — authoritative for export
// gating (11.8); AI warnings (6C.5) are advisory and merge in the UI.

import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { accountTaxAssignments, activityUnits, tagActivityMap, tags } from '../../db/schema/index.js';
import { computeWorkpaper, ZERO_UUID, type TbBasis, type TbWorkpaper } from './balance-engine.service.js';

export interface TbDiagnostic {
  kind: 'unassigned' | 'out_of_balance' | 'split_gap' | 'archived_unit_mapping' | 'utility_code_usage' | 'no_units';
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

interface AssignmentRow {
  accountId: string;
  activityUnitId: string | null;
  seedCode: string | null;
  firmCodeId: string | null;
}

// Resolution per ADR-TB-02: a (account, unit) balance resolves through
// the unit-specific assignment first, then the account-level one.
export function resolveCodeFor(assignments: AssignmentRow[], accountId: string, unitId: string): AssignmentRow | null {
  const forAccount = assignments.filter((a) => a.accountId === accountId);
  return forAccount.find((a) => a.activityUnitId === unitId)
    ?? forAccount.find((a) => a.activityUnitId === null)
    ?? null;
}

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
  if (liveUnits.length === 0 && wp.rows.length > 0) {
    diagnostics.push({
      kind: 'no_units',
      severity: 'warning',
      message: 'No activity units configured — all balances fall to a single unresolved bucket. Add at least one unit in TB Settings.',
    });
  }

  // Per-account checks: unassigned, per-unit split gaps, utility usage.
  const utilityCodes = new Set(['DONOTMAP', 'MEMO', 'SUSPENSE', 'REPORTING_ONLY']);
  for (const row of wp.rows) {
    if (row.isVirtualRe) continue;
    const unitIds = row.units.length ? row.units.map((u) => u.unitId) : [ZERO_UUID];
    const accountLevel = resolveCodeFor(assignments, row.accountId, ZERO_UUID);
    if (!accountLevel && row.units.every((u) => !resolveCodeFor(assignments, row.accountId, u.unitId))) {
      diagnostics.push({
        kind: 'unassigned',
        severity: 'error',
        accountId: row.accountId,
        accountName: row.name,
        message: `${row.accountNumber ? row.accountNumber + ' ' : ''}${row.name} has no tax code assignment`,
      });
      continue;
    }
    // Tag-split gaps: a unit carrying balance without a resolvable code.
    if (row.units.length > 1) {
      for (const unitId of unitIds) {
        if (unitId === ZERO_UUID) continue;
        if (!resolveCodeFor(assignments, row.accountId, unitId)) {
          const unit = units.find((u) => u.id === unitId);
          diagnostics.push({
            kind: 'split_gap',
            severity: 'error',
            accountId: row.accountId,
            accountName: row.name,
            unitId,
            message: `${row.name} splits into ${unit?.displayName ?? 'a unit'} with no resolvable tax code for that activity`,
          });
        }
      }
    }
    const resolved = accountLevel ?? resolveCodeFor(assignments, row.accountId, unitIds[0] ?? ZERO_UUID);
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
