// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Account → tax code assignments (Phase 6.2/6C.1). The available-codes
// list is THE filtered surface (ADR-TB-02): pickers and the AI
// assignment service consume it — never the raw seed table (6C.1).

import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../db/index.js';
import {
  accounts, accountTaxAssignments, activityUnits, companyTaxProfiles, firmTaxCodes, taxCodes,
} from '../../db/schema/index.js';
import type { TbCopyAssignmentsInput } from '@kis-books/shared';
import { AppError } from '../../utils/errors.js';
import { auditLog } from '../../middleware/audit.js';
import { latestVersionForYear } from './tax-code-seed.service.js';
import { resolveOwner } from './firm-tax-codes.service.js';
import { isCodeAssignable } from './activity-units.service.js';
import { isBalanceSheetType } from './activity-view.service.js';
import { loadResolveContext, type ResolveContext } from './diagnostics.service.js';

// Resolve the seed version an entity reads codes from: pinned, else
// latest for the current calendar year, else the newest year available.
export async function resolveSeedVersionId(tenantId: string, companyId: string): Promise<string | null> {
  const [profile] = await db.select().from(companyTaxProfiles)
    .where(and(eq(companyTaxProfiles.tenantId, tenantId), eq(companyTaxProfiles.companyId, companyId)))
    .limit(1);
  if (!profile) return null;
  if (profile.pinnedSeedVersionId) return profile.pinnedSeedVersionId;
  const year = new Date().getUTCFullYear();
  const latest = await latestVersionForYear(year) ?? await latestVersionForYear(year - 1);
  return latest?.id ?? null;
}

// The filtered code list for this company: seed rows valid for its
// return form (form-specific + form/common + common/common utility)
// AND its activities — 'common' plus the profile's entity activity
// plus every live activity-unit type. Without the activity filter the
// picker repeats each code once per seed activity type.
// Plus the firm's active custom codes for the form.
export async function listAvailableCodes(tenantId: string, companyId: string) {
  const [profile] = await db.select().from(companyTaxProfiles)
    .where(and(eq(companyTaxProfiles.tenantId, tenantId), eq(companyTaxProfiles.companyId, companyId)))
    .limit(1);
  if (!profile) {
    throw AppError.unprocessableEntity('Set the company tax profile (return form) first', 'TB_NOT_ASSIGNABLE');
  }
  const versionId = await resolveSeedVersionId(tenantId, companyId);
  if (!versionId) {
    throw AppError.unprocessableEntity('No tax code seed imported', 'TB_SEED_INVALID');
  }
  const units = await db.select({ t: activityUnits.activityType }).from(activityUnits)
    .where(and(eq(activityUnits.companyId, companyId), sql`${activityUnits.archivedAt} IS NULL`));
  // Unit mapping mode: every code is assigned to a specific unit (or the
  // default unit), so the surface is exactly the live unit types — the
  // profile's entity activity no longer widens it.
  const allowedActivities = profile.taxCodeMappingMode === 'unit' && units.length > 0
    ? [...new Set(['common', ...units.map((u) => u.t)])]
    : [...new Set(['common', profile.defaultActivityType ?? 'business', ...units.map((u) => u.t)])];
  const seedCodes = await db.select({
    code: taxCodes.code,
    description: taxCodes.description,
    returnForm: taxCodes.returnForm,
    activityType: taxCodes.activityType,
    sortOrder: taxCodes.sortOrder,
    isM1Adjustment: taxCodes.isM1Adjustment,
  }).from(taxCodes)
    .where(and(
      eq(taxCodes.versionId, versionId),
      inArray(taxCodes.returnForm, [profile.returnForm, 'common']),
      inArray(taxCodes.activityType, allowedActivities),
    ))
    .orderBy(taxCodes.sortOrder, taxCodes.code);

  const owner = await resolveOwner(tenantId);
  const firmConds = [eq(firmTaxCodes.isActive, true), eq(firmTaxCodes.returnForm, profile.returnForm)];
  const firmRows = await db.select().from(firmTaxCodes).where(and(...firmConds));
  const firmCodesList = firmRows.filter((c) =>
    (c.firmId ? c.firmId === owner.firmId : c.tenantId === tenantId) &&
    allowedActivities.includes(c.activityType));

  return {
    returnForm: profile.returnForm,
    activityType: profile.defaultActivityType ?? 'business',
    taxCodeMappingMode: profile.taxCodeMappingMode === 'unit' ? 'unit' as const : 'account' as const,
    versionId,
    seedCodes,
    firmCodes: firmCodesList.map((c) => ({
      id: c.id,
      code: c.code,
      description: c.description,
      activityType: c.activityType,
      sortOrder: c.sortOrder,
      isM1Adjustment: c.isM1Adjustment,
    })),
  };
}

export interface SetAssignmentInput {
  accountId: string;
  activityUnitId?: string | null;
  seedCode?: string | null;
  seedActivityType?: string | null;
  firmCodeId?: string | null;
  source?: 'manual' | 'ai';
  aiConfidence?: number | null;
  effectiveTaxYear?: number | null;
  // Legacy: the client used to send the unit's activity type. The
  // server now derives it from activityUnitId (a body value could
  // otherwise write a business code onto a rental row); accepted and
  // ignored for compatibility.
  activityUnitType?: string;
}

// The activity context an assignment write validates against:
//   - a specific unit → that unit's type (+ common);
//   - account-level in 'unit' mode on a P&L account → the DEFAULT unit's
//     type (the account-level row IS the default unit's code);
//   - otherwise 'common' (account-level: any activity the entity runs).
function validationUnitType(
  ctx: ResolveContext,
  unitId: string | null,
  accountType: string,
): string {
  if (unitId) return ctx.unitTypeById.get(unitId) ?? 'common';
  if (ctx.mode === 'unit' && ctx.defaultUnitId && !isBalanceSheetType(accountType)) {
    return ctx.unitTypeById.get(ctx.defaultUnitId) ?? 'common';
  }
  return 'common';
}

// Upsert on the COALESCE unique index (uniq_account_tax_assignments).
// Drizzle's onConflict target can't express the COALESCE, so this is
// raw SQL; the values object is the full row minus ids. Returns whether
// a row was written (skip_existing → DO NOTHING may write none).
type AssignmentValues = {
  seedCode: string | null; seedActivityType: string | null; firmCodeId: string | null;
  source: 'manual' | 'ai'; aiConfidence: number | null; effectiveTaxYear: number | null;
  assignedBy: string | null; updatedAt: Date;
};
async function upsertAssignment(
  exec: { execute: typeof db.execute },
  ids: { tenantId: string; companyId: string; accountId: string; activityUnitId: string | null },
  v: AssignmentValues,
  onConflict: 'update' | 'nothing',
): Promise<boolean> {
  const conflict = sql`ON CONFLICT (company_id, account_id, COALESCE(activity_unit_id, '00000000-0000-0000-0000-000000000000'::uuid))`;
  const action = onConflict === 'update'
    ? sql`DO UPDATE SET seed_code = EXCLUDED.seed_code, seed_activity_type = EXCLUDED.seed_activity_type,
          firm_code_id = EXCLUDED.firm_code_id, source = EXCLUDED.source, ai_confidence = EXCLUDED.ai_confidence,
          effective_tax_year = EXCLUDED.effective_tax_year, assigned_by = EXCLUDED.assigned_by, updated_at = EXCLUDED.updated_at`
    : sql`DO NOTHING`;
  const res = await exec.execute(sql`
    INSERT INTO account_tax_assignments
      (tenant_id, company_id, account_id, activity_unit_id, seed_code, seed_activity_type, firm_code_id,
       source, ai_confidence, effective_tax_year, assigned_by, updated_at)
    VALUES (${ids.tenantId}, ${ids.companyId}, ${ids.accountId}, ${ids.activityUnitId}, ${v.seedCode}, ${v.seedActivityType}, ${v.firmCodeId},
       ${v.source}, ${v.aiConfidence}, ${v.effectiveTaxYear}, ${v.assignedBy}, ${v.updatedAt})
    ${conflict} ${action}
    RETURNING id
  `);
  return res.rows.length > 0;
}

export async function setAssignment(tenantId: string, companyId: string, input: SetAssignmentInput, userId?: string) {
  const hasSeed = !!(input.seedCode && input.seedActivityType);
  const hasFirm = !!input.firmCodeId;
  if (hasSeed === hasFirm) {
    throw AppError.badRequest('Provide exactly one of seed code or firm code', 'TB_NOT_ASSIGNABLE');
  }
  // The account must belong to this tenant/company; a unit must be one
  // of the company's own (body-supplied FKs are otherwise trusted).
  const [acct] = await db.select({ id: accounts.id, accountType: accounts.accountType }).from(accounts)
    .where(and(
      eq(accounts.tenantId, tenantId),
      eq(accounts.id, input.accountId),
      sql`(${accounts.companyId} = ${companyId} OR ${accounts.companyId} IS NULL)`,
    )).limit(1);
  if (!acct) throw AppError.notFound('Account not found');
  const ctx = await loadResolveContext(tenantId, companyId);
  let unitId = input.activityUnitId ?? null;
  if (unitId) {
    if (!ctx.unitTypeById.has(unitId)) {
      const [unit] = await db.select({ id: activityUnits.id }).from(activityUnits)
        .where(and(
          eq(activityUnits.tenantId, tenantId),
          eq(activityUnits.companyId, companyId),
          eq(activityUnits.id, unitId),
        )).limit(1);
      if (!unit) throw AppError.notFound('Activity unit not found');
    }
    if (ctx.mode === 'unit') {
      // Balance-sheet accounts never segment — they only ever carry the
      // account-level code.
      if (isBalanceSheetType(acct.accountType)) {
        throw AppError.unprocessableEntity(
          'Balance sheet accounts use the account-level tax code — they are never split by activity unit',
          'TB_NOT_ASSIGNABLE',
        );
      }
      // Invariant: the default unit ↔ the account-level row. A write
      // aimed at the default unit lands account-level so nothing can
      // shadow it.
      if (unitId === ctx.defaultUnitId) unitId = null;
    }
  }
  const check = await isCodeAssignable(tenantId, companyId, {
    seedCode: input.seedCode ?? null,
    seedActivityType: input.seedActivityType ?? null,
    firmCodeId: input.firmCodeId ?? null,
    activityUnitType: validationUnitType(ctx, unitId, acct.accountType),
  });
  if (!check.ok) throw AppError.unprocessableEntity(check.reason ?? 'Code not assignable', 'TB_NOT_ASSIGNABLE');

  return db.transaction(async (tx) => {
    // Prior row (for the audit diff). The write itself is a single
    // upsert on the COALESCE unique index, so two concurrent writes for
    // the same (account, unit) can no longer race into a unique
    // violation.
    const existing = await tx.select().from(accountTaxAssignments)
      .where(and(
        eq(accountTaxAssignments.companyId, companyId),
        eq(accountTaxAssignments.accountId, input.accountId),
      ));
    const match = existing.find((r) => (r.activityUnitId ?? null) === unitId) ?? null;
    const values = {
      seedCode: hasSeed ? input.seedCode! : null,
      seedActivityType: hasSeed ? input.seedActivityType! : null,
      firmCodeId: hasFirm ? input.firmCodeId! : null,
      source: input.source ?? 'manual',
      aiConfidence: input.aiConfidence ?? null,
      effectiveTaxYear: input.effectiveTaxYear ?? null,
      assignedBy: userId ?? null,
      updatedAt: new Date(),
    };
    await upsertAssignment(tx, { tenantId, companyId, accountId: input.accountId, activityUnitId: unitId }, values, 'update');
    const [row] = await tx.select().from(accountTaxAssignments)
      .where(and(
        eq(accountTaxAssignments.companyId, companyId),
        eq(accountTaxAssignments.accountId, input.accountId),
        unitId ? eq(accountTaxAssignments.activityUnitId, unitId) : sql`${accountTaxAssignments.activityUnitId} IS NULL`,
      )).limit(1);
    if (!row) throw AppError.internal('Assignment write failed');
    await auditLog(tenantId, match ? 'update' : 'create', 'account_tax_assignment', row.id, match, row, userId, tx);
    return row;
  });
}

export async function clearAssignment(tenantId: string, companyId: string, accountId: string, activityUnitId: string | null, userId?: string) {
  const existing = await db.select().from(accountTaxAssignments)
    .where(and(
      eq(accountTaxAssignments.tenantId, tenantId),
      eq(accountTaxAssignments.companyId, companyId),
      eq(accountTaxAssignments.accountId, accountId),
    ));
  const match = existing.find((r) => (r.activityUnitId ?? null) === (activityUnitId ?? null));
  if (!match) return;
  await db.transaction(async (tx) => {
    await tx.delete(accountTaxAssignments).where(eq(accountTaxAssignments.id, match.id));
    await auditLog(tenantId, 'delete', 'account_tax_assignment', match.id, match, null, userId, tx);
  });
}

export async function bulkAssign(tenantId: string, companyId: string, inputs: SetAssignmentInput[], userId?: string) {
  const results: Array<{ accountId: string; ok: boolean; error?: string }> = [];
  for (const input of inputs) {
    try {
      await setAssignment(tenantId, companyId, input, userId);
      results.push({ accountId: input.accountId, ok: true });
    } catch (err) {
      results.push({
        accountId: input.accountId,
        ok: false,
        error: err instanceof AppError ? err.message : 'Assignment failed',
      });
    }
  }
  return results;
}

// ── Copy mappings between activity units ────────────────────────────
//
// Source = a unit's rows (or, with sourceUnitId = null, the account-level
// rows = the default unit's codes). Targets = live NON-default units
// (the default unit is always represented by the account-level row).
// Balance-sheet accounts never segment and are skipped. A code is
// copied only if it is assignable to the target unit's activity type
// (common/common utility rows always are); everything else is reported,
// never silently written. One transaction, one upsert per row on the
// COALESCE unique index, one audit row per call.

export type CopySkipReason = 'existing' | 'incompatible_activity' | 'missing_from_seed' | 'inactive_firm_code';

export interface CopyAssignmentsResult {
  dryRun: boolean;
  mode: 'skip_existing' | 'overwrite';
  sourceUnitId: string | null;
  copied: number;
  skippedExisting: number;
  skippedIncompatible: number;
  perTarget: Array<{
    unitId: string;
    displayName: string;
    instanceNumber: number;
    activityType: string;
    copied: number;
    overwritten: number;
    skippedExisting: number;
    skippedIncompatible: number;
    incompatible: Array<{ accountId: string; code: string; reason: CopySkipReason }>;
  }>;
}

export async function copyAssignments(
  tenantId: string,
  companyId: string,
  input: TbCopyAssignmentsInput,
  userId?: string,
): Promise<CopyAssignmentsResult> {
  const [profile] = await db.select().from(companyTaxProfiles)
    .where(and(eq(companyTaxProfiles.tenantId, tenantId), eq(companyTaxProfiles.companyId, companyId))).limit(1);
  if (!profile) throw AppError.unprocessableEntity('Set the company tax profile (return form) first', 'TB_NOT_ASSIGNABLE');
  const units = await db.select().from(activityUnits)
    .where(and(eq(activityUnits.tenantId, tenantId), eq(activityUnits.companyId, companyId)));
  const unitById = new Map(units.map((u) => [u.id, u]));
  const defaultUnit = units.find((u) => u.isDefault && !u.archivedAt) ?? null;

  if (input.sourceUnitId && !unitById.has(input.sourceUnitId)) throw AppError.notFound('Source activity unit not found');
  const targets = [...new Set(input.targetUnitIds)]
    .filter((id) => id !== input.sourceUnitId)
    .map((id) => {
      const u = unitById.get(id);
      if (!u) throw AppError.notFound('Target activity unit not found');
      if (u.archivedAt) throw AppError.badRequest(`"${u.displayName}" is archived — reactivate or pick a live unit`, 'TB_UNIT_IN_USE');
      if (defaultUnit && u.id === defaultUnit.id) {
        throw AppError.badRequest(
          `"${u.displayName}" is the default unit — it uses the account-level codes, so there is nothing to copy onto it`,
          'TB_NOT_ASSIGNABLE',
        );
      }
      return u;
    });
  if (targets.length === 0) throw AppError.badRequest('Pick at least one target unit other than the source', 'TB_NOT_ASSIGNABLE');

  const all = await db.select().from(accountTaxAssignments)
    .where(and(eq(accountTaxAssignments.tenantId, tenantId), eq(accountTaxAssignments.companyId, companyId)));
  const accountFilter = input.accountIds ? new Set(input.accountIds) : null;
  const sourceRows = all.filter((r) =>
    (r.activityUnitId ?? null) === (input.sourceUnitId ?? null)
    && (!accountFilter || accountFilter.has(r.accountId)));

  // Balance-sheet accounts never take unit rows.
  const acctIds = [...new Set(sourceRows.map((r) => r.accountId))];
  const acctTypes = new Map<string, string>();
  if (acctIds.length) {
    const rows = await db.select({ id: accounts.id, accountType: accounts.accountType }).from(accounts)
      .where(inArray(accounts.id, acctIds));
    for (const r of rows) acctTypes.set(r.id, r.accountType);
  }
  const plRows = sourceRows.filter((r) => !isBalanceSheetType(acctTypes.get(r.accountId) ?? ''));

  // Assignability in memory: the seed version's rows for this form once,
  // plus the referenced firm codes once.
  const versionId = await resolveSeedVersionId(tenantId, companyId);
  const seedRows = versionId
    ? await db.select({ code: taxCodes.code, activityType: taxCodes.activityType, returnForm: taxCodes.returnForm }).from(taxCodes)
      .where(and(eq(taxCodes.versionId, versionId), inArray(taxCodes.returnForm, [profile.returnForm, 'common'])))
    : [];
  const seedByKey = new Map<string, Array<{ returnForm: string; activityType: string }>>();
  for (const r of seedRows) {
    const k = `${r.code}|${r.activityType}`;
    seedByKey.set(k, [...(seedByKey.get(k) ?? []), r]);
  }
  const firmIds = [...new Set(plRows.map((r) => r.firmCodeId).filter((x): x is string => !!x))];
  const firmById = new Map<string, { activityType: string; returnForm: string; isActive: boolean }>();
  if (firmIds.length) {
    const rows = await db.select().from(firmTaxCodes).where(inArray(firmTaxCodes.id, firmIds));
    for (const r of rows) firmById.set(r.id, { activityType: r.activityType, returnForm: r.returnForm, isActive: r.isActive });
  }
  const assignableTo = (row: typeof plRows[number], targetType: string): CopySkipReason | null => {
    if (row.firmCodeId) {
      const fc = firmById.get(row.firmCodeId);
      if (!fc || !fc.isActive) return 'inactive_firm_code';
      if (fc.returnForm !== profile.returnForm) return 'incompatible_activity';
      return fc.activityType === 'common' || fc.activityType === targetType ? null : 'incompatible_activity';
    }
    const candidates = seedByKey.get(`${row.seedCode}|${row.seedActivityType}`) ?? [];
    if (candidates.length === 0) return 'missing_from_seed';
    const ok = candidates.some((c) =>
      (c.returnForm === 'common' && c.activityType === 'common')
      || (c.returnForm === profile.returnForm && (c.activityType === 'common' || c.activityType === targetType)));
    return ok ? null : 'incompatible_activity';
  };

  const existingKey = new Set(all.map((r) => `${r.accountId}|${r.activityUnitId ?? ''}`));
  const result: CopyAssignmentsResult = {
    dryRun: !!input.dryRun,
    mode: input.mode,
    sourceUnitId: input.sourceUnitId ?? null,
    copied: 0, skippedExisting: 0, skippedIncompatible: 0,
    perTarget: [],
  };
  const writes: Array<{ target: typeof targets[number]; row: typeof plRows[number]; overwrite: boolean }> = [];
  for (const target of targets) {
    const pt = {
      unitId: target.id, displayName: target.displayName, instanceNumber: target.instanceNumber, activityType: target.activityType,
      copied: 0, overwritten: 0, skippedExisting: 0, skippedIncompatible: 0,
      incompatible: [] as Array<{ accountId: string; code: string; reason: CopySkipReason }>,
    };
    for (const row of plRows) {
      const exists = existingKey.has(`${row.accountId}|${target.id}`);
      if (exists && input.mode === 'skip_existing') { pt.skippedExisting++; continue; }
      const reason = assignableTo(row, target.activityType);
      if (reason) {
        pt.skippedIncompatible++;
        pt.incompatible.push({ accountId: row.accountId, code: row.seedCode ?? 'FIRM', reason });
        continue;
      }
      if (exists) pt.overwritten++;
      pt.copied++;
      writes.push({ target, row, overwrite: exists });
    }
    result.copied += pt.copied;
    result.skippedExisting += pt.skippedExisting;
    result.skippedIncompatible += pt.skippedIncompatible;
    result.perTarget.push(pt);
  }
  if (input.dryRun || writes.length === 0) return result;

  await db.transaction(async (tx) => {
    for (const w of writes) {
      const values = {
        seedCode: w.row.seedCode,
        seedActivityType: w.row.seedActivityType,
        firmCodeId: w.row.firmCodeId,
        source: 'manual' as const,
        aiConfidence: null,
        effectiveTaxYear: null,
        assignedBy: userId ?? null,
        updatedAt: new Date(),
      };
      await upsertAssignment(
        tx,
        { tenantId, companyId, accountId: w.row.accountId, activityUnitId: w.target.id },
        values,
        input.mode === 'overwrite' ? 'update' : 'nothing',
      );
    }
    await auditLog(tenantId, 'update', 'account_tax_assignment_copy', companyId, null, {
      sourceUnitId: input.sourceUnitId ?? null,
      targetUnitIds: targets.map((t) => t.id),
      mode: input.mode,
      accountIds: input.accountIds ?? null,
      copied: result.copied,
      skippedExisting: result.skippedExisting,
      skippedIncompatible: result.skippedIncompatible,
    }, userId, tx);
  });
  return result;
}
