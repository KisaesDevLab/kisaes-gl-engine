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

import crypto from 'crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { can, type McpAuthContext, type McpClientCompany } from '@kis-books/shared';
import { env } from '../config/env.js';
import { db } from '../db/index.js';
import { companies, userTenantAccess, users, accountantCompanyExclusions } from '../db/schema/index.js';
import { getEffectivePermissionsForUser } from '../services/permission.service.js';
import { sensitiveAccountIds } from '../services/visibility.js';
import { McpToolError, type McpClientContext, type ToolAccess } from './registry.js';

// ─── Active company per connection ──────────────────────────────
//
// Held in memory, per connection, never by user alone: one staff member
// working two clients in two chats must not have one chat's
// set_active_company move the other.
//
// A connection is known by the Mcp-Session-Id this server handed out at
// initialize. The id is signed, so only an id we issued to this same key or
// sign-in counts; anything else (no header, a made-up value, another
// caller's id) is treated as "no session of its own". Such a caller shares
// one remembered client per key or sign-in, which is good enough to read
// with but not to change data with: resolveClient refuses a write that
// would rely on it (owner decision, 2026-11-26).
//
// A restart, or twelve idle hours, forgets the choice; the next call that
// needs one is asked for a company again. With more than one API process
// each holds its own map, so a choice made on one may be unknown to
// another: that call is asked for a company, it is never sent elsewhere.

export interface McpSession {
  /** Keys the remembered client. */
  key: string;
  /** True when the caller sent back a session id this server issued to it. */
  own: boolean;
}

const MAX_SESSIONS = 10_000;
const SESSION_IDLE_MS = 12 * 60 * 60 * 1000;
const activeSessions = new Map<string, { companyId: string; at: number }>();

function principalOf(auth: McpAuthContext): string {
  return auth.keyId ? `key:${auth.keyId}` : `oauth:${auth.oauthClientId ?? '-'}:${auth.userId}`;
}

function signSession(principal: string, id: string): string {
  return crypto.createHmac('sha256', env.JWT_SECRET).update(`mcp-session:${principal}:${id}`).digest('base64url').slice(0, 32);
}

/** A new session id for this caller, sent as Mcp-Session-Id on initialize. */
export function issueSessionId(auth: McpAuthContext): string {
  const id = crypto.randomUUID();
  return `${id}.${signSession(principalOf(auth), id)}`;
}

export function sessionFor(auth: McpAuthContext, mcpSessionId?: string): McpSession {
  const principal = principalOf(auth);
  const match = mcpSessionId ? /^([0-9a-f-]{36})\.([A-Za-z0-9_-]{32})$/.exec(mcpSessionId) : null;
  if (match) {
    const expected = Buffer.from(signSession(principal, match[1]!));
    const given = Buffer.from(match[2]!);
    if (expected.length === given.length && crypto.timingSafeEqual(expected, given)) {
      return { key: `${principal}:${match[1]}`, own: true };
    }
  }
  return { key: principal, own: false };
}

export function setActiveCompany(sessionKey: string, companyId: string): void {
  activeSessions.delete(sessionKey);
  if (activeSessions.size >= MAX_SESSIONS) {
    const oldest = activeSessions.keys().next().value;
    if (oldest !== undefined) activeSessions.delete(oldest);
  }
  activeSessions.set(sessionKey, { companyId, at: Date.now() });
}

export function clearActiveCompany(sessionKey: string): void {
  activeSessions.delete(sessionKey);
}

export function getActiveCompany(sessionKey: string): string | undefined {
  const entry = activeSessions.get(sessionKey);
  if (!entry) return undefined;
  if (Date.now() - entry.at > SESSION_IDLE_MS) {
    activeSessions.delete(sessionKey);
    return undefined;
  }
  entry.at = Date.now();
  return entry.companyId;
}

// ─── The caller's clients ───────────────────────────────────────

/**
 * One entry per company the user can open, in every tenant they reach.
 *
 * A company the accountant is excluded from (accountant_company_exclusions)
 * is not offered, as middleware/company.ts skips it. A write is stamped
 * with, and checked against, the company it names, the way the app does it.
 *
 * Most reads still cover the whole client file (the tenant). So MCP is on
 * for a company only while every company in its file has it on. Known gap,
 * unchanged from before: an accountant excluded from one company of a file
 * can still read that company's figures through the tenant-wide read tools
 * of a sibling company (list_attachments is the exception, it is scoped).
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

  // Super admins are never excluded.
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

  const mcpOffIn = new Map<string, string>();
  for (const row of rows) {
    if (row.mcpEnabled !== true && !mcpOffIn.has(row.tenantId)) mcpOffIn.set(row.tenantId, row.businessName);
  }

  const out: McpClientCompany[] = [];
  for (const row of rows) {
    if (scratchIds.has(row.tenantId) || excluded.has(row.id)) continue;
    const offIn = mcpOffIn.get(row.tenantId);
    out.push({
      id: row.id,
      name: row.businessName,
      tenantId: row.tenantId,
      role: roleByTenant.get(row.tenantId) ?? 'readonly',
      mcpEnabled: offIn === undefined,
      ...(offIn !== undefined && row.mcpEnabled === true ? { mcpOffIn: offIn } : {}),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

const COMPANY_LIST_CAP = 50;

/**
 * The client a call runs in: `company_id` when given, else the connection's
 * remembered company, else the caller's only company. Checks, in order, that
 * the caller can open it, that the key (if restricted) covers it, that the
 * company allows MCP, and that nothing in its books is hidden from the caller.
 *
 * `write` marks a call that changes data. Such a call uses the remembered
 * company only on a connection with its own session (McpSession.own);
 * otherwise it must name the company, so a choice made in another chat on
 * the same key or sign-in can never decide where a change lands.
 */
export async function resolveClient(
  auth: McpAuthContext,
  session: McpSession,
  explicitCompanyId: string | undefined,
  opts: { write?: boolean } = {},
): Promise<McpClientContext> {
  const everything = await getUserCompanies(auth.userId);
  // A key limited to some companies sees only those: when choosing a
  // default, and in the list a COMPANY_REQUIRED answer names.
  const all = auth.allowedCompanies
    ? everything.filter((c) => auth.allowedCompanies!.includes(c.id))
    : everything;
  const find = (companyId: string) => all.find((c) => c.id === companyId);
  const choices = () => ({
    available_companies: all.slice(0, COMPANY_LIST_CAP).map((c) => ({ id: c.id, name: c.name })),
    total_companies: all.length,
  });

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
    const active = getActiveCompany(session.key);
    if (active) {
      const remembered = find(active);
      if (!remembered) {
        // The client chosen earlier is gone (access removed, key narrowed).
        // Never fall through to whichever client happens to be left.
        clearActiveCompany(session.key);
        if (all.length === 0) throw new McpToolError('ACCESS_DENIED', 'You do not have access to any company');
        throw new McpToolError(
          'COMPANY_REQUIRED',
          'The client chosen earlier on this connection can no longer be opened. Pass company_id, or call set_active_company again (list_companies shows them).',
          choices(),
        );
      }
      if (opts.write && !session.own && all.length > 1) {
        throw new McpToolError(
          'COMPANY_REQUIRED',
          `This connection has no session of its own, so the client chosen with set_active_company (${remembered.name}) is used for reading only. `
            + 'To change data, pass company_id in this call.',
          choices(),
        );
      }
      company = remembered;
    }
  }
  if (!company && all.length === 1) company = all[0];
  if (!company) {
    if (all.length === 0) throw new McpToolError('ACCESS_DENIED', 'You do not have access to any company');
    throw new McpToolError(
      'COMPANY_REQUIRED',
      'You can work in more than one client. Pass company_id, or call set_active_company first (list_companies shows them).',
      choices(),
    );
  }

  if (!company.mcpEnabled && company.mcpOffIn) {
    throw new McpToolError(
      'MCP_DISABLED',
      `MCP reaches the whole client file, and it is turned off for ${company.mcpOffIn}, which shares a file with ${company.name}. `
        + 'An owner can turn it on for each company under Settings > Company Profile > API & MCP Access.',
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
