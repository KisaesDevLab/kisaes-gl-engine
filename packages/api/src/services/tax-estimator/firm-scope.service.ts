// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { and, eq, sql, type SQL } from 'drizzle-orm';
import type { FirmRole } from '@kis-books/shared';
import { db } from '../../db/index.js';
import { tenantFirmAssignments, userTenantAccess } from '../../db/schema/index.js';
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
}

/**
 * D17 (Kurt, 2026-10-12) — taxpayer visibility. Resolved once per request by `resolveScope`.
 *
 *   bypass (firm_admin in the firm, or super admin) → every taxpayer of the firm.
 *   otherwise, ALL of:
 *     - staff allow-list: the taxpayer has no `tax_est_taxpayer_staff` rows, or one names the user;
 *     - when the firm switch `restrict_taxpayers_to_linked_tenants` is ON (default):
 *         a link of the taxpayer points into a tenant of `allowedTenantIds` (any year), OR
 *         the taxpayer has no active link (no link into a tenant the firm still actively
 *         manages) and the user created it (`created_by`; NULL = firm admins only).
 *
 * Data from linked tenants outside `allowedTenantIds` stays hidden as before (partial view).
 */
export interface TaxpayerViewer {
  /** The acting user; null only for UNRESTRICTED_VIEWER. */
  userId: string | null;
  bypass: boolean;
  restrictToLinkedTenants: boolean;
}

/**
 * Sees every taxpayer of the firm. ONLY for server paths that are not a staff user's view:
 * the client portal (its contact mapping governs it, D17 item 6) and service tests.
 */
export const UNRESTRICTED_VIEWER: TaxpayerViewer = Object.freeze({ userId: null, bypass: true, restrictToLinkedTenants: false });

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
  const [tenantIds, restrict] = await Promise.all([
    allowedTenantIds(firmId, userId, isSuperAdmin), firmRestrictsToLinkedTenants(firmId),
  ]);
  return {
    firmId, firmRole, allowedTenantIds: tenantIds,
    viewer: { userId, bypass: isSuperAdmin || firmRole === 'firm_admin', restrictToLinkedTenants: restrict },
  };
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
 * THE taxpayer visibility predicate (D17), as SQL on `tax_est_taxpayers` (un-aliased) —
 * includes `firm_id = scope.firmId`. Every taxpayer read (list, by-id loaders, scenario /
 * adjustment / payment / snapshot loaders, Report Pack choices and rendering) puts this in
 * its WHERE, so a hidden taxpayer is indistinguishable from another firm's (404).
 */
export function visibleTaxpayerFilter(scope: FirmScope): SQL {
  const firm = sql`${TP}.firm_id = ${scope.firmId}::uuid`;
  const v = scope.viewer;
  if (v.bypass) return firm;
  if (!v.userId) return sql`false`;
  const uid = sql`${v.userId}::uuid`;
  const allowList = sql`(NOT EXISTS (SELECT 1 FROM tax_est_taxpayer_staff tes WHERE tes.firm_id = ${TP}.firm_id AND tes.taxpayer_id = ${TP}.id)
    OR EXISTS (SELECT 1 FROM tax_est_taxpayer_staff tes WHERE tes.firm_id = ${TP}.firm_id AND tes.taxpayer_id = ${TP}.id AND tes.user_id = ${uid}))`;
  if (!v.restrictToLinkedTenants) return sql`(${firm} AND ${allowList})`;
  const reachable = scope.allowedTenantIds.length === 0
    ? sql`false`
    : sql`EXISTS (SELECT 1 FROM tax_est_links tel WHERE tel.taxpayer_id = ${TP}.id AND ${tenantInScopeSql(scope, sql.raw('tel.tenant_id'))})`;
  const unlinkedOwn = sql`(${TP}.created_by = ${uid} AND NOT EXISTS (
    SELECT 1 FROM tax_est_links tel
    JOIN tenant_firm_assignments tfa ON tfa.tenant_id = tel.tenant_id AND tfa.firm_id = ${TP}.firm_id AND tfa.is_active = true
    WHERE tel.taxpayer_id = ${TP}.id))`;
  return sql`(${firm} AND ${allowList} AND (${reachable} OR ${unlinkedOwn}))`;
}

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
