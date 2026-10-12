// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Tax Estimator taxpayers, persons, links and portal-contact mapping
// (Phase 3, features/tax-estimator/MODULE.md D1).
//
// Taxpayers belong to a FIRM. Links point at companies in ANY tenant of the
// firm, so this service is a deliberate exception to "WHERE tenant_id = the
// request tenant". The exception is confined to the server-resolved FirmScope
// (firm-scope.service.ts); no firm id, tenant list or role is ever read from
// client input. Rules:
//   * every taxpayer read/write is `firm_id = scope.firmId` (404 otherwise);
//   * every link write checks the link's tenant is in scope
//     (404 TE_TENANT_NOT_MANAGED, which also hides whether it exists);
//   * every read of a linked tenant/company joins on the scope set;
//   * a link whose tenant later leaves the scope STAYS STORED but is returned
//     flagged `outOfScope: true` with names withheld, is excluded from company
//     options, and (by contract with the estimator) from computation. It can
//     still be deleted, because it is the firm's own taxpayer data and the row
//     carries only opaque ids.
// Audit: tenant = the caller's active tenant, firm id in the after-data.

import { and, asc, desc, eq, ilike, inArray, ne, or, sql, type SQL } from 'drizzle-orm';
import type {
  CreateTaxpayerInput, UpdateTaxpayerInput, ListTaxpayersQuery, UpsertPersonInput, UpsertLinkInput,
  CompanyOptionsQuery, LinkContactInput, TaxpayerDTO, PersonDTO, TaxpayerListDTO, TaxpayerDetailDTO,
  LinkDTO, LinkWarningDTO, LinkUpsertResultDTO, LinkListDTO, CompanyOptionListDTO, TaxpayerContactDTO,
  TaxpayerContactListDTO, TaxpayerContactCandidateDTO, TaxpayerContactCandidateListDTO, LinkContactResultDTO, UnlinkContactResultDTO, LinkEntityKind, PersonRole,
  FilingStatus, ActivityType, SafeHarborOverride, PortalShows, PartnerSeStatus,
} from '@kis-books/shared';
import { MIN_OVERRIDE_REASON_LEN } from '@kis-books/shared';
import { db, type DbOrTx } from '../../db/index.js';
import {
  taxEstTaxpayers, taxEstPersons, taxEstLinks, taxEstTaxpayerContacts,
} from '../../db/schema/tax-estimator-taxpayers.js';
import { companies } from '../../db/schema/company.js';
import { tenants } from '../../db/schema/auth.js';
import { companyTaxProfiles } from '../../db/schema/tb.js';
import { portalContacts, portalContactCompanies } from '../../db/schema/portal-contacts.js';
import { auditLog } from '../../middleware/audit.js';
import { AppError } from '../../utils/errors.js';
import { isTenantInScope, tenantInScopeSql, visibleTaxpayerFilter, type FirmScope } from './firm-scope.service.js';

/** Who is acting: audit tenant = the caller's ACTIVE tenant (not a linked tenant). */
export interface Actor {
  tenantId: string;
  userId: string;
}

const MAX_PERSONS = 2;
const PCT_SCALE = 10000; // numeric(7,4)
const PCT_FULL = 100 * PCT_SCALE;
const MONTHS = 12;
const RETURN_FORM_KIND: Readonly<Record<string, LinkEntityKind>> = {
  '1065': 'partnership', '1120S': 's_corp', '1120': 'c_corp', '1040': 'sole',
};
const COMPANY_ENTITY_KIND: Readonly<Record<string, LinkEntityKind>> = {
  partnership: 'partnership', s_corp: 's_corp', c_corp: 'c_corp', sole_prop: 'sole', single_member_llc: 'sole',
};

type TaxpayerRow = typeof taxEstTaxpayers.$inferSelect;
type PersonRow = typeof taxEstPersons.$inferSelect;
type LinkRow = typeof taxEstLinks.$inferSelect;

// ── helpers ────────────────────────────────────────────────────────────

const scaled = (v: string | number | null | undefined): number => (v == null ? 0 : Math.round(Number(v) * PCT_SCALE));
const unscaled = (n: number): number => n / PCT_SCALE;
const numOrNull = (v: string | null): number | null => (v == null ? null : Number(v));

function notManaged(): AppError {
  return new AppError(404, 'Client is not managed by your firm', 'TE_TENANT_NOT_MANAGED');
}
function taxpayerNotFound(): AppError {
  return new AppError(404, 'Taxpayer not found', 'TE_TAXPAYER_NOT_FOUND');
}

function toTaxpayerDTO(r: TaxpayerRow): TaxpayerDTO {
  return {
    id: r.id, displayName: r.displayName, filingStatus: r.filingStatus as FilingStatus,
    residentState: r.residentState ? r.residentState.trim() : null,
    safeHarborOverride: r.safeHarborOverride as SafeHarborOverride | null,
    portalShows: r.portalShows as PortalShows | null,
    isActive: r.isActive, createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(),
  };
}
function toPersonDTO(r: PersonRow): PersonDTO {
  return {
    id: r.id, taxpayerId: r.taxpayerId, role: r.role as PersonRole, firstName: r.firstName, lastName: r.lastName,
    dateOfBirth: r.dateOfBirth, isBlind: r.isBlind, sehiEligibleMonths: r.sehiEligibleMonths,
  };
}

async function audit(
  scope: FirmScope, actor: Actor, action: 'create' | 'update' | 'delete',
  entityType: 'tax_est_taxpayer' | 'tax_est_person' | 'tax_est_link', entityId: string,
  before: unknown | null, after: unknown | null, exec: DbOrTx,
) {
  const tag = (v: unknown | null) => (v ? { ...(v as object), firmId: scope.firmId } : null);
  await auditLog(actor.tenantId, action, entityType, entityId, tag(before), tag(after), actor.userId, exec);
}

/**
 * The ONLY way a taxpayer is loaded by id: firm-checked AND visibility-checked (D17,
 * `visibleTaxpayerFilter`). `lock` serialises concurrent link edits.
 */
async function loadTaxpayer(scope: FirmScope, id: string, exec: DbOrTx = db, lock = false): Promise<TaxpayerRow> {
  const q = exec.select().from(taxEstTaxpayers)
    .where(and(eq(taxEstTaxpayers.id, id), visibleTaxpayerFilter(scope)));
  const [row] = lock ? await q.for('update') : await q;
  if (!row) throw taxpayerNotFound();
  return row;
}

/**
 * D17: the taxpayer has a staff allow-list (list lock icon). Row-local EXISTS, no N+1.
 * Fully qualified raw names: drizzle renders a lone column unqualified in a select list,
 * which inside the subquery would bind to the subquery's own table.
 */
const staffRestrictedSql = () => sql<boolean>`EXISTS (SELECT 1 FROM tax_est_taxpayer_staff tes
  WHERE tes.taxpayer_id = "tax_est_taxpayers"."id" AND tes.firm_id = "tax_est_taxpayers"."firm_id")`;

function assertDobNotFuture(dob: string | null | undefined) {
  if (!dob) return;
  const today = new Date().toISOString().slice(0, 10);
  if (dob > today) throw AppError.unprocessableEntity('Date of birth cannot be in the future', 'TE_DOB_IN_FUTURE');
}

// ── taxpayers ──────────────────────────────────────────────────────────

export async function createTaxpayer(scope: FirmScope, actor: Actor, input: CreateTaxpayerInput): Promise<TaxpayerDTO> {
  return db.transaction(async (tx) => {
    const [row] = await tx.insert(taxEstTaxpayers).values({
      firmId: scope.firmId,
      displayName: input.displayName,
      filingStatus: input.filingStatus,
      residentState: input.residentState ?? null,
      safeHarborOverride: input.safeHarborOverride ?? null,
      portalShows: input.portalShows ?? null,
      createdBy: actor.userId,
    }).returning();
    if (!row) throw AppError.internal('Taxpayer create failed');
    await audit(scope, actor, 'create', 'tax_est_taxpayer', row.id, null, toTaxpayerDTO(row), tx);
    return toTaxpayerDTO(row);
  });
}

export async function listTaxpayers(scope: FirmScope, query: ListTaxpayersQuery): Promise<TaxpayerListDTO> {
  // D17: the visibility predicate is part of the WHERE, so `total` counts only what the caller sees.
  const conds: SQL[] = [visibleTaxpayerFilter(scope)];
  if (query.status === 'active') conds.push(eq(taxEstTaxpayers.isActive, true));
  if (query.status === 'archived') conds.push(eq(taxEstTaxpayers.isActive, false));
  if (query.filingStatus && query.filingStatus.length > 0) conds.push(inArray(taxEstTaxpayers.filingStatus, query.filingStatus));
  if (query.residentState && query.residentState.length > 0) conds.push(inArray(taxEstTaxpayers.residentState, query.residentState));
  if (query.q) {
    const like = `%${query.q.replace(/[\\%_]/g, '\\$&')}%`;
    conds.push(or(
      ilike(taxEstTaxpayers.displayName, like),
      sql`EXISTS (SELECT 1 FROM tax_est_persons p WHERE p.taxpayer_id = ${taxEstTaxpayers.id}
        AND (p.first_name ILIKE ${like} OR p.last_name ILIKE ${like}))`,
    )!);
  }
  const where = and(...conds);
  const sortCol = {
    displayName: taxEstTaxpayers.displayName, filingStatus: taxEstTaxpayers.filingStatus,
    residentState: taxEstTaxpayers.residentState, createdAt: taxEstTaxpayers.createdAt,
  }[query.sortBy];
  const order = query.sortDir === 'desc' ? desc(sortCol) : asc(sortCol);

  const [countRow] = await db.select({ n: sql<number>`count(*)::int` }).from(taxEstTaxpayers).where(where);
  const rows = await db.select({ t: taxEstTaxpayers, staffRestricted: staffRestrictedSql() }).from(taxEstTaxpayers).where(where)
    .orderBy(order, asc(taxEstTaxpayers.id)).limit(query.limit).offset(query.offset)
    .then((rs) => rs.map((r) => ({ ...r.t, staffRestricted: r.staffRestricted === true })));

  const ids = rows.map((r) => r.id);
  const persons = ids.length ? await db.select().from(taxEstPersons).where(inArray(taxEstPersons.taxpayerId, ids)) : [];
  const linkCounts = ids.length
    ? await db.select({ taxpayerId: taxEstLinks.taxpayerId, n: sql<number>`count(*)::int` })
      .from(taxEstLinks).where(inArray(taxEstLinks.taxpayerId, ids)).groupBy(taxEstLinks.taxpayerId)
    : [];
  const countBy = new Map(linkCounts.map((c) => [c.taxpayerId, c.n]));
  return {
    data: rows.map((r) => ({
      ...toTaxpayerDTO(r),
      staffRestricted: r.staffRestricted,
      personNames: persons.filter((p) => p.taxpayerId === r.id)
        .sort((a, b) => a.role.localeCompare(b.role)).map((p) => `${p.firstName} ${p.lastName}`),
      linkCount: countBy.get(r.id) ?? 0,
    })),
    total: countRow?.n ?? 0, limit: query.limit, offset: query.offset,
  };
}

export async function getTaxpayer(scope: FirmScope, id: string): Promise<TaxpayerDetailDTO> {
  const row = await loadTaxpayer(scope, id);
  const persons = await db.select().from(taxEstPersons).where(eq(taxEstPersons.taxpayerId, id));
  const [staff] = await db.select({ on: staffRestrictedSql() }).from(taxEstTaxpayers).where(eq(taxEstTaxpayers.id, id));
  return {
    taxpayer: toTaxpayerDTO(row),
    persons: persons.sort((a, b) => a.role.localeCompare(b.role)).map(toPersonDTO),
    staffRestricted: staff?.on === true,
  };
}

export async function updateTaxpayer(scope: FirmScope, actor: Actor, id: string, input: UpdateTaxpayerInput): Promise<TaxpayerDTO> {
  return db.transaction(async (tx) => {
    const before = await loadTaxpayer(scope, id, tx, true);
    const patch: Partial<typeof taxEstTaxpayers.$inferInsert> = { updatedAt: new Date() };
    if (input.displayName !== undefined) patch.displayName = input.displayName;
    if (input.filingStatus !== undefined) patch.filingStatus = input.filingStatus;
    if (input.residentState !== undefined) patch.residentState = input.residentState;
    if (input.safeHarborOverride !== undefined) patch.safeHarborOverride = input.safeHarborOverride;
    if (input.portalShows !== undefined) patch.portalShows = input.portalShows;
    const [row] = await tx.update(taxEstTaxpayers).set(patch)
      .where(and(eq(taxEstTaxpayers.id, id), eq(taxEstTaxpayers.firmId, scope.firmId))).returning();
    if (!row) throw taxpayerNotFound();
    await audit(scope, actor, 'update', 'tax_est_taxpayer', id, toTaxpayerDTO(before), toTaxpayerDTO(row), tx);
    return toTaxpayerDTO(row);
  });
}

/** DELETE = archive (is_active = false). Persons, links and contacts are kept. */
export async function archiveTaxpayer(scope: FirmScope, actor: Actor, id: string): Promise<TaxpayerDTO> {
  return db.transaction(async (tx) => {
    const before = await loadTaxpayer(scope, id, tx, true);
    const [row] = await tx.update(taxEstTaxpayers).set({ isActive: false, updatedAt: new Date() })
      .where(and(eq(taxEstTaxpayers.id, id), eq(taxEstTaxpayers.firmId, scope.firmId))).returning();
    if (!row) throw taxpayerNotFound();
    await audit(scope, actor, 'delete', 'tax_est_taxpayer', id, toTaxpayerDTO(before), toTaxpayerDTO(row), tx);
    return toTaxpayerDTO(row);
  });
}

// ── persons ────────────────────────────────────────────────────────────

export async function upsertPerson(
  scope: FirmScope, actor: Actor, taxpayerId: string, role: PersonRole, input: UpsertPersonInput,
): Promise<PersonDTO> {
  assertDobNotFuture(input.dateOfBirth);
  if (input.sehiEligibleMonths && input.sehiEligibleMonths.length !== MONTHS) {
    throw AppError.unprocessableEntity('SEHI months must be 12 booleans', 'TE_SEHI_MONTHS_INVALID');
  }
  return db.transaction(async (tx) => {
    await loadTaxpayer(scope, taxpayerId, tx, true);
    const all = await tx.select().from(taxEstPersons).where(eq(taxEstPersons.taxpayerId, taxpayerId));
    const existing = all.find((p) => p.role === role);
    if (!existing && all.length >= MAX_PERSONS) {
      throw AppError.unprocessableEntity('A taxpayer has at most two persons', 'TE_PERSON_LIMIT');
    }
    if (!existing && role === 'spouse' && !all.some((p) => p.role === 'primary')) {
      throw AppError.unprocessableEntity('Add the primary person before the spouse', 'TE_PRIMARY_REQUIRED');
    }
    const values = {
      firstName: input.firstName, lastName: input.lastName,
      dateOfBirth: input.dateOfBirth ?? null, isBlind: input.isBlind,
      sehiEligibleMonths: input.sehiEligibleMonths ?? existing?.sehiEligibleMonths ?? Array<boolean>(MONTHS).fill(true),
      updatedAt: new Date(),
    };
    const [row] = existing
      ? await tx.update(taxEstPersons).set(values).where(eq(taxEstPersons.id, existing.id)).returning()
      : await tx.insert(taxEstPersons).values({ taxpayerId, role, ...values }).returning();
    if (!row) throw AppError.internal('Person save failed');
    await audit(scope, actor, existing ? 'update' : 'create', 'tax_est_person', row.id,
      existing ? toPersonDTO(existing) : null, toPersonDTO(row), tx);
    return toPersonDTO(row);
  });
}

export async function removePerson(scope: FirmScope, actor: Actor, taxpayerId: string, role: PersonRole): Promise<{ removedLinks: number }> {
  return db.transaction(async (tx) => {
    await loadTaxpayer(scope, taxpayerId, tx, true);
    const all = await tx.select().from(taxEstPersons).where(eq(taxEstPersons.taxpayerId, taxpayerId));
    const person = all.find((p) => p.role === role);
    if (!person) throw new AppError(404, 'Person not found', 'TE_PERSON_NOT_FOUND');
    if (role === 'primary' && all.length > 1) {
      throw AppError.unprocessableEntity('Remove the spouse before the primary person', 'TE_PRIMARY_REQUIRED');
    }
    const links = await tx.select({ id: taxEstLinks.id }).from(taxEstLinks).where(eq(taxEstLinks.personId, person.id));
    await tx.delete(taxEstPersons).where(eq(taxEstPersons.id, person.id)); // links cascade
    await audit(scope, actor, 'delete', 'tax_est_person', person.id, toPersonDTO(person), { removedLinks: links.length }, tx);
    return { removedLinks: links.length };
  });
}

// ── entity resolution ──────────────────────────────────────────────────

/** Entity kind of a company: TB return form first (D3), then companies.entity_type. */
export async function resolveEntityKind(
  tenantId: string, companyId: string, exec: DbOrTx = db,
): Promise<{ kind: LinkEntityKind | null; returnForm: string | null; exists: boolean }> {
  const [row] = await exec.select({ entityType: companies.entityType, returnForm: companyTaxProfiles.returnForm })
    .from(companies)
    .leftJoin(companyTaxProfiles, and(
      eq(companyTaxProfiles.companyId, companies.id), eq(companyTaxProfiles.tenantId, companies.tenantId)))
    .where(and(eq(companies.id, companyId), eq(companies.tenantId, tenantId)))
    .limit(1);
  if (!row) return { kind: null, returnForm: null, exists: false };
  const kind = (row.returnForm ? RETURN_FORM_KIND[row.returnForm] : undefined) ?? COMPANY_ENTITY_KIND[row.entityType] ?? null;
  return { kind, returnForm: row.returnForm ?? null, exists: true };
}

/**
 * Phase 4 owns tax_est_entity_settings. Read it defensively: a missing table
 * (or row) means "not a trade or business" (false). Never created here.
 */
async function rentalQbiDefault(tenantId: string, companyId: string, exec: DbOrTx): Promise<boolean> {
  const [reg] = (await exec.execute(sql`SELECT to_regclass('public.tax_est_entity_settings') AS t`)).rows as Array<{ t: string | null }>;
  if (!reg?.t) return false;
  const rows = (await exec.execute(sql`SELECT rental_qbi_trade_or_business AS v FROM tax_est_entity_settings
    WHERE tenant_id = ${tenantId} AND company_id = ${companyId} LIMIT 1`)).rows as Array<{ v: boolean | null }>;
  return rows[0]?.v === true;
}

// ── links ──────────────────────────────────────────────────────────────

function pctWarnings(rows: LinkRow[], scopedOnly: (l: LinkRow) => boolean): LinkWarningDTO[] {
  const groups = new Map<string, { tenantId: string; companyId: string; taxYear: number; profit: number; loss: number; hasProfit: boolean; hasLoss: boolean }>();
  for (const l of rows.filter(scopedOnly)) {
    const key = `${l.tenantId}|${l.companyId}|${l.taxYear}`;
    const g = groups.get(key) ?? { tenantId: l.tenantId, companyId: l.companyId, taxYear: l.taxYear, profit: 0, loss: 0, hasProfit: false, hasLoss: false };
    if (l.profitPct != null) { g.profit += scaled(l.profitPct); g.hasProfit = true; }
    if (l.lossPct != null) { g.loss += scaled(l.lossPct); g.hasLoss = true; }
    groups.set(key, g);
  }
  const out: LinkWarningDTO[] = [];
  for (const g of groups.values()) {
    if (g.hasProfit && g.profit < PCT_FULL) {
      out.push({ code: 'PROFIT_PCT_UNDER_100', taxYear: g.taxYear, tenantId: g.tenantId, companyId: g.companyId, total: unscaled(g.profit),
        message: `Profit ownership totals ${unscaled(g.profit)}% (under 100%)` });
    }
    if (g.hasLoss && g.loss < PCT_FULL) {
      out.push({ code: 'LOSS_PCT_UNDER_100', taxYear: g.taxYear, tenantId: g.tenantId, companyId: g.companyId, total: unscaled(g.loss),
        message: `Loss ownership totals ${unscaled(g.loss)}% (under 100%)` });
    }
  }
  return out;
}

interface CompanyMeta { tenantName: string; companyName: string; kind: LinkEntityKind | null; returnForm: string | null }

/** Names/entity info for IN-SCOPE (tenant, company) pairs only. Out-of-scope pairs are never queried. */
async function companyMeta(scope: FirmScope, pairs: Array<{ tenantId: string; companyId: string }>): Promise<Map<string, CompanyMeta>> {
  const out = new Map<string, CompanyMeta>();
  const inScope = pairs.filter((p) => isTenantInScope(scope, p.tenantId));
  if (inScope.length === 0) return out;
  const companyIds = [...new Set(inScope.map((p) => p.companyId))];
  const rows = await db.select({
    tenantId: companies.tenantId, companyId: companies.id, tenantName: tenants.name, companyName: companies.businessName,
    entityType: companies.entityType, returnForm: companyTaxProfiles.returnForm,
  }).from(companies)
    .innerJoin(tenants, eq(tenants.id, companies.tenantId))
    .leftJoin(companyTaxProfiles, and(eq(companyTaxProfiles.companyId, companies.id), eq(companyTaxProfiles.tenantId, companies.tenantId)))
    .where(and(inArray(companies.id, companyIds), tenantInScopeSql(scope, sql`${companies.tenantId}`)));
  for (const r of rows) {
    out.set(`${r.tenantId}|${r.companyId}`, {
      tenantName: r.tenantName, companyName: r.companyName, returnForm: r.returnForm ?? null,
      kind: (r.returnForm ? RETURN_FORM_KIND[r.returnForm] : undefined) ?? COMPANY_ENTITY_KIND[r.entityType] ?? null,
    });
  }
  return out;
}

function toLinkDTO(scope: FirmScope, l: LinkRow, roleByPerson: Map<string, PersonRole>, meta: Map<string, CompanyMeta>): LinkDTO {
  const outOfScope = !isTenantInScope(scope, l.tenantId);
  const m = outOfScope ? undefined : meta.get(`${l.tenantId}|${l.companyId}`);
  return {
    id: l.id, taxpayerId: l.taxpayerId, personId: l.personId, personRole: roleByPerson.get(l.personId) ?? 'primary',
    taxYear: l.taxYear, tenantId: l.tenantId, companyId: l.companyId,
    tenantName: m?.tenantName ?? null, companyName: m?.companyName ?? null,
    entityKind: m?.kind ?? null, returnForm: m?.returnForm ?? null, outOfScope,
    profitPct: numOrNull(l.profitPct), lossPct: numOrNull(l.lossPct), capitalPct: numOrNull(l.capitalPct),
    partnerSeStatus: l.partnerSeStatus as PartnerSeStatus | null, partnerSeMemo: l.partnerSeMemo,
    isOfficer: l.isOfficer, activityType: l.activityType as ActivityType, activeParticipation: l.activeParticipation,
    qbiEligible: l.qbiEligible, qbiOverrideReason: l.qbiOverrideReason,
    allowedLossOverride: l.allowedLossOverride, allowedLossReason: l.allowedLossReason,
  };
}

async function hydrateLinks(scope: FirmScope, taxpayerId: string, rows: LinkRow[]): Promise<LinkDTO[]> {
  const persons = await db.select().from(taxEstPersons).where(eq(taxEstPersons.taxpayerId, taxpayerId));
  const roleByPerson = new Map(persons.map((p) => [p.id, p.role as PersonRole]));
  const meta = await companyMeta(scope, rows.map((r) => ({ tenantId: r.tenantId, companyId: r.companyId })));
  return rows.map((r) => toLinkDTO(scope, r, roleByPerson, meta));
}

export async function listLinks(scope: FirmScope, taxpayerId: string, taxYear: number): Promise<LinkListDTO> {
  await loadTaxpayer(scope, taxpayerId);
  const rows = await db.select().from(taxEstLinks)
    .where(and(eq(taxEstLinks.taxpayerId, taxpayerId), eq(taxEstLinks.taxYear, taxYear)))
    .orderBy(asc(taxEstLinks.createdAt), asc(taxEstLinks.id));
  const data = await hydrateLinks(scope, taxpayerId, rows);
  return { data, total: data.length, warnings: pctWarnings(rows, (l) => isTenantInScope(scope, l.tenantId)) };
}

function validateLinkFlags(input: UpsertLinkInput, kind: LinkEntityKind | null) {
  if (input.partnerSeStatus === 'limited' && kind !== null && kind !== 'partnership') {
    throw AppError.unprocessableEntity('Limited partner status applies only to partnerships', 'TE_LIMITED_ONLY_PARTNERSHIP');
  }
  if (input.isOfficer && kind !== null && kind !== 's_corp') {
    throw AppError.unprocessableEntity('Officer applies only to S corporations', 'TE_OFFICER_ONLY_SCORP');
  }
}

export async function upsertLink(scope: FirmScope, actor: Actor, taxpayerId: string, input: UpsertLinkInput): Promise<LinkUpsertResultDTO> {
  // Scope first: a tenant outside the allowed set is a 404 before anything else is read.
  if (!isTenantInScope(scope, input.tenantId)) throw notManaged();

  const savedId = await db.transaction(async (tx) => {
    await loadTaxpayer(scope, taxpayerId, tx, true);
    const persons = await tx.select().from(taxEstPersons).where(eq(taxEstPersons.taxpayerId, taxpayerId));
    const person = persons.find((p) => p.role === input.personRole);
    if (!person) throw new AppError(404, 'Person not found', 'TE_PERSON_NOT_FOUND');

    const entity = await resolveEntityKind(input.tenantId, input.companyId, tx);
    if (!entity.exists) throw new AppError(404, 'Company not found', 'TE_COMPANY_NOT_FOUND');
    validateLinkFlags(input, entity.kind);

    // Profit % / loss % across ALL persons' links to the same company + year ≤ 100.
    const others = await tx.select().from(taxEstLinks).where(and(
      eq(taxEstLinks.taxpayerId, taxpayerId), eq(taxEstLinks.tenantId, input.tenantId),
      eq(taxEstLinks.companyId, input.companyId), eq(taxEstLinks.taxYear, input.taxYear),
      ne(taxEstLinks.personId, person.id)));
    const sum = (pick: (l: LinkRow) => string | null, mine: number | null | undefined) =>
      others.reduce((acc, l) => acc + scaled(pick(l)), 0) + scaled(mine ?? null);
    for (const [label, total] of [['Profit', sum((l) => l.profitPct, input.profitPct)], ['Loss', sum((l) => l.lossPct, input.lossPct)]] as const) {
      if (total > PCT_FULL) {
        throw AppError.unprocessableEntity(`${label} percentages for this company and year total ${unscaled(total)}% (over 100%)`,
          'TE_LINK_PCT_OVER_100', { total: unscaled(total), field: label.toLowerCase() });
      }
    }

    // QBI: rental defaults from the entity setting; an explicit differing value needs a reason.
    const rental = input.activityType === 'rental';
    const defaultQbi = rental ? await rentalQbiDefault(input.tenantId, input.companyId, tx) : true;
    const qbiEligible = input.qbiEligible ?? (rental ? defaultQbi : null);
    const qbiOverridden = input.qbiEligible != null && input.qbiEligible !== defaultQbi;
    const qbiReason = input.qbiOverrideReason?.trim() || null;
    if (qbiOverridden && (qbiReason?.length ?? 0) < MIN_OVERRIDE_REASON_LEN) {
      throw AppError.unprocessableEntity('A reason is required to override QBI eligibility', 'TE_OVERRIDE_REASON_REQUIRED');
    }
    const lossReason = input.allowedLossReason?.trim() || null;
    if (input.allowedLossOverride != null && (lossReason?.length ?? 0) < MIN_OVERRIDE_REASON_LEN) {
      throw AppError.unprocessableEntity('A reason is required for an allowed-loss override', 'TE_OVERRIDE_REASON_REQUIRED');
    }

    const values = {
      taxpayerId, personId: person.id, taxYear: input.taxYear, tenantId: input.tenantId, companyId: input.companyId,
      profitPct: input.profitPct == null ? null : String(input.profitPct),
      lossPct: input.lossPct == null ? null : String(input.lossPct),
      capitalPct: input.capitalPct == null ? null : String(input.capitalPct),
      partnerSeStatus: input.partnerSeStatus ?? null,
      partnerSeMemo: input.partnerSeMemo?.trim() || null,
      isOfficer: input.isOfficer, activityType: input.activityType, activeParticipation: input.activeParticipation,
      qbiEligible, qbiOverrideReason: qbiOverridden ? qbiReason : null,
      allowedLossOverride: input.allowedLossOverride ?? null,
      allowedLossReason: input.allowedLossOverride != null ? lossReason : null,
    };
    const [before] = await tx.select().from(taxEstLinks).where(and(
      eq(taxEstLinks.personId, person.id), eq(taxEstLinks.tenantId, input.tenantId),
      eq(taxEstLinks.companyId, input.companyId), eq(taxEstLinks.taxYear, input.taxYear)));
    const [row] = await tx.insert(taxEstLinks).values(values).onConflictDoUpdate({
      target: [taxEstLinks.personId, taxEstLinks.tenantId, taxEstLinks.companyId, taxEstLinks.taxYear],
      set: { ...values, updatedAt: new Date() },
      setWhere: eq(taxEstLinks.taxpayerId, taxpayerId),
    }).returning();
    if (!row) throw AppError.internal('Link save failed');
    await audit(scope, actor, before ? 'update' : 'create', 'tax_est_link', row.id, before ?? null, row, tx);
    return row.id;
  });

  const [row] = await db.select().from(taxEstLinks).where(eq(taxEstLinks.id, savedId));
  if (!row) throw AppError.internal('Link save failed');
  const [link] = await hydrateLinks(scope, taxpayerId, [row]);
  const siblings = await db.select().from(taxEstLinks).where(and(
    eq(taxEstLinks.taxpayerId, taxpayerId), eq(taxEstLinks.tenantId, row.tenantId),
    eq(taxEstLinks.companyId, row.companyId), eq(taxEstLinks.taxYear, row.taxYear)));
  return { link: link!, warnings: pctWarnings(siblings, () => true) };
}

export async function removeLink(scope: FirmScope, actor: Actor, taxpayerId: string, linkId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await loadTaxpayer(scope, taxpayerId, tx, true);
    const [link] = await tx.select().from(taxEstLinks)
      .where(and(eq(taxEstLinks.id, linkId), eq(taxEstLinks.taxpayerId, taxpayerId)));
    if (!link) throw new AppError(404, 'Link not found', 'TE_LINK_NOT_FOUND');
    await tx.delete(taxEstLinks).where(eq(taxEstLinks.id, linkId));
    await audit(scope, actor, 'delete', 'tax_est_link', linkId, link, null, tx);
  });
}

// ── company options (cross-tenant picker) ──────────────────────────────

export async function listCompanyOptions(scope: FirmScope, query: CompanyOptionsQuery): Promise<CompanyOptionListDTO> {
  const conds: SQL[] = [tenantInScopeSql(scope, sql`${companies.tenantId}`)];
  if (query.q) {
    const like = `%${query.q.replace(/[\\%_]/g, '\\$&')}%`;
    conds.push(or(ilike(companies.businessName, like), ilike(tenants.name, like))!);
  }
  const where = and(...conds);
  const [countRow] = await db.select({ n: sql<number>`count(*)::int` }).from(companies)
    .innerJoin(tenants, eq(tenants.id, companies.tenantId)).where(where);
  const rows = await db.select({
    tenantId: companies.tenantId, tenantName: tenants.name, companyId: companies.id, companyName: companies.businessName,
    entityType: companies.entityType, returnForm: companyTaxProfiles.returnForm,
  }).from(companies)
    .innerJoin(tenants, eq(tenants.id, companies.tenantId))
    .leftJoin(companyTaxProfiles, and(eq(companyTaxProfiles.companyId, companies.id), eq(companyTaxProfiles.tenantId, companies.tenantId)))
    .where(where)
    .orderBy(asc(tenants.name), asc(companies.businessName), asc(companies.id))
    .limit(query.limit).offset(query.offset);
  return {
    data: rows.map((r) => ({ ...r, returnForm: r.returnForm ?? null })),
    total: countRow?.n ?? 0, limit: query.limit, offset: query.offset,
  };
}

// ── portal contacts ────────────────────────────────────────────────────

function toContactDTO(c: {
  contactId: string; tenantId: string; email: string; firstName: string | null; lastName: string | null; createdAt: Date; access: boolean;
}, scope: FirmScope): TaxpayerContactDTO {
  const outOfScope = !isTenantInScope(scope, c.tenantId);
  return {
    portalContactId: c.contactId, tenantId: c.tenantId, email: outOfScope ? '' : c.email,
    firstName: outOfScope ? null : c.firstName, lastName: outOfScope ? null : c.lastName,
    outOfScope, taxEstimatesAccess: c.access, createdAt: c.createdAt.toISOString(),
  };
}

/** Companies (in the contact's tenant) this taxpayer links to; the rows tax_estimates_access applies to. */
const linkedCompanyIds = (taxpayerId: string, tenantId: string) =>
  db.select({ id: taxEstLinks.companyId }).from(taxEstLinks)
    .where(and(eq(taxEstLinks.taxpayerId, taxpayerId), eq(taxEstLinks.tenantId, tenantId)));

async function contactDTO(scope: FirmScope, taxpayerId: string, contactId: string): Promise<TaxpayerContactDTO> {
  const list = await listContacts(scope, taxpayerId);
  const found = list.data.find((c) => c.portalContactId === contactId);
  if (!found) throw new AppError(404, 'Contact not found', 'TE_CONTACT_NOT_FOUND');
  return found;
}

export async function listContacts(scope: FirmScope, taxpayerId: string): Promise<TaxpayerContactListDTO> {
  await loadTaxpayer(scope, taxpayerId);
  const rows = await db.select({
    contactId: portalContacts.id, tenantId: portalContacts.tenantId, email: portalContacts.email,
    firstName: portalContacts.firstName, lastName: portalContacts.lastName, createdAt: taxEstTaxpayerContacts.createdAt,
  }).from(taxEstTaxpayerContacts)
    .innerJoin(portalContacts, eq(portalContacts.id, taxEstTaxpayerContacts.portalContactId))
    .where(eq(taxEstTaxpayerContacts.taxpayerId, taxpayerId))
    .orderBy(asc(portalContacts.email));
  // access = true when the contact has the grant on EVERY linked company in its tenant (and at least one).
  const data: TaxpayerContactDTO[] = [];
  for (const r of rows) {
    let access = false;
    if (isTenantInScope(scope, r.tenantId)) {
      const grants = await db.select({ on: portalContactCompanies.taxEstimatesAccess }).from(portalContactCompanies)
        .where(and(eq(portalContactCompanies.contactId, r.contactId),
          inArray(portalContactCompanies.companyId, linkedCompanyIds(taxpayerId, r.tenantId))));
      access = grants.length > 0 && grants.every((g) => g.on);
    }
    data.push(toContactDTO({ ...r, access }, scope));
  }
  return { data, total: data.length };
}

/**
 * QA D11: contacts that can be linked — active portal contacts with access to one of the
 * taxpayer's linked companies, in tenants inside the server-resolved scope (D1). Works from
 * the practice tenant: nothing here depends on the caller's active tenant.
 */
export async function listContactCandidates(scope: FirmScope, taxpayerId: string): Promise<TaxpayerContactCandidateListDTO> {
  await loadTaxpayer(scope, taxpayerId);
  if (scope.allowedTenantIds.length === 0) return { data: [], total: 0 };
  const rows = await db.selectDistinct({
    contactId: portalContacts.id, tenantId: portalContacts.tenantId, email: portalContacts.email,
    firstName: portalContacts.firstName, lastName: portalContacts.lastName, companyName: companies.businessName,
  }).from(taxEstLinks)
    .innerJoin(portalContactCompanies, eq(portalContactCompanies.companyId, taxEstLinks.companyId))
    .innerJoin(portalContacts, and(eq(portalContacts.id, portalContactCompanies.contactId), eq(portalContacts.tenantId, taxEstLinks.tenantId)))
    .innerJoin(companies, eq(companies.id, taxEstLinks.companyId))
    .where(and(
      eq(taxEstLinks.taxpayerId, taxpayerId),
      inArray(taxEstLinks.tenantId, scope.allowedTenantIds),
      eq(portalContacts.status, 'active'),
    ))
    .orderBy(asc(portalContacts.email));
  const byId = new Map<string, TaxpayerContactCandidateDTO>();
  for (const r of rows) {
    const c = byId.get(r.contactId) ?? {
      portalContactId: r.contactId, tenantId: r.tenantId, email: r.email, firstName: r.firstName, lastName: r.lastName, companyNames: [],
    };
    if (r.companyName && !c.companyNames.includes(r.companyName)) c.companyNames.push(r.companyName);
    byId.set(r.contactId, c);
  }
  const data = [...byId.values()];
  return { data, total: data.length };
}

export async function linkContact(scope: FirmScope, actor: Actor, taxpayerId: string, input: LinkContactInput): Promise<LinkContactResultDTO> {
  const granted = await db.transaction(async (tx) => {
    await loadTaxpayer(scope, taxpayerId, tx, true);
    // The contact must belong to a tenant in scope; anything else is indistinguishable from "no such contact".
    const [contact] = await tx.select().from(portalContacts).where(eq(portalContacts.id, input.portalContactId));
    if (!contact || contact.status === 'deleted' || !isTenantInScope(scope, contact.tenantId)) throw notManaged();
    await tx.insert(taxEstTaxpayerContacts).values({ taxpayerId, portalContactId: contact.id }).onConflictDoNothing();
    let n = 0;
    if (input.grantAccess) {
      const res = await tx.update(portalContactCompanies).set({ taxEstimatesAccess: true })
        .where(and(eq(portalContactCompanies.contactId, contact.id),
          inArray(portalContactCompanies.companyId,
            tx.select({ id: taxEstLinks.companyId }).from(taxEstLinks)
              .where(and(eq(taxEstLinks.taxpayerId, taxpayerId), eq(taxEstLinks.tenantId, contact.tenantId))))))
        .returning({ id: portalContactCompanies.companyId });
      n = res.length;
    }
    await audit(scope, actor, 'update', 'tax_est_taxpayer', taxpayerId, null,
      { op: 'link_contact', portalContactId: contact.id, grantAccess: input.grantAccess, grantedCompanies: n }, tx);
    return n;
  });
  return { contact: await contactDTO(scope, taxpayerId, input.portalContactId), grantedCompanies: granted };
}

export async function unlinkContact(
  scope: FirmScope, actor: Actor, taxpayerId: string, portalContactId: string, revokeAccess: boolean,
): Promise<UnlinkContactResultDTO> {
  return db.transaction(async (tx) => {
    await loadTaxpayer(scope, taxpayerId, tx, true);
    const [mapping] = await tx.select().from(taxEstTaxpayerContacts).where(and(
      eq(taxEstTaxpayerContacts.taxpayerId, taxpayerId), eq(taxEstTaxpayerContacts.portalContactId, portalContactId)));
    if (!mapping) throw new AppError(404, 'Contact not found', 'TE_CONTACT_NOT_FOUND');
    const [contact] = await tx.select().from(portalContacts).where(eq(portalContacts.id, portalContactId));
    await tx.delete(taxEstTaxpayerContacts).where(and(
      eq(taxEstTaxpayerContacts.taxpayerId, taxpayerId), eq(taxEstTaxpayerContacts.portalContactId, portalContactId)));
    let revoked = 0;
    // Revoke only in scope, and only companies no OTHER taxpayer still grants this contact through.
    if (revokeAccess && contact && isTenantInScope(scope, contact.tenantId)) {
      const res = await tx.execute(sql`
        UPDATE portal_contact_companies pcc SET tax_estimates_access = false
        WHERE pcc.contact_id = ${contact.id}
          AND pcc.company_id IN (SELECT company_id FROM tax_est_links WHERE taxpayer_id = ${taxpayerId} AND tenant_id = ${contact.tenantId})
          AND NOT EXISTS (
            SELECT 1 FROM tax_est_taxpayer_contacts tc JOIN tax_est_links l ON l.taxpayer_id = tc.taxpayer_id
            WHERE tc.portal_contact_id = ${contact.id} AND tc.taxpayer_id <> ${taxpayerId} AND l.company_id = pcc.company_id)`);
      revoked = res.rowCount ?? 0;
    }
    await audit(scope, actor, 'update', 'tax_est_taxpayer', taxpayerId,
      { op: 'link_contact', portalContactId }, { op: 'unlink_contact', portalContactId, revokeAccess, revokedCompanies: revoked }, tx);
    return { revokedCompanies: revoked };
  });
}
