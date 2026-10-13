// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Owner splits + owner candidates for person-target treatments (OPEN-QUESTIONS Q50).
//
//   owner candidates = persons of the caller's VISIBLE taxpayers (D17 / D18 predicate on the
//     caller's BASE scope — the picker feeds a write) that have a tax_est_links row to THIS
//     business (tenant + company, any tax year), on an active taxpayer. Nothing else may be
//     picked as the target of an owner item (W-2 wages person, owner / officer SEHI, owner /
//     officer retirement, guaranteed payment) or an estimated-tax payment account; the
//     treatments service enforces it for every NEW target (422 TE_TARGET_NOT_LINKED).
//   linked targets   = the same link set WITHOUT the viewer filter: what the provider uses to
//     warn about stored targets that are not (or no longer) linked (TE_TARGET_NOT_LINKED,
//     the estimate keeps computing them).
//
// Every query is pinned to the single tenant verified by the caller (assertEntityInScope).

import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { OwnerCandidateDto, OwnerCandidatesDto, SplitMode, TreatmentSplitDto } from '@kis-books/shared';
import { defaultOwnerPcts } from '@kis-books/shared';
import { db } from '../../db/index.js';
import {
  taxEstAccountTreatments, taxEstAccountTreatmentSplits, taxEstLinks, taxEstPersons, taxEstTaxpayers,
} from '../../db/schema/index.js';
import { baseScope, visibleTaxpayerFilter, type FirmScope } from './firm-scope.service.js';
import { assertEntityInScope } from './entity-type.service.js';

export type SplitRow = typeof taxEstAccountTreatmentSplits.$inferSelect;

export const toSplitDto = (r: SplitRow): TreatmentSplitDto => ({
  taxpayerId: r.taxpayerId, personId: r.personId, pct: r.pct, amount: r.amount, taxYear: r.taxYear, sortOrder: r.sortOrder,
});

/** Split rows of a company's treatments, by treatment id, in sort order. */
export async function loadSplitsByTreatment(tenantId: string, companyId: string, treatmentIds?: string[]): Promise<Map<string, SplitRow[]>> {
  if (treatmentIds && treatmentIds.length === 0) return new Map();
  const rows = await db.select().from(taxEstAccountTreatmentSplits).where(and(
    eq(taxEstAccountTreatmentSplits.tenantId, tenantId),
    eq(taxEstAccountTreatmentSplits.companyId, companyId),
    treatmentIds ? inArray(taxEstAccountTreatmentSplits.treatmentId, treatmentIds) : undefined,
  )).orderBy(asc(taxEstAccountTreatmentSplits.treatmentId), asc(taxEstAccountTreatmentSplits.sortOrder));
  const out = new Map<string, SplitRow[]>();
  for (const r of rows) {
    const list = out.get(r.treatmentId) ?? [];
    list.push(r);
    out.set(r.treatmentId, list);
  }
  return out;
}

/** Snapshot record of a company's owner splits (Q50: snapshots freeze them). Empty when none. */
export interface CompanyOwnerSplit {
  accountId: string;
  treatment: string | null;
  splitMode: SplitMode;
  splits: TreatmentSplitDto[];
}

export async function loadCompanyOwnerSplits(tenantId: string, companyId: string): Promise<CompanyOwnerSplit[]> {
  const splits = await loadSplitsByTreatment(tenantId, companyId);
  if (splits.size === 0) return [];
  const rows = await db.select({
    id: taxEstAccountTreatments.id, accountId: taxEstAccountTreatments.accountId,
    treatment: taxEstAccountTreatments.treatment, splitMode: taxEstAccountTreatments.splitMode,
  }).from(taxEstAccountTreatments).where(and(
    eq(taxEstAccountTreatments.tenantId, tenantId), eq(taxEstAccountTreatments.companyId, companyId),
    inArray(taxEstAccountTreatments.id, [...splits.keys()]),
  ));
  return rows
    .map((r) => ({ accountId: r.accountId, treatment: r.treatment, splitMode: r.splitMode as SplitMode, splits: (splits.get(r.id) ?? []).map(toSplitDto) }))
    .sort((a, b) => a.accountId.localeCompare(b.accountId));
}

/** Persons / taxpayers with a link (any year) to the business — no viewer filter (provider warnings). */
export async function linkedTargets(tenantId: string, companyId: string): Promise<{ persons: Set<string>; taxpayers: Set<string> }> {
  const rows = await db.select({ personId: taxEstLinks.personId, taxpayerId: taxEstLinks.taxpayerId }).from(taxEstLinks)
    .where(and(eq(taxEstLinks.tenantId, tenantId), eq(taxEstLinks.companyId, companyId)));
  return { persons: new Set(rows.map((r) => r.personId)), taxpayers: new Set(rows.map((r) => r.taxpayerId)) };
}

interface CandidateLinkRow {
  taxpayerId: string; taxpayerName: string; personId: string; personRole: string; firstName: string; lastName: string;
  taxYear: number; profitPct: string | null; isOfficer: boolean;
}

/**
 * Owner candidates for the picker (and the server-side target check). `taxYear` picks the year
 * whose profit % feeds the default split; omitted = the latest year with a link.
 */
export async function listOwnerCandidates(
  scope: FirmScope, tenantId: string, companyId: string, taxYear?: number,
): Promise<OwnerCandidatesDto> {
  scope = baseScope(scope); // D18: the picker feeds a treatment write — never a staff-list widening
  await assertEntityInScope(scope, tenantId, companyId);
  const rows: CandidateLinkRow[] = await db.select({
    taxpayerId: taxEstTaxpayers.id, taxpayerName: taxEstTaxpayers.displayName,
    personId: taxEstPersons.id, personRole: taxEstPersons.role, firstName: taxEstPersons.firstName, lastName: taxEstPersons.lastName,
    taxYear: taxEstLinks.taxYear, profitPct: taxEstLinks.profitPct, isOfficer: taxEstLinks.isOfficer,
  }).from(taxEstLinks)
    .innerJoin(taxEstPersons, eq(taxEstPersons.id, taxEstLinks.personId))
    .innerJoin(taxEstTaxpayers, eq(taxEstTaxpayers.id, taxEstLinks.taxpayerId))
    .where(and(
      eq(taxEstLinks.tenantId, tenantId),
      eq(taxEstLinks.companyId, companyId),
      eq(taxEstPersons.taxpayerId, taxEstLinks.taxpayerId),
      eq(taxEstTaxpayers.isActive, true),
      sql`${visibleTaxpayerFilter(scope)}`,
    ));
  const years = [...new Set(rows.map((r) => r.taxYear))].sort((a, b) => a - b);
  const year = taxYear !== undefined && years.includes(taxYear) ? taxYear : (years[years.length - 1] ?? null);
  const byPerson = new Map<string, { base: CandidateLinkRow; years: number[]; inYear: CandidateLinkRow | null }>();
  for (const r of rows) {
    const e = byPerson.get(r.personId) ?? { base: r, years: [], inYear: null };
    e.years.push(r.taxYear);
    if (r.taxYear === year) e.inYear = r;
    // Latest year's link describes the person when the chosen year has none.
    if (r.taxYear > e.base.taxYear) e.base = r;
    byPerson.set(r.personId, e);
  }
  const ordered = [...byPerson.values()].sort((a, b) =>
    a.base.taxpayerName.localeCompare(b.base.taxpayerName) || (a.base.personRole === 'primary' ? -1 : 1) - (b.base.personRole === 'primary' ? -1 : 1)
    || a.base.personId.localeCompare(b.base.personId));
  const inYear = ordered.filter((e) => e.inYear);
  const defaults = defaultOwnerPcts(inYear.map((e) => e.inYear!.profitPct));
  const defaultBy = new Map(inYear.map((e, i) => [e.base.personId, defaults[i]!]));
  const candidates: OwnerCandidateDto[] = ordered.map((e) => {
    const link = e.inYear ?? e.base;
    return {
      taxpayerId: link.taxpayerId, taxpayerName: link.taxpayerName, personId: link.personId, personRole: link.personRole,
      firstName: link.firstName, lastName: link.lastName, years: [...new Set(e.years)].sort((a, b) => a - b),
      profitPct: link.profitPct, isOfficer: link.isOfficer, defaultPct: defaultBy.get(link.personId) ?? null,
    };
  });
  return { tenantId, companyId, taxYear: year, candidates };
}

/**
 * Display names of persons / taxpayers the caller may see (firm + D17 / D18 visibility), keyed
 * `person:<id>` / `taxpayer:<id>`, for the trace placeholders the provider leaves in split
 * rows. Others are absent (the caller shows a neutral label).
 */
export async function visiblePersonNames(scope: FirmScope, personIds: string[], taxpayerIds: string[] = []): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (personIds.length > 0) {
    const rows = await db.select({ id: taxEstPersons.id, firstName: taxEstPersons.firstName, lastName: taxEstPersons.lastName })
      .from(taxEstPersons)
      .innerJoin(taxEstTaxpayers, eq(taxEstTaxpayers.id, taxEstPersons.taxpayerId))
      .where(and(inArray(taxEstPersons.id, personIds), sql`${visibleTaxpayerFilter(scope)}`));
    for (const r of rows) out.set(`person:${r.id}`, `${r.firstName} ${r.lastName}`.trim());
  }
  if (taxpayerIds.length > 0) {
    const rows = await db.select({ id: taxEstTaxpayers.id, name: taxEstTaxpayers.displayName }).from(taxEstTaxpayers)
      .where(and(inArray(taxEstTaxpayers.id, taxpayerIds), sql`${visibleTaxpayerFilter(scope)}`));
    for (const r of rows) out.set(`taxpayer:${r.id}`, r.name);
  }
  return out;
}
