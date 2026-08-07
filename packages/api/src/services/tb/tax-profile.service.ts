// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Company tax profile (Phase 3.1, D11): return form, seed-version
// pinning, and the fiscal/tax-year display data derived from the
// company's fiscal calendar (month-granular — rule TB10).

import { eq, and } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { companies, companyTaxProfiles, taxCodeSeedVersions } from '../../db/schema/index.js';
import type { z } from 'zod';
import { upsertTaxProfileSchema } from '@kis-books/shared';
import { AppError } from '../../utils/errors.js';
import { auditLog } from '../../middleware/audit.js';

type UpsertInput = z.infer<typeof upsertTaxProfileSchema>;

// Tax year of a date under a fiscal calendar: the calendar year in
// which the fiscal year ENDS (a FY2025 return covers the FY ending in
// 2025). UTC getters, matching report.service fiscal math.
export function taxYearOf(dateIso: string, fiscalYearStartMonth: number): number {
  const d = new Date(`${dateIso}T00:00:00Z`);
  if (fiscalYearStartMonth <= 1) return d.getUTCFullYear();
  // FY starting in month m of year Y ends in year Y+1; dates before m
  // belong to the FY that started the previous calendar year.
  return d.getUTCMonth() + 1 >= fiscalYearStartMonth ? d.getUTCFullYear() + 1 : d.getUTCFullYear();
}

// Fiscal-year end date (ISO) for a given tax year label.
export function fiscalYearEnd(taxYear: number, fiscalYearStartMonth: number): string {
  if (fiscalYearStartMonth <= 1) return `${taxYear}-12-31`;
  // FY ends the day before the start month, in the label year.
  const endMonth = fiscalYearStartMonth - 1;
  const lastDay = new Date(Date.UTC(taxYear, endMonth, 0)).getUTCDate();
  return `${taxYear}-${String(endMonth).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
}

export async function getProfile(tenantId: string, companyId: string) {
  const [company] = await db.select({
    fiscalYearStartMonth: companies.fiscalYearStartMonth,
    accountingMethod: companies.accountingMethod,
    lockDate: companies.lockDate,
  }).from(companies)
    .where(and(eq(companies.tenantId, tenantId), eq(companies.id, companyId)))
    .limit(1);
  if (!company) throw AppError.notFound('Company not found');

  const [profile] = await db.select().from(companyTaxProfiles)
    .where(and(eq(companyTaxProfiles.tenantId, tenantId), eq(companyTaxProfiles.companyId, companyId)))
    .limit(1);

  const fyStartMonth = company.fiscalYearStartMonth ?? 1;
  const today = new Date().toISOString().slice(0, 10);
  const currentTaxYear = taxYearOf(today, fyStartMonth);
  let pinnedVersion = null;
  if (profile?.pinnedSeedVersionId) {
    const [v] = await db.select().from(taxCodeSeedVersions)
      .where(eq(taxCodeSeedVersions.id, profile.pinnedSeedVersionId)).limit(1);
    pinnedVersion = v ?? null;
  }
  return {
    profile: profile ?? null,
    pinnedVersion,
    fiscal: {
      fiscalYearStartMonth: fyStartMonth,
      accountingMethod: company.accountingMethod,
      currentTaxYear,
      currentFiscalYearEnd: fiscalYearEnd(currentTaxYear, fyStartMonth),
      priorFiscalYearEnd: fiscalYearEnd(currentTaxYear - 1, fyStartMonth),
    },
  };
}

export async function upsertProfile(tenantId: string, companyId: string, input: UpsertInput, userId?: string) {
  if (input.pinnedSeedVersionId) {
    const [v] = await db.select({ id: taxCodeSeedVersions.id }).from(taxCodeSeedVersions)
      .where(eq(taxCodeSeedVersions.id, input.pinnedSeedVersionId)).limit(1);
    if (!v) throw AppError.badRequest('Unknown seed version', 'TB_SEED_INVALID');
  }
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(companyTaxProfiles)
      .where(and(eq(companyTaxProfiles.tenantId, tenantId), eq(companyTaxProfiles.companyId, companyId)))
      .limit(1);
    let row;
    if (before) {
      [row] = await tx.update(companyTaxProfiles).set({
        returnForm: input.returnForm,
        pinnedSeedVersionId: input.pinnedSeedVersionId ?? null,
        sCorpElectionDate: input.sCorpElectionDate ?? null,
        defaultActivityType: input.defaultActivityType ?? before.defaultActivityType,
        updatedAt: new Date(),
      }).where(eq(companyTaxProfiles.id, before.id)).returning();
    } else {
      [row] = await tx.insert(companyTaxProfiles).values({
        tenantId,
        companyId,
        returnForm: input.returnForm,
        pinnedSeedVersionId: input.pinnedSeedVersionId ?? null,
        sCorpElectionDate: input.sCorpElectionDate ?? null,
        defaultActivityType: input.defaultActivityType ?? 'business',
      }).returning();
    }
    if (!row) throw AppError.internal('Tax profile write failed');
    await auditLog(tenantId, before ? 'update' : 'create', 'company_tax_profile', row.id, before ?? null, row, userId, tx);
    return row;
  });
}
