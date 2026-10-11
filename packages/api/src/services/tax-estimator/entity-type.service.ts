// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Entity tax type + tax method resolution (MODULE.md D3) and the per-request
// entity scope guard every Phase 4 service runs FIRST (D1).

import { and, eq } from 'drizzle-orm';
import type { EntityTaxType, EntityTypeSource, ResolvedEntityTax, TaxEstimatorWarning, TaxMethod } from '@kis-books/shared';
import { db } from '../../db/index.js';
import {
  accounts, accountTaxAssignments, companies, companyTaxProfiles, firmTaxCodes, taxEstEntitySettings,
} from '../../db/schema/index.js';
import { AppError } from '../../utils/errors.js';
import { isTenantInScope, type FirmScope } from './firm-scope.service.js';

export interface ScopedCompany {
  tenantId: string;
  companyId: string;
  businessName: string;
  entityType: string | null;
  accountingMethod: string | null;
  fiscalYearStartMonth: number;
  lockDate: string | null;
}

export function notManaged(): AppError {
  // 404 (not 403) so the response never confirms that a tenant exists.
  return new AppError(404, 'Company not found', 'TE_TENANT_NOT_MANAGED');
}

/**
 * The D1 guard. Throws TE_TENANT_NOT_MANAGED (404) when `tenantId` is not in the
 * server-resolved scope — BEFORE any query — then loads the company strictly
 * by (tenant_id, id) so a company id from another tenant can never be paired
 * with an in-scope tenant id.
 */
export async function assertEntityInScope(scope: FirmScope, tenantId: string, companyId: string): Promise<ScopedCompany> {
  if (!isTenantInScope(scope, tenantId)) throw notManaged();
  const [c] = await db.select({
    businessName: companies.businessName,
    entityType: companies.entityType,
    accountingMethod: companies.accountingMethod,
    fiscalYearStartMonth: companies.fiscalYearStartMonth,
    lockDate: companies.lockDate,
  }).from(companies)
    .where(and(eq(companies.tenantId, tenantId), eq(companies.id, companyId)))
    .limit(1);
  if (!c) throw new AppError(404, 'Company not found', 'TE_COMPANY_NOT_FOUND');
  return {
    tenantId,
    companyId,
    businessName: c.businessName,
    entityType: c.entityType,
    accountingMethod: c.accountingMethod,
    fiscalYearStartMonth: c.fiscalYearStartMonth ?? 1,
    lockDate: c.lockDate,
  };
}

/** Throw-free variant for taxpayer-level rollups: a link whose tenant left the scope becomes a warning (D1). */
export function scopeWarningForLink(scope: FirmScope, tenantId: string, label: string): TaxEstimatorWarning | null {
  if (isTenantInScope(scope, tenantId)) return null;
  return {
    code: 'TE_TENANT_NOT_MANAGED',
    severity: 'warning',
    message: `${label} is in a client the firm no longer manages (or you can no longer reach); it is left out of the estimate.`,
  };
}

const TB_FORM_TO_TYPE: Record<string, EntityTaxType> = {
  '1065': 'partnership',
  '1120S': 's_corp',
  '1120': 'c_corp',
};

const COMPANY_ENTITY_TO_TYPE: Record<string, EntityTaxType> = {
  sole_prop: 'sch_c',
  single_member_llc: 'sch_c',
  s_corp: 's_corp',
  c_corp: 'c_corp',
  partnership: 'partnership',
};

const FARM_ACTIVITIES = new Set(['farm', 'farm_rental']);

/**
 * 1040 → sch_f when the profile's default activity is farm/farm_rental, or when
 * a majority of the P&L accounts with a TB assignment carry a farm/farm_rental
 * code; otherwise sch_c. Exported for tests.
 */
export function decide1040Type(defaultActivityType: string | null, activityCounts: Map<string, number>): {
  type: EntityTaxType; rentalMajority: boolean;
} {
  let farm = 0;
  let total = 0;
  let rental = 0;
  for (const [act, n] of activityCounts) {
    if (act === 'common') continue;
    total += n;
    if (FARM_ACTIVITIES.has(act)) farm += n;
    if (act === 'rental') rental += n;
  }
  if (defaultActivityType && FARM_ACTIVITIES.has(defaultActivityType)) return { type: 'sch_f', rentalMajority: false };
  if (total > 0 && farm * 2 > total) return { type: 'sch_f', rentalMajority: false };
  return { type: 'sch_c', rentalMajority: defaultActivityType === 'rental' || (total > 0 && rental * 2 > total) };
}

async function assignmentActivityCounts(tenantId: string, companyId: string): Promise<Map<string, number>> {
  const rows = await db.select({
    seedActivityType: accountTaxAssignments.seedActivityType,
    firmActivityType: firmTaxCodes.activityType,
    accountType: accounts.accountType,
  }).from(accountTaxAssignments)
    .innerJoin(accounts, and(eq(accounts.id, accountTaxAssignments.accountId), eq(accounts.tenantId, tenantId)))
    .leftJoin(firmTaxCodes, eq(firmTaxCodes.id, accountTaxAssignments.firmCodeId))
    .where(and(eq(accountTaxAssignments.tenantId, tenantId), eq(accountTaxAssignments.companyId, companyId)));
  const counts = new Map<string, number>();
  for (const r of rows) {
    if (!['revenue', 'cogs', 'expense', 'other_revenue', 'other_expense'].includes(r.accountType)) continue;
    const act = r.seedActivityType ?? r.firmActivityType;
    if (!act) continue;
    counts.set(act, (counts.get(act) ?? 0) + 1);
  }
  return counts;
}

/** Resolution for an entity ALREADY verified by assertEntityInScope. */
export async function resolveForCompany(company: ScopedCompany): Promise<ResolvedEntityTax> {
  const { tenantId, companyId } = company;
  const [[profile], [settings]] = await Promise.all([
    db.select({ returnForm: companyTaxProfiles.returnForm, defaultActivityType: companyTaxProfiles.defaultActivityType })
      .from(companyTaxProfiles)
      .where(and(eq(companyTaxProfiles.tenantId, tenantId), eq(companyTaxProfiles.companyId, companyId)))
      .limit(1),
    db.select({ taxEntityType: taxEstEntitySettings.taxEntityType, taxMethod: taxEstEntitySettings.taxMethod })
      .from(taxEstEntitySettings)
      .where(and(eq(taxEstEntitySettings.tenantId, tenantId), eq(taxEstEntitySettings.companyId, companyId)))
      .limit(1),
  ]);
  const warnings: TaxEstimatorWarning[] = [];

  let entityType: EntityTaxType | null = null;
  let entityTypeSource: EntityTypeSource = 'none';
  if (profile) {
    if (profile.returnForm === '1040') {
      const d = decide1040Type(profile.defaultActivityType, await assignmentActivityCounts(tenantId, companyId));
      entityType = d.type;
      if (d.rentalMajority) {
        warnings.push({
          code: 'TE_ENTITY_1040_RENTAL', severity: 'warning',
          message: 'The TB profile is a 1040 rental activity; the estimator treats it as Schedule C. Check the owner link activity type (rental) and the rental QBI setting.',
        });
      }
    } else {
      entityType = TB_FORM_TO_TYPE[profile.returnForm] ?? null;
    }
    if (entityType) entityTypeSource = 'tb_profile';
    if (entityType && settings?.taxEntityType && settings.taxEntityType !== entityType) {
      warnings.push({
        code: 'TE_ENTITY_TYPE_SETTING_IGNORED', severity: 'info',
        message: `The Trial Balance tax profile (${profile.returnForm}) decides the entity type; the estimator setting (${settings.taxEntityType}) is ignored.`,
      });
    }
  }
  if (!entityType && settings?.taxEntityType) {
    entityType = settings.taxEntityType as EntityTaxType;
    entityTypeSource = 'estimator_setting';
  }
  if (!entityType && company.entityType && COMPANY_ENTITY_TO_TYPE[company.entityType]) {
    entityType = COMPANY_ENTITY_TO_TYPE[company.entityType]!;
    entityTypeSource = 'company_entity_type';
    warnings.push({
      code: 'TE_ENTITY_TYPE_FROM_COMPANY', severity: 'info',
      message: `Entity tax type taken from the company's entity type (${company.entityType}); set a TB tax profile or the estimator entity type to confirm it.`,
    });
  }
  if (!entityType) {
    warnings.push({ code: 'TE_ENTITY_TYPE_MISSING', severity: 'warning', message: 'No entity tax type: set a TB tax profile or the estimator entity type.' });
  }

  const booksMethod: TaxMethod = company.accountingMethod === 'cash' ? 'cash' : 'accrual';
  if (company.accountingMethod !== 'cash' && company.accountingMethod !== 'accrual' && !settings?.taxMethod) {
    warnings.push({ code: 'TE_TAX_METHOD_MISSING', severity: 'warning', message: 'The company has no accounting method; accrual is assumed. Set the tax method.' });
  }
  const taxMethod: TaxMethod = settings?.taxMethod === 'cash' || settings?.taxMethod === 'accrual' ? settings.taxMethod : booksMethod;

  return {
    tenantId,
    companyId,
    companyName: company.businessName,
    entityType,
    entityTypeSource,
    taxMethod,
    taxMethodSource: settings?.taxMethod ? 'estimator_setting' : 'company_accounting_method',
    booksMethod,
    tbReturnForm: profile?.returnForm ?? null,
    tbDefaultActivityType: profile?.defaultActivityType ?? null,
    fiscalYearStartMonth: company.fiscalYearStartMonth,
    closingDate: company.lockDate,
    warnings,
  };
}

export async function resolveEntityTax(scope: FirmScope, tenantId: string, companyId: string): Promise<ResolvedEntityTax> {
  const company = await assertEntityInScope(scope, tenantId, companyId);
  return resolveForCompany(company);
}
