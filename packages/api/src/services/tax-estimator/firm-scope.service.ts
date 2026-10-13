// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { and, eq, sql, type SQL } from 'drizzle-orm';
import { resolveFirmCapabilities, type FirmCapabilityMap, type FirmRole } from '@kis-books/shared';
import { db } from '../../db/index.js';
import { firms, firmUsers, tenantFirmAssignments, userTenantAccess } from '../../db/schema/index.js';
import { taxEstFirmSettings } from '../../db/schema/tax-estimator-years.js';
import * as firmsService from '../firms.service.js';
import * as firmUsersService from '../firm-users.service.js';
import { AppError } from '../../utils/errors.js';

/**
 * Tax Estimator firm scope (MODULE.md D1).
 *
 * A Taxpayer belongs to a FIRM and its links may point at companies in any
 * tenant the firm manages. That makes every estimator query a deliberate
 * exception to "WHERE tenant_id = <request tenant>" (CLAUDE.md #17), so the
 * exception is confined to this one function, never to client input:
 *
 *   allowed tenants = tenants the firm actively manages (tenant_firm_assignments)
 *                     ∩ tenants the CALLER can reach (user_tenant_access)
 *
 * The second set is the same contract the Clients screen uses ("exposes nothing
 * the caller could not already see by switching into each client"). Super admins
 * have no access rows by design, so they get the firm's full managed set.
 * A tenant dropping out of either set drops out of the next computation.
 */
export interface FirmScope {
  firmId: string;
  firmRole: FirmRole;
  /** Server-resolved. NEVER accept this from the client. */
  allowedTenantIds: string[];
  /** D17: who is looking, for `visibleTaxpayerFilter`. Server-resolved, never client input. */
  viewer: TaxpayerViewer;
  /**
   * D18: present ONLY on a scope returned by `scopeForTaxpayer` that widened
   * `allowedTenantIds` for ONE taxpayer (the viewer is on its staff list). Never set by
   * `resolveScope`, never client input. Writes that add / modify links, entity settings,
   * treatments, GL references, payments pinned to a transaction and portal contacts use
   * `baseScope(scope)` so the widening can never reach them.
   */
  elevation?: { taxpayerId: string; baseTenantIds: string[] };
}

/**
 * D17 + D18 (Kurt, 2026-10-12) as amended by Q54 (Kurt, 2026-10-13) — taxpayer visibility.
 * Resolved once per request by `resolveScope` (every input server-side, never client input).
 *
 *   bypass (super admin, or UNRESTRICTED_VIEWER) → every taxpayer of the firm, listed or not.
 *   taxpayer WITH a staff list (`tax_est_taxpayer_staff` rows; D18) → visible iff the list
 *     names the user — firm admins included (Q54: a firm admin NOT on the list does not see
 *     it). The list REPLACES every other rule: tenant reach, the firm switch and the
 *     capability play no part (and `scopeForTaxpayer` widens that taxpayer's reads to its links).
 *   taxpayer with NO staff list →
 *     firm admin → visible (as before Q54);
 *     firm_staff / firm_readonly → (a) the member holds the firm capability
 *       `tax_estimator_view_taxpayers` (Q54; default OFF) AND the D17 firm rule holds — the
 *       switch `restrict_taxpayers_to_linked_tenants` OFF, or ON (default) and a link of the
 *       taxpayer points into a tenant of `allowedTenantIds` (any year); OR (b) the taxpayer has
 *       no active link (no link into a tenant the firm still actively manages) and the user
 *       created it (`created_by`; NULL = firm admins only) — with or without the capability.
 *     Tenant-level access alone (e.g. the Accountant role on a linked client) never reveals a
 *     taxpayer any more.
 *
 * Under the firm rule, data from linked tenants outside `allowedTenantIds` stays hidden (partial view).
 */
export interface TaxpayerViewer {
  /** The acting user; null only for UNRESTRICTED_VIEWER. */
  userId: string | null;
  /** Super admin (or UNRESTRICTED_VIEWER): every taxpayer, staff list or not. Q54: NOT firm admins. */
  bypass: boolean;
  /** Q54: firm_admin of the firm (not a super admin) — every taxpayer WITHOUT a staff list. */
  firmAdmin: boolean;
  /** Q54: the member holds `tax_estimator_view_taxpayers` (resolved from firm_users each request). */
  canViewUnlisted: boolean;
  restrictToLinkedTenants: boolean;
}

/**
 * Sees every taxpayer of the firm. ONLY for server paths that are not a staff user's view:
 * the client portal (its contact mapping governs it, D17 item 6) and service tests.
 */
export const UNRESTRICTED_VIEWER: TaxpayerViewer = Object.freeze({
  userId: null, bypass: true, firmAdmin: false, canViewUnlisted: true, restrictToLinkedTenants: false,
});

/** Q54: the firm capability that opens unlisted taxpayers to firm_staff / firm_readonly. */
export const TAX_EST_VIEW_CAPABILITY = 'tax_estimator_view_taxpayers' as const;

/**
 * Q54: true when the caller sees at least the taxpayers without a staff list (super admin, firm
 * admin, or the capability). The UI's "Ask a firm admin for Tax Estimator access" state keys off it.
 */
export const canViewUnlistedTaxpayers = (v: TaxpayerViewer): boolean => v.bypass || v.firmAdmin || v.canViewUnlisted;

/** Pick the caller's firm. One membership → that firm; several → `requestedFirmId` must name one. */
export async function resolveFirmForUser(
  userId: string,
  isSuperAdmin: boolean,
  requestedFirmId?: string,
): Promise<{ firmId: string; firmRole: FirmRole }> {
  if (isSuperAdmin) {
    if (!requestedFirmId) {
      throw AppError.badRequest('Select a firm (X-Firm-Id)', 'TE_FIRM_REQUIRED');
    }
    const firm = await firmsService.getById(requestedFirmId); // 404s an unknown id
    return { firmId: firm.id, firmRole: 'firm_admin' };
  }
  const myFirms = await firmsService.listForUser(userId);
  if (myFirms.length === 0) throw AppError.notFound('Feature not available');
  const chosen = requestedFirmId
    ? myFirms.find((f) => f.id === requestedFirmId)
    : myFirms.length === 1 ? myFirms[0] : undefined;
  if (!chosen) {
    if (requestedFirmId) throw AppError.notFound('Firm not found'); // hides non-membership
    throw AppError.badRequest('Select a firm (X-Firm-Id)', 'TE_FIRM_REQUIRED');
  }
  const role = await firmUsersService.getRoleForUser(chosen.id, userId);
  if (!role) throw AppError.notFound('Firm not found');
  return { firmId: chosen.id, firmRole: role };
}

export async function allowedTenantIds(firmId: string, userId: string, isSuperAdmin: boolean): Promise<string[]> {
  if (isSuperAdmin) {
    const rows = await db
      .select({ tenantId: tenantFirmAssignments.tenantId })
      .from(tenantFirmAssignments)
      .where(and(eq(tenantFirmAssignments.firmId, firmId), eq(tenantFirmAssignments.isActive, true)));
    return rows.map((r) => r.tenantId);
  }
  const rows = await db
    .select({ tenantId: tenantFirmAssignments.tenantId })
    .from(tenantFirmAssignments)
    .innerJoin(
      userTenantAccess,
      and(
        eq(userTenantAccess.tenantId, tenantFirmAssignments.tenantId),
        eq(userTenantAccess.userId, userId),
        eq(userTenantAccess.isActive, true),
      ),
    )
    .where(and(eq(tenantFirmAssignments.firmId, firmId), eq(tenantFirmAssignments.isActive, true)));
  return rows.map((r) => r.tenantId);
}

export async function resolveScope(
  userId: string,
  isSuperAdmin: boolean,
  requestedFirmId?: string,
): Promise<FirmScope> {
  const { firmId, firmRole } = await resolveFirmForUser(userId, isSuperAdmin, requestedFirmId);
  const [tenantIds, restrict, canView] = await Promise.all([
    allowedTenantIds(firmId, userId, isSuperAdmin), firmRestrictsToLinkedTenants(firmId),
    isSuperAdmin ? Promise.resolve(true) : memberHasViewCapability(firmId, userId),
  ]);
  return {
    firmId, firmRole, allowedTenantIds: tenantIds,
    viewer: {
      userId,
      bypass: isSuperAdmin, // Q54: firm admins are no longer a bypass for listed taxpayers
      firmAdmin: !isSuperAdmin && firmRole === 'firm_admin',
      canViewUnlisted: canView,
      restrictToLinkedTenants: restrict,
    },
  };
}

/**
 * Q54: does the ACTIVE membership of `userId` in the (active) firm hold
 * `tax_estimator_view_taxpayers`? Read from `firm_users.capabilities` on every request through
 * the shared resolver (NULL = role defaults: firm_staff / firm_readonly OFF; absent key = OFF).
 */
export async function memberHasViewCapability(firmId: string, userId: string): Promise<boolean> {
  const [row] = await db.select({ role: firmUsers.firmRole, caps: firmUsers.capabilities })
    .from(firmUsers)
    .innerJoin(firms, eq(firms.id, firmUsers.firmId))
    .where(and(eq(firmUsers.firmId, firmId), eq(firmUsers.userId, userId), eq(firmUsers.isActive, true), eq(firms.isActive, true)))
    .limit(1);
  if (!row) return false;
  return resolveFirmCapabilities(row.role, (row.caps ?? null) as FirmCapabilityMap | null)[TAX_EST_VIEW_CAPABILITY] === true;
}

/** The firm switch (D17). A firm that never saved settings is ON (the column default). */
export async function firmRestrictsToLinkedTenants(firmId: string): Promise<boolean> {
  const [row] = await db.select({ on: taxEstFirmSettings.restrictTaxpayersToLinkedTenants })
    .from(taxEstFirmSettings).where(eq(taxEstFirmSettings.firmId, firmId));
  return row ? row.on : true;
}

// Raw, fully qualified: the predicate is spliced into queries whose subqueries use their own
// aliases, and drizzle may render an unqualified column in some statement kinds.
const TP = sql.raw('"tax_est_taxpayers"');

/**
 * THE taxpayer visibility predicate (D17 / D18 / Q54 — see TaxpayerViewer), as SQL on `tax_est_taxpayers` (un-aliased) —
 * includes `firm_id = scope.firmId`. Every taxpayer read (list, by-id loaders, scenario /
 * adjustment / payment / snapshot loaders, Report Pack choices and rendering) puts this in
 * its WHERE, so a hidden taxpayer is indistinguishable from another firm's (404).
 */
export function visibleTaxpayerFilter(scope: FirmScope): SQL {
  const firm = sql`${TP}.firm_id = ${scope.firmId}::uuid`;
  const v = scope.viewer;
  if (v.bypass) return firm; // super admin / UNRESTRICTED_VIEWER only (Q54)
  if (!v.userId) return sql`false`;
  const uid = sql`${v.userId}::uuid`;
  // D18 / Q54: on a non-empty list → that alone decides (firm admins included); empty list → below.
  const listed = sql`EXISTS (SELECT 1 FROM tax_est_taxpayer_staff tes WHERE tes.firm_id = ${TP}.firm_id AND tes.taxpayer_id = ${TP}.id AND tes.user_id = ${uid})`;
  const noList = sql`NOT EXISTS (SELECT 1 FROM tax_est_taxpayer_staff tes WHERE tes.firm_id = ${TP}.firm_id AND tes.taxpayer_id = ${TP}.id)`;
  if (v.firmAdmin) return sql`(${firm} AND (${listed} OR ${noList}))`;
  // Q54 (c): the unlinked-own creator rule needs no capability.
  const unlinkedOwn = sql`(${TP}.created_by = ${uid} AND NOT EXISTS (
    SELECT 1 FROM tax_est_links tel
    JOIN tenant_firm_assignments tfa ON tfa.tenant_id = tel.tenant_id AND tfa.firm_id = ${TP}.firm_id AND tfa.is_active = true
    WHERE tel.taxpayer_id = ${TP}.id))`;
  // Q54 (b): without the firm capability, an unlisted taxpayer is visible only through (c).
  if (!v.canViewUnlisted) return sql`(${firm} AND (${listed} OR (${noList} AND ${unlinkedOwn})))`;
  if (!v.restrictToLinkedTenants) return sql`(${firm} AND (${listed} OR ${noList}))`;
  const reachable = scope.allowedTenantIds.length === 0
    ? sql`false`
    : sql`EXISTS (SELECT 1 FROM tax_est_links tel WHERE tel.taxpayer_id = ${TP}.id AND ${tenantInScopeSql(scope, sql.raw('tel.tenant_id'))})`;
  return sql`(${firm} AND (${listed} OR (${noList} AND (${reachable} OR ${unlinkedOwn}))))`;
}

/**
 * D18 (Kurt, 2026-10-12) — "full data" for a user on a taxpayer's staff list.
 *
 * Returns the scope to use for reads / computations OF `taxpayerId` (its links, its
 * entities' tax-basis figures, readiness, payments, Schedule AI figures, snapshots, PDFs,
 * Report Pack section): when the viewer is NOT a bypass user (Q54: firm admins are not) and
 * the taxpayer's staff list names them, `allowedTenantIds` gains every tenant the firm still ACTIVELY manages that the
 * taxpayer links into (any year) — the same tenants a super admin would read for it.
 * Otherwise the scope is returned unchanged (no `elevation`). Self-contained: membership is
 * checked here (firm + taxpayer + user), so a stray call can never widen anything.
 *
 * The widening is limited to that taxpayer's linked tenants (not the firm's whole set) and
 * must never feed a write that adds / modifies links, entity settings, treatments, GL
 * references or portal contacts (`baseScope`), raw books routes, company pickers or other
 * taxpayers. Cache keys built from the scope pick up the widened tenant set and the flag.
 */
export async function scopeForTaxpayer(scope: FirmScope, taxpayerId: string): Promise<FirmScope> {
  if (scope.elevation?.taxpayerId === taxpayerId) return scope;
  const base = baseScope(scope);
  const v = base.viewer;
  if (v.bypass || !v.userId) return base; // super admin: already the firm's full managed set
  const rows = (await db.execute(sql`SELECT DISTINCT tel.tenant_id::text AS tenant_id
    FROM tax_est_links tel
    JOIN tax_est_taxpayers tp ON tp.id = tel.taxpayer_id AND tp.firm_id = ${base.firmId}::uuid
    JOIN tenant_firm_assignments tfa ON tfa.tenant_id = tel.tenant_id AND tfa.firm_id = ${base.firmId}::uuid AND tfa.is_active = true
    WHERE tel.taxpayer_id = ${taxpayerId}::uuid
      AND EXISTS (SELECT 1 FROM tax_est_taxpayer_staff tes
        WHERE tes.firm_id = ${base.firmId}::uuid AND tes.taxpayer_id = ${taxpayerId}::uuid AND tes.user_id = ${v.userId}::uuid)
    ORDER BY 1`)).rows as Array<{ tenant_id: string }>;
  const extra = rows.map((r) => r.tenant_id).filter((t) => !base.allowedTenantIds.includes(t));
  if (extra.length === 0) return base;
  return { ...base, allowedTenantIds: [...base.allowedTenantIds, ...extra], elevation: { taxpayerId, baseTenantIds: base.allowedTenantIds } };
}

/** D18: the caller's own scope, without any per-taxpayer widening. Use at every write entry point. */
export function baseScope(scope: FirmScope): FirmScope {
  if (!scope.elevation) return scope;
  const { elevation, ...rest } = scope;
  return { ...rest, allowedTenantIds: elevation.baseTenantIds };
}

/** D18: true when `scope` carries widened data (audit metadata `elevated: true`, UI note). */
export const isElevated = (scope: FirmScope): boolean => scope.elevation !== undefined;

/** True when `tenantId` is inside the scope. Use before any single-row cross-tenant write or read. */
export function isTenantInScope(scope: FirmScope, tenantId: string): boolean {
  return scope.allowedTenantIds.includes(tenantId);
}

/**
 * SQL fragment: `tenant_id IN (<scope ids>)`, every id a bound parameter (rule #19; R3-14).
 * An empty scope matches nothing.
 */
export function tenantInScopeSql(scope: FirmScope, column = sql.raw('tenant_id')) {
  return scope.allowedTenantIds.length === 0
    ? sql`false`
    : sql`${column} IN (${sql.join(scope.allowedTenantIds.map((id) => sql`${id}::uuid`), sql`, `)})`;
}
