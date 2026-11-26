// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

// Which clients an MCP caller can work in, and with what rights.
//
// A caller reaches a client's books the way they do in the app: their own
// tenant, plus every tenant they hold an active user_tenant_access row for
// (firm staff get those from Firm > Staff > Tenant access; a firm admin gets
// one per managed client automatically). The rights inside each client are
// resolved per call from that tenant's role and permission template, so
// someone who is read-only on one client and a bookkeeper on another gets
// exactly that through MCP.

import { and, eq, inArray, sql } from 'drizzle-orm';
import { can, type McpAuthContext, type McpClientCompany } from '@kis-books/shared';
import { db } from '../db/index.js';
import { companies, userTenantAccess, users, accountantCompanyExclusions } from '../db/schema/index.js';
import { getEffectivePermissionsForUser } from '../services/permission.service.js';
import { sensitiveAccountIds } from '../services/visibility.js';
import { McpToolError, type McpClientContext, type ToolAccess } from './registry.js';

// ─── Active company per connection ──────────────────────────────
//
// Held in memory. Keyed by the connection (the MCP session id when the
// client sends one, else the key or OAuth grant), never by user alone: one
// staff member working two clients in two chats must not have one chat's
// set_active_company move the other. A restart forgets it; the next call
// then asks for a company again.

const MAX_SESSIONS = 10_000;
const activeSessions = new Map<string, string>();

export function sessionKeyFor(auth: McpAuthContext, mcpSessionId?: string): string {
  const principal = auth.keyId ? `key:${auth.keyId}` : `oauth:${auth.oauthClientId ?? '-'}:${auth.userId}`;
  // The id is whatever the client sends back: bounded and plain before it
  // becomes part of a map key.
  const session = mcpSessionId && /^[\x21-\x7e]{1,128}$/.test(mcpSessionId) ? mcpSessionId : undefined;
  return session ? `${principal}:${session}` : principal;
}

export function setActiveCompany(sessionKey: string, companyId: string): void {
  activeSessions.delete(sessionKey);
  if (activeSessions.size >= MAX_SESSIONS) {
    const oldest = activeSessions.keys().next().value;
    if (oldest !== undefined) activeSessions.delete(oldest);
  }
  activeSessions.set(sessionKey, companyId);
}

export function getActiveCompany(sessionKey: string): string | undefined {
  return activeSessions.get(sessionKey);
}

// ─── The caller's clients ───────────────────────────────────────

/**
 * One entry per tenant the user can open: the tenant's first company the
 * user is not excluded from (accountant_company_exclusions), as
 * middleware/company.ts picks it. Tools work on the whole tenant's books, so
 * a tenant is one client here whatever number of companies it holds.
 */
export async function getUserCompanies(userId: string): Promise<McpClientCompany[]> {
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user || !user.isActive) return [];

  const access = await db.select({ tenantId: userTenantAccess.tenantId, role: userTenantAccess.role })
    .from(userTenantAccess)
    .where(and(eq(userTenantAccess.userId, userId), eq(userTenantAccess.isActive, true)));
  const roleByTenant = new Map<string, string>();
  for (const a of access) roleByTenant.set(a.tenantId, a.role || user.role);
  // The home tenant's role is the user's own (permission.service derives it the same way).
  roleByTenant.set(user.tenantId, user.role);
  const tenantIds = [...roleByTenant.keys()];

  // A scratch copy made by a test restore can never be opened (auth.service switchTenant).
  const scratch = await db.execute<{ tenant_id: string }>(
    sql`SELECT tenant_id::text AS tenant_id FROM tenant_archive_imports WHERE scratch = true`,
  );
  const scratchIds = new Set(scratch.rows.map((r) => r.tenant_id));

  // An accountant excluded from a company must not reach it through MCP
  // either. Super admins are never excluded.
  const excluded = user.isSuperAdmin
    ? new Set<string>()
    : new Set(
        (await db.select({ companyId: accountantCompanyExclusions.companyId })
          .from(accountantCompanyExclusions)
          .where(eq(accountantCompanyExclusions.userId, userId))
        ).map((e) => e.companyId),
      );

  const rows = await db.select({
    id: companies.id, tenantId: companies.tenantId, businessName: companies.businessName,
    mcpEnabled: companies.mcpEnabled, createdAt: companies.createdAt,
  }).from(companies).where(inArray(companies.tenantId, tenantIds)).orderBy(companies.createdAt);

  const byTenant = new Map<string, McpClientCompany>();
  for (const row of rows) {
    if (byTenant.has(row.tenantId) || scratchIds.has(row.tenantId) || excluded.has(row.id)) continue;
    byTenant.set(row.tenantId, {
      id: row.id,
      name: row.businessName,
      tenantId: row.tenantId,
      role: roleByTenant.get(row.tenantId) ?? 'readonly',
      mcpEnabled: row.mcpEnabled === true,
    });
  }
  return [...byTenant.values()].sort((a, b) => a.name.localeCompare(b.name));
}

const COMPANY_LIST_CAP = 50;

/**
 * The client a call runs in: `company_id` when given, else the connection's
 * active company, else the caller's only company. Checks, in order, that the
 * caller can open it, that the key (if restricted) covers it, that the
 * company allows MCP, and that nothing in its books is hidden from the caller.
 */
export async function resolveClient(
  auth: McpAuthContext,
  sessionKey: string,
  explicitCompanyId: string | undefined,
): Promise<McpClientContext> {
  const everything = await getUserCompanies(auth.userId);
  // A key limited to some companies sees only those: when choosing a
  // default, and in the list a COMPANY_REQUIRED answer names.
  const all = auth.allowedCompanies
    ? everything.filter((c) => auth.allowedCompanies!.includes(c.id))
    : everything;
  const find = (companyId: string) => all.find((c) => c.id === companyId);

  let company = explicitCompanyId ? find(explicitCompanyId) : undefined;
  if (explicitCompanyId && !company) {
    throw new McpToolError(
      'ACCESS_DENIED',
      everything.some((c) => c.id === explicitCompanyId)
        ? 'This API key is not authorized for this company'
        : 'You do not have access to this company',
    );
  }
  if (!company) {
    const active = getActiveCompany(sessionKey);
    company = active ? find(active) : undefined;
  }
  if (!company && all.length === 1) company = all[0];
  if (!company) {
    if (all.length === 0) throw new McpToolError('ACCESS_DENIED', 'You do not have access to any company');
    throw new McpToolError(
      'COMPANY_REQUIRED',
      'You can work in more than one client. Pass company_id, or call set_active_company first (list_companies shows them).',
      {
        available_companies: all.slice(0, COMPANY_LIST_CAP).map((c) => ({ id: c.id, name: c.name })),
        total_companies: all.length,
      },
    );
  }

  if (!company.mcpEnabled) {
    throw new McpToolError(
      'MCP_DISABLED',
      `MCP access is turned off for ${company.name}. An owner can turn it on under Settings > Company Profile > API & MCP Access.`,
    );
  }

  // The caller's rights in THIS client, read now: a role changed or an
  // access row revoked since the token was issued applies at once.
  const permissions = await getEffectivePermissionsForUser(company.tenantId, auth.userId);
  if (!permissions) throw new McpToolError('ACCESS_DENIED', 'You do not have access to this company');

  // Sensitive accounts (U-33). The app hides them query by query for a
  // viewer without the right; MCP tools are not converted to that, so a
  // caller who has anything hidden in this client is refused outright
  // rather than shown figures they cannot see in the app.
  if (!can(permissions, 'sensitive_accounts', 'read') && (await sensitiveAccountIds(company.tenantId)).length > 0) {
    throw new McpToolError(
      'SENSITIVE_HIDDEN',
      `${company.name} has accounts hidden for your role, so it cannot be opened through MCP. Use the app for this client.`,
    );
  }

  const user = await db.query.users.findFirst({ where: eq(users.id, auth.userId), columns: { isSuperAdmin: true } });
  return {
    companyId: company.id,
    companyName: company.name,
    tenantId: company.tenantId,
    role: company.role,
    isSuperAdmin: user?.isSuperAdmin === true,
    permissions,
  };
}

/** The permission check the REST routers make with requireResource / requirePermission. */
export function assertAccess(client: McpClientContext, access: ToolAccess): void {
  for (const resource of access.resources) {
    if (!can(client.permissions, resource, access.action)) {
      throw new McpToolError(
        'PERMISSION_DENIED',
        `Your role in ${client.companyName} does not allow this (${access.action === 'read' ? 'view' : 'full'} access to ${resource} is needed).`,
      );
    }
  }
}
