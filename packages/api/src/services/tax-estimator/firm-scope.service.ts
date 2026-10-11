// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { and, eq, sql } from 'drizzle-orm';
import type { FirmRole } from '@kis-books/shared';
import { db } from '../../db/index.js';
import { tenantFirmAssignments, userTenantAccess } from '../../db/schema/index.js';
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
}

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
  return { firmId, firmRole, allowedTenantIds: await allowedTenantIds(firmId, userId, isSuperAdmin) };
}

/** True when `tenantId` is inside the scope. Use before any single-row cross-tenant write or read. */
export function isTenantInScope(scope: FirmScope, tenantId: string): boolean {
  return scope.allowedTenantIds.includes(tenantId);
}

/** SQL fragment: `tenant_id = ANY(<scope ids>)`. An empty scope matches nothing. */
export function tenantInScopeSql(scope: FirmScope, column = sql.raw('tenant_id')) {
  return scope.allowedTenantIds.length === 0
    ? sql`false`
    : sql`${column} = ANY(${sql.raw(`ARRAY[${scope.allowedTenantIds.map((id) => `'${id.replace(/[^0-9a-fA-F-]/g, '')}'::uuid`).join(',')}]`)})`;
}
