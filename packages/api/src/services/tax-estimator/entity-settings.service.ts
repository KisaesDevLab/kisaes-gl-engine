// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Estimator-owned entity tax fields (tax_est_entity_settings) and per-year
// inputs (tax_est_entity_year_inputs: W-2 wage override + UBIA, D8; projection method, Q46;
// per-year entity type override, Q49).
// Every function runs the D1 scope guard first; writes are audited against
// the BOOKS tenant (the tenant whose company the row describes).

import { and, eq } from 'drizzle-orm';
import type {
  EntitySettingsDto, EntitySettingsResponse, EntityTaxType, EntityYearInputsDto, ProjectionMethod, TaxMethod,
  UpsertEntitySettingsInput, UpsertEntityYearInputsInput,
} from '@kis-books/shared';
import { DEFAULT_PROJECTION_METHOD } from '@kis-books/shared';
import { db } from '../../db/index.js';
import { taxEstEntitySettings, taxEstEntityYearInputs } from '../../db/schema/index.js';
import { auditLog } from '../../middleware/audit.js';
import { AppError } from '../../utils/errors.js';
import { baseScope, type FirmScope } from './firm-scope.service.js';
import { assertEntityInScope, resolveForCompany } from './entity-type.service.js';

type SettingsRow = typeof taxEstEntitySettings.$inferSelect;
type YearRow = typeof taxEstEntityYearInputs.$inferSelect;

function toSettingsDto(tenantId: string, companyId: string, row: SettingsRow | undefined): EntitySettingsDto {
  return {
    tenantId,
    companyId,
    taxEntityType: (row?.taxEntityType as EntityTaxType | null | undefined) ?? null,
    taxMethod: (row?.taxMethod as TaxMethod | null | undefined) ?? null,
    isSstb: row?.isSstb ?? false,
    largeCorporation: row?.largeCorporation ?? false,
    farmerOverride: row?.farmerOverride ?? null,
    rentalQbiTradeOrBusiness: row?.rentalQbiTradeOrBusiness ?? false,
    stateSourcing: row?.stateSourcing ?? null,
    updatedAt: row?.updatedAt ? row.updatedAt.toISOString() : null,
  };
}

function toYearDto(tenantId: string, companyId: string, taxYear: number, row: YearRow | undefined): EntityYearInputsDto {
  return {
    tenantId,
    companyId,
    taxYear,
    w2WagesOverride: row?.w2WagesOverride ?? null,
    w2WagesOverrideReason: row?.w2WagesOverrideReason ?? null,
    ubia: row?.ubia ?? null,
    includeSehiInW2Wages: row?.includeSehiInW2Wages ?? false,
    projectionMethod: (row?.projectionMethod as ProjectionMethod | undefined) ?? DEFAULT_PROJECTION_METHOD,
    entityTypeOverride: (row?.entityTypeOverride as EntityTaxType | null | undefined) ?? null,
    updatedAt: row?.updatedAt ? row.updatedAt.toISOString() : null,
  };
}

async function loadSettingsRow(tenantId: string, companyId: string): Promise<SettingsRow | undefined> {
  const [row] = await db.select().from(taxEstEntitySettings)
    .where(and(eq(taxEstEntitySettings.tenantId, tenantId), eq(taxEstEntitySettings.companyId, companyId)))
    .limit(1);
  return row;
}

/**
 * `taxYear` (Q49): resolve the entity type for that tax year, so the entity year's override (when
 * set) decides it. Omitted = the year-less D3 resolution (no override applies).
 */
export async function getEntitySettings(scope: FirmScope, tenantId: string, companyId: string, taxYear?: number | null): Promise<EntitySettingsResponse> {
  const company = await assertEntityInScope(scope, tenantId, companyId);
  const row = await loadSettingsRow(tenantId, companyId);
  return { settings: toSettingsDto(tenantId, companyId, row), resolved: await resolveForCompany(company, taxYear) };
}

export async function upsertEntitySettings(
  scope: FirmScope, tenantId: string, companyId: string, input: UpsertEntitySettingsInput, userId?: string, taxYear?: number | null,
): Promise<EntitySettingsResponse> {
  scope = baseScope(scope); // D18: entity writes never use a staff-list widening
  const company = await assertEntityInScope(scope, tenantId, companyId);
  await db.transaction(async (tx) => {
    const [before] = await tx.select().from(taxEstEntitySettings)
      .where(and(eq(taxEstEntitySettings.tenantId, tenantId), eq(taxEstEntitySettings.companyId, companyId)))
      .for('update')
      .limit(1);
    const patch = {
      ...(input.taxEntityType !== undefined ? { taxEntityType: input.taxEntityType } : {}),
      ...(input.taxMethod !== undefined ? { taxMethod: input.taxMethod } : {}),
      ...(input.isSstb !== undefined ? { isSstb: input.isSstb } : {}),
      ...(input.largeCorporation !== undefined ? { largeCorporation: input.largeCorporation } : {}),
      ...(input.farmerOverride !== undefined ? { farmerOverride: input.farmerOverride } : {}),
      ...(input.rentalQbiTradeOrBusiness !== undefined ? { rentalQbiTradeOrBusiness: input.rentalQbiTradeOrBusiness } : {}),
      ...(input.stateSourcing !== undefined ? { stateSourcing: input.stateSourcing } : {}),
      updatedBy: userId ?? null,
      updatedAt: new Date(),
    };
    const [after] = before
      ? await tx.update(taxEstEntitySettings).set(patch)
        .where(and(eq(taxEstEntitySettings.tenantId, tenantId), eq(taxEstEntitySettings.id, before.id)))
        .returning()
      : await tx.insert(taxEstEntitySettings).values({ tenantId, companyId, ...patch }).returning();
    await auditLog(tenantId, before ? 'update' : 'create', 'tax_est_entity_settings', after!.id, before ?? null, after, userId, tx);
  });
  const row = await loadSettingsRow(tenantId, companyId);
  return { settings: toSettingsDto(tenantId, companyId, row), resolved: await resolveForCompany(company, taxYear) };
}

export async function getYearInputs(scope: FirmScope, tenantId: string, companyId: string, taxYear: number): Promise<EntityYearInputsDto> {
  await assertEntityInScope(scope, tenantId, companyId);
  const [row] = await db.select().from(taxEstEntityYearInputs)
    .where(and(
      eq(taxEstEntityYearInputs.tenantId, tenantId),
      eq(taxEstEntityYearInputs.companyId, companyId),
      eq(taxEstEntityYearInputs.taxYear, taxYear),
    ))
    .limit(1);
  return toYearDto(tenantId, companyId, taxYear, row);
}

export async function upsertYearInputs(
  scope: FirmScope, tenantId: string, companyId: string, taxYear: number, input: UpsertEntityYearInputsInput, userId?: string,
): Promise<EntityYearInputsDto> {
  scope = baseScope(scope); // D18
  const company = await assertEntityInScope(scope, tenantId, companyId);
  // Q49: the switches below are checked against the EFFECTIVE entity type for this year — the
  // override this request sets (or clears), else the one already stored, else the D3 precedence.
  const effectiveType = async (): Promise<EntityTaxType | null> => {
    if (input.entityTypeOverride !== undefined && input.entityTypeOverride !== null) return input.entityTypeOverride;
    return (await resolveForCompany(company, input.entityTypeOverride === null ? null : taxYear)).entityType;
  };
  // QA2-03: the >2% shareholder health switch exists only for S corporations (Q41).
  if (input.includeSehiInW2Wages === true && (await effectiveType()) !== 's_corp') {
    throw new AppError(422, 'Including >2% shareholder health insurance in W-2 wages applies to S corporations only', 'TE_SEHI_W2_S_CORP_ONLY');
  }
  // Q46: prior-year trend methods are for individual-path entities (a C corporation keeps the run rate).
  if (input.projectionMethod && input.projectionMethod !== DEFAULT_PROJECTION_METHOD && (await effectiveType()) === 'c_corp') {
    throw new AppError(422, 'Prior-year trend projection applies to pass-through and Schedule C / F businesses only, not C corporations', 'TE_PROJECTION_METHOD_NOT_SUPPORTED');
  }
  const after = await db.transaction(async (tx) => {
    const [before] = await tx.select().from(taxEstEntityYearInputs)
      .where(and(
        eq(taxEstEntityYearInputs.tenantId, tenantId),
        eq(taxEstEntityYearInputs.companyId, companyId),
        eq(taxEstEntityYearInputs.taxYear, taxYear),
      ))
      .for('update')
      .limit(1);
    const override = input.w2WagesOverride !== undefined ? input.w2WagesOverride : before?.w2WagesOverride ?? null;
    const reason = override === null ? null
      : (input.w2WagesOverrideReason !== undefined ? input.w2WagesOverrideReason : before?.w2WagesOverrideReason ?? null);
    if (override !== null && !(reason ?? '').trim()) {
      throw AppError.badRequest('A reason is required when overriding W-2 wages', 'TE_W2_OVERRIDE_REASON');
    }
    const patch = {
      w2WagesOverride: override,
      // A cleared override clears its reason too (the CHECK requires one only while set).
      w2WagesOverrideReason: reason,
      ...(input.ubia !== undefined ? { ubia: input.ubia } : {}),
      ...(input.includeSehiInW2Wages !== undefined ? { includeSehiInW2Wages: input.includeSehiInW2Wages } : {}),
      ...(input.projectionMethod !== undefined ? { projectionMethod: input.projectionMethod } : {}),
      ...(input.entityTypeOverride !== undefined ? { entityTypeOverride: input.entityTypeOverride } : {}),
      updatedBy: userId ?? null,
      updatedAt: new Date(),
    };
    const [row] = before
      ? await tx.update(taxEstEntityYearInputs).set(patch)
        .where(and(eq(taxEstEntityYearInputs.tenantId, tenantId), eq(taxEstEntityYearInputs.id, before.id)))
        .returning()
      : await tx.insert(taxEstEntityYearInputs).values({ tenantId, companyId, taxYear, ...patch }).returning();
    await auditLog(tenantId, before ? 'update' : 'create', 'tax_est_entity_year_inputs', row!.id, before ?? null, row, userId, tx);
    return row!;
  });
  return toYearDto(tenantId, companyId, taxYear, after);
}
