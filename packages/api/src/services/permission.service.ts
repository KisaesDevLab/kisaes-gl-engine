// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { and, eq } from 'drizzle-orm';
import {
  resolveEffectivePermissions,
  isCustomizablePrincipal,
  type PermissionMap,
  type EffectivePermissions,
  type CreatePermissionTemplateInput,
  type UpdatePermissionTemplateInput,
  type SetUserPermissionsInput,
} from '@kis-books/shared';
import { db } from '../db/index.js';
import { permissionTemplates, userPermissions, users, userTenantAccess } from '../db/schema/index.js';
import { isDesktop } from '../desktop/profile.js';
import { auditLog } from '../middleware/audit.js';
import { AppError } from '../utils/errors.js';

// Per-member permissions service. Mirrors feature-flags.service.ts:
// tenant-scoped reads, a set-with-before/after path for audit, and a
// single resolver call that turns stored template + overrides into the
// effective map. Backend enforcement (middleware/permission.ts) and the
// /auth/me payload both flow through getEffectivePermissions so the API
// and UI never disagree.

// ─── Templates ───────────────────────────────────────────────

export async function listTemplates(tenantId: string) {
  return db
    .select()
    .from(permissionTemplates)
    .where(eq(permissionTemplates.tenantId, tenantId))
    .orderBy(permissionTemplates.name);
}

async function getTemplateOrThrow(tenantId: string, id: string) {
  const [tpl] = await db
    .select()
    .from(permissionTemplates)
    .where(and(eq(permissionTemplates.tenantId, tenantId), eq(permissionTemplates.id, id)))
    .limit(1);
  if (!tpl) throw AppError.notFound('Permission template not found');
  return tpl;
}

export async function createTemplate(
  tenantId: string,
  input: CreatePermissionTemplateInput,
  actingUserId?: string,
) {
  const [existing] = await db
    .select({ id: permissionTemplates.id })
    .from(permissionTemplates)
    .where(and(eq(permissionTemplates.tenantId, tenantId), eq(permissionTemplates.name, input.name)))
    .limit(1);
  if (existing) throw AppError.badRequest('A template with that name already exists', 'TEMPLATE_NAME_TAKEN');

  const [tpl] = await db
    .insert(permissionTemplates)
    .values({
      tenantId,
      name: input.name,
      description: input.description ?? null,
      permissions: input.permissions ?? {},
    })
    .returning();
  await auditLog(tenantId, 'create', 'permission_template', tpl!.id, null, tpl, actingUserId);
  return tpl!;
}

export async function updateTemplate(
  tenantId: string,
  id: string,
  input: UpdatePermissionTemplateInput,
  actingUserId?: string,
) {
  const before = await getTemplateOrThrow(tenantId, id);
  const [after] = await db
    .update(permissionTemplates)
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.permissions !== undefined ? { permissions: input.permissions } : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(permissionTemplates.tenantId, tenantId), eq(permissionTemplates.id, id)))
    .returning();
  await auditLog(tenantId, 'update', 'permission_template', id, before, after, actingUserId);
  return after!;
}

export async function deleteTemplate(tenantId: string, id: string, actingUserId?: string) {
  const before = await getTemplateOrThrow(tenantId, id);
  // template_id on user_permissions is ON DELETE SET NULL — assignees
  // fall back to their overrides (deny-by-default) rather than being
  // deleted along with the template.
  await db
    .delete(permissionTemplates)
    .where(and(eq(permissionTemplates.tenantId, tenantId), eq(permissionTemplates.id, id)));
  await auditLog(tenantId, 'delete', 'permission_template', id, before, null, actingUserId);
}

// ─── Per-user assignment ─────────────────────────────────────

export async function getUserPermissionRow(tenantId: string, userId: string) {
  const [row] = await db
    .select()
    .from(userPermissions)
    .where(and(eq(userPermissions.tenantId, tenantId), eq(userPermissions.userId, userId)))
    .limit(1);
  return row ?? null;
}

export async function setUserPermissions(
  tenantId: string,
  userId: string,
  input: SetUserPermissionsInput,
  actingUserId?: string,
) {
  // Guard against cross-tenant template linking.
  if (input.templateId) {
    await getTemplateOrThrow(tenantId, input.templateId);
  }
  const before = await getUserPermissionRow(tenantId, userId);

  const values = {
    tenantId,
    userId,
    templateId: input.templateId ?? null,
    overrides: input.overrides ?? before?.overrides ?? {},
    updatedAt: new Date(),
  };

  const [after] = await db
    .insert(userPermissions)
    .values(values)
    .onConflictDoUpdate({
      target: [userPermissions.tenantId, userPermissions.userId],
      set: { templateId: values.templateId, overrides: values.overrides, updatedAt: values.updatedAt },
    })
    .returning();
  await auditLog(tenantId, before ? 'update' : 'create', 'user_permissions', userId, before, after, actingUserId);
  return after!;
}

// ─── Effective resolution ────────────────────────────────────

// The single source of truth used by both the request guard and the
// /auth/me payload. Only customizable principals (bookkeepers and external
// client users) touch the DB; every other role resolves purely from its
// role, so this stays cheap for the common case.
export async function getEffectivePermissions(
  tenantId: string,
  userId: string,
  role: string | undefined,
  userType: 'staff' | 'client' | undefined,
  isSuperAdmin: boolean,
): Promise<EffectivePermissions> {
  // Only bookkeepers and external (client) users consult the table; every
  // other staff role is decided purely by role. A client with no row still
  // resolves by role (a client owner keeps full ledger access).
  if (isSuperAdmin || !isCustomizablePrincipal(role, userType)) {
    return resolveEffectivePermissions({ role, userType, isSuperAdmin, hasPermissionRow: false });
  }

  const row = await getUserPermissionRow(tenantId, userId);
  if (!row) {
    return resolveEffectivePermissions({ role, userType, isSuperAdmin, hasPermissionRow: false });
  }

  let templateMap: PermissionMap | null = null;
  if (row.templateId) {
    const [tpl] = await db
      .select({ permissions: permissionTemplates.permissions })
      .from(permissionTemplates)
      .where(and(eq(permissionTemplates.tenantId, tenantId), eq(permissionTemplates.id, row.templateId)))
      .limit(1);
    templateMap = tpl?.permissions ?? null;
  }

  return resolveEffectivePermissions({
    role,
    userType,
    isSuperAdmin,
    hasPermissionRow: true,
    templateMap,
    overrides: row.overrides,
  });
}

/**
 * The effective permissions a user holds in a tenant RIGHT NOW, without a
 * request (background jobs acting for a user, e.g. a template's auto run).
 * The role is derived as a token refresh derives it (auth.service
 * refreshTokens): home tenant -> users.role (desktop: the workspace access
 * row, else readonly); another tenant -> the active access row's role (a
 * super admin without a row: owner). Null when the user is gone, inactive
 * or has no access to the tenant.
 */
export async function getEffectivePermissionsForUser(tenantId: string, userId: string): Promise<EffectivePermissions | null> {
  const [u] = await db.select({
    tenantId: users.tenantId, role: users.role, isActive: users.isActive, userType: users.userType, isSuperAdmin: users.isSuperAdmin,
  }).from(users).where(eq(users.id, userId)).limit(1);
  if (!u || u.isActive === false) return null;
  const superAdmin = u.isSuperAdmin === true;
  const [access] = await db.select({ role: userTenantAccess.role, isActive: userTenantAccess.isActive }).from(userTenantAccess)
    .where(and(eq(userTenantAccess.userId, userId), eq(userTenantAccess.tenantId, tenantId))).limit(1);
  let role: string | null;
  if (u.tenantId === tenantId) {
    role = isDesktop() ? (access?.isActive ? (access.role || 'readonly') : 'readonly') : u.role;
  } else if (access?.isActive) {
    role = access.role || u.role;
  } else {
    role = superAdmin ? 'owner' : null;
  }
  if (!role) return null;
  return getEffectivePermissions(tenantId, userId, role, u.userType === 'client' ? 'client' : 'staff', superAdmin);
}
