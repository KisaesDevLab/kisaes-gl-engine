// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * Desktop workspace tenant (CL_MODE=desktop only).
 *
 * /api/v1/desktop/initialize creates ONE hidden tenant (tenants.is_workspace,
 * migration 0216) that holds every user row and no company. Real companies
 * are ordinary tenants reached through user_tenant_access. Login lands in
 * the workspace (it is every user's home tenant), so a session there may
 * only use the routes in WORKSPACE_ALLOWED_PREFIXES; everything else is
 * 409 WORKSPACE_TENANT ("Open a company first."). Admin tenant routes refuse
 * the workspace as a target.
 *
 * On the server every function here is a no-op: there is no workspace.
 */

import crypto from 'node:crypto';
import bcrypt from 'bcrypt';
import type { Request } from 'express';
import { eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { tenants, users, userTenantAccess } from '../db/schema/index.js';
import { env } from '../config/env.js';
import { AppError } from '../utils/errors.js';
import { isDesktop } from './profile.js';
import { desktopWarning } from './fatal.js';

/**
 * Paths a workspace session may use. An entry ending in `/` matches
 * everything below it; any other entry matches itself and whole path
 * segments below it (`/api/v1/tenants` does not match `/api/v1/tenant-settings`).
 * Widened only by an engine change (documented in docs/DESKTOP.md).
 */
export const WORKSPACE_ALLOWED_PREFIXES: readonly string[] = [
  '/api/v1/auth/',
  '/api/v1/tenants',
  '/api/v1/tenant-archives',
  '/api/v1/desktop/',
];

export const WORKSPACE_TENANT_NAME = 'Workspace';

// Positive cache only: the workspace is created once and never deleted, so
// once found its id never changes. Before /initialize there is none, and the
// lookup runs again (there are no users then, so no authenticated requests).
let cachedWorkspaceId: string | null = null;

/** The workspace tenant id (desktop), or null before /initialize and on the server. */
export async function getWorkspaceTenantId(): Promise<string | null> {
  if (!isDesktop()) return null;
  if (cachedWorkspaceId) return cachedWorkspaceId;
  const rows = await db.select({ id: tenants.id }).from(tenants)
    .where(eq(tenants.isWorkspace, true))
    .limit(1);
  cachedWorkspaceId = rows[0]?.id ?? null;
  return cachedWorkspaceId;
}

/** The workspace id, or 409 WORKSPACE_MISSING (desktop mode only). */
export async function requireWorkspaceTenantId(): Promise<string> {
  const id = await getWorkspaceTenantId();
  if (!id) {
    throw AppError.conflict('This company file has no workspace. Run first-time setup.', 'WORKSPACE_MISSING');
  }
  return id;
}

export function _resetWorkspaceCacheForTests(): void {
  cachedWorkspaceId = null;
}

export async function isWorkspaceTenant(tenantId: string | null | undefined): Promise<boolean> {
  if (!tenantId || !isDesktop()) return false;
  const ws = await getWorkspaceTenantId();
  return ws !== null && ws === tenantId;
}

/** 409 WORKSPACE_TENANT when `tenantId` is the workspace. No-op on the server. */
export async function assertNotWorkspace(tenantId: string | null | undefined): Promise<void> {
  if (await isWorkspaceTenant(tenantId)) {
    throw AppError.conflict('This action needs a company, not the workspace.', 'WORKSPACE_TENANT');
  }
}

/** Whether a request path (no query string) may be used from a workspace session. */
export function isWorkspacePathAllowed(path: string): boolean {
  // Fail closed on dot segments and encoded separators; real clients never
  // send them and they could disagree with how the router resolves the path.
  if (/(^|\/)\.\.?(\/|$)|%2e|%2f|%5c|\\/i.test(path)) return false;
  return WORKSPACE_ALLOWED_PREFIXES.some((p) =>
    p.endsWith('/') ? path.startsWith(p) : path === p || path.startsWith(`${p}/`),
  );
}

/**
 * Workspace write fence, called by authenticate() on every auth kind once
 * req.tenantId is known. Reads are fenced too: the workspace has no books.
 */
export async function workspaceFence(req: Request): Promise<void> {
  if (!isDesktop()) return;
  if (!(await isWorkspaceTenant(req.tenantId))) return;
  const path = (req.originalUrl || req.url || '').split('?')[0]!;
  if (isWorkspacePathAllowed(path)) return;
  throw AppError.conflict('Open a company first.', 'WORKSPACE_TENANT');
}

export type AdminTenantRefusal = 'safe-delete' | 'unavailable';

/**
 * Desktop guard for the admin /tenants/:id… routes: the workspace is never a
 * target (409 WORKSPACE_TENANT); `safe-delete` routes answer 409
 * USE_SAFE_DELETE and `unavailable` routes 404 NOT_AVAILABLE_IN_DESKTOP,
 * because they change or remove books without taking a backup first.
 * No-op on the server.
 */
export async function guardAdminTenantRoute(tenantId: string | undefined, refusal?: AdminTenantRefusal): Promise<void> {
  if (!isDesktop()) return;
  await assertNotWorkspace(tenantId);
  if (refusal === 'safe-delete') {
    throw AppError.conflict(
      'Delete companies with the desktop app\'s Delete Company command, which takes a backup first.',
      'USE_SAFE_DELETE',
    );
  }
  if (refusal === 'unavailable') {
    throw new AppError(404, 'Not available in the desktop edition.', 'NOT_AVAILABLE_IN_DESKTOP');
  }
}

export interface WorkspaceOwnerInput {
  email: string;
  displayName: string;
  password: string;
}

/**
 * Create the workspace tenant, the owner (homed there, super admin) and the
 * owner's workspace access row in ONE transaction. Creates no company and no
 * firm rows. The caller holds the setup lock and has checked that the
 * database has no users and no tenants.
 */
export async function createWorkspaceWithOwner(input: WorkspaceOwnerInput): Promise<{ workspaceTenantId: string; userId: string }> {
  const passwordHash = await bcrypt.hash(input.password, env.BCRYPT_ROUNDS);
  const email = input.email.trim().toLowerCase();
  const created = await db.transaction(async (tx) => {
    const [ws] = await tx.insert(tenants).values({
      name: WORKSPACE_TENANT_NAME,
      slug: `workspace-${crypto.randomBytes(4).toString('hex')}`,
      isWorkspace: true,
    }).returning({ id: tenants.id });
    if (!ws) throw new Error('workspace insert returned no row');
    const [user] = await tx.insert(users).values({
      tenantId: ws.id,
      email,
      passwordHash,
      displayName: input.displayName,
      role: 'owner',
      isSuperAdmin: true,
    }).returning({ id: users.id });
    if (!user) throw new Error('owner insert returned no row');
    await tx.insert(userTenantAccess).values({ userId: user.id, tenantId: ws.id, role: 'owner' });
    return { workspaceTenantId: ws.id, userId: user.id };
  });
  cachedWorkspaceId = created.workspaceTenantId;
  return created;
}

export interface WorkspaceInvariantReport {
  ok: boolean;
  workspaces: number;
  users: number;
  usersNotHomed: number;
  usersWithoutWorkspaceAccess: number;
  /** Up to 20 offending user ids (ids only, never emails or names). */
  sampleUserIds: string[];
}

/**
 * Boot check (desktop, once initialized): exactly one workspace, and every
 * user homed there with an active workspace access row. A violation is a
 * warning with counts and ids only; it never stops the engine. Returns null
 * when not initialized (no users) or on the server.
 */
export async function checkWorkspaceInvariant(): Promise<WorkspaceInvariantReport | null> {
  if (!isDesktop()) return null;
  const userCount = Number(((await db.execute(sql`SELECT COUNT(*)::int AS n FROM users`)).rows[0] as { n: number }).n);
  if (userCount === 0) return null;
  const wsRows = (await db.execute(sql`SELECT id FROM tenants WHERE is_workspace`)).rows as Array<{ id: string }>;
  const wsId = wsRows.length === 1 ? wsRows[0]!.id : null;
  const notHomed = (await db.execute(sql`
    SELECT id FROM users
    WHERE ${wsId === null ? sql`true` : sql`tenant_id <> ${wsId}`}
    ORDER BY id
  `)).rows as Array<{ id: string }>;
  const noAccess = (await db.execute(sql`
    SELECT u.id FROM users u
    WHERE NOT EXISTS (
      SELECT 1 FROM user_tenant_access a
      WHERE a.user_id = u.id AND a.is_active = true
        AND ${wsId === null ? sql`false` : sql`a.tenant_id = ${wsId}`}
    )
    ORDER BY u.id
  `)).rows as Array<{ id: string }>;
  const ok = wsRows.length === 1 && notHomed.length === 0 && noAccess.length === 0;
  const sampleUserIds = [...new Set([...notHomed, ...noAccess].map((r) => r.id))].slice(0, 20);
  const report: WorkspaceInvariantReport = {
    ok,
    workspaces: wsRows.length,
    users: userCount,
    usersNotHomed: notHomed.length,
    usersWithoutWorkspaceAccess: noAccess.length,
    sampleUserIds,
  };
  if (!ok) {
    desktopWarning(
      'WORKSPACE_INVARIANT',
      `workspaces=${report.workspaces} users=${report.users} usersNotHomed=${report.usersNotHomed} `
        + `usersWithoutWorkspaceAccess=${report.usersWithoutWorkspaceAccess} userIds=${sampleUserIds.join(',')}`,
    );
  }
  return report;
}
