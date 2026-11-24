// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

/**
 * Agent principals (U-297, agent-principal-v1): one MCP connection is one
 * agent user (users.user_type 'agent') plus its one API key, minted together
 * here, server-side, in one transaction, for a signed-in human with
 * team_management on the company. The connection id IS the agent user id
 * (audit origin 'mcp:<id>').
 *
 * An agent user has no usable password (a random one is hashed and thrown
 * away), never holds a session, and its email is a non-routable
 * `@agents.invalid` address. Its role lives on its access row like any
 * team member's, so Team role and permission-template changes apply on the
 * agent's next request (api-key-auth.ts reads it live; the key's stored role
 * is 'readonly' and never used). Desktop: homed in the workspace with a
 * readonly workspace row, like an invited user (auth.service inviteUser).
 */

import crypto from 'node:crypto';
import bcrypt from 'bcrypt';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { apiKeys, permissionTemplates, userPermissions, users, userTenantAccess } from '../db/schema/index.js';
import { env } from '../config/env.js';
import { auditLog } from '../middleware/audit.js';
import { AppError } from '../utils/errors.js';
import { isDesktop } from '../desktop/profile.js';
import { assertNotWorkspace, requireWorkspaceTenantId } from '../desktop/workspace.js';

export const AGENT_ROLES = ['owner', 'accountant', 'bookkeeper', 'readonly'] as const;
export type AgentRole = typeof AGENT_ROLES[number];

export interface MintAgentInput {
  name: string;
  role: AgentRole;
  /** A permission template of this company; needs role 'bookkeeper' (the template-driven role). */
  templateId?: string | null;
}

export interface AgentConnection {
  id: string;
  name: string;
  role: string;
  templateId: string | null;
  isActive: boolean;
  keyPrefix: string | null;
  lastUsedAt: string | null;
  createdAt: string | null;
}

const iso = (d: Date | string | null | undefined): string | null => (d ? new Date(d).toISOString() : null);

function generateAgentKey(): string {
  return 'sk_live_' + crypto.randomBytes(32).toString('hex');
}

/**
 * Mints the agent user and its API key in one transaction and returns the
 * raw key once (it is never stored or shown again). `createdBy` is the
 * signed-in human; the route has checked session auth and team_management.
 */
export async function mintAgentPrincipal(
  tenantId: string,
  input: MintAgentInput,
  createdBy: string,
): Promise<{ connection: AgentConnection; apiKey: string }> {
  if (isDesktop()) await assertNotWorkspace(tenantId);
  if (!(AGENT_ROLES as readonly string[]).includes(input.role)) {
    throw AppError.badRequest(`Role must be one of: ${AGENT_ROLES.join(', ')}`, 'AGENT_ROLE_INVALID');
  }
  if (input.templateId) {
    if (input.role !== 'bookkeeper') {
      throw AppError.badRequest('A permission template needs the bookkeeper role.', 'AGENT_TEMPLATE_ROLE');
    }
    const [tpl] = await db.select({ id: permissionTemplates.id }).from(permissionTemplates)
      .where(and(eq(permissionTemplates.tenantId, tenantId), eq(permissionTemplates.id, input.templateId))).limit(1);
    if (!tpl) throw AppError.notFound('Permission template not found');
  }

  const workspaceId = isDesktop() ? await requireWorkspaceTenantId() : null;
  // Nobody ever learns this password; the agent cannot sign in with it.
  const passwordHash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), env.BCRYPT_ROUNDS);
  const rawKey = generateAgentKey();
  const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
  const keyPrefix = rawKey.slice(0, 12);

  const result = await db.transaction(async (tx) => {
    const [user] = await tx.insert(users).values({
      tenantId: workspaceId ?? tenantId,
      email: `agent-${crypto.randomUUID()}@agents.invalid`,
      passwordHash,
      displayName: input.name,
      role: input.role,
      userType: 'agent',
      isSuperAdmin: false,
      passwordChangeRequired: false,
    }).returning();
    if (!user) throw AppError.internal('Failed to create the AI connection');
    await tx.insert(userTenantAccess).values(workspaceId
      ? [{ userId: user.id, tenantId: workspaceId, role: 'readonly' }, { userId: user.id, tenantId, role: input.role }]
      : [{ userId: user.id, tenantId, role: input.role }]);
    if (input.templateId) {
      await tx.insert(userPermissions).values({ tenantId, userId: user.id, templateId: input.templateId, overrides: {} });
    }
    const [key] = await tx.insert(apiKeys).values({
      tenantId,
      userId: user.id,
      name: input.name,
      keyPrefix,
      keyHash,
      // Never replayed for an agent (the role is read live); fail closed if anything ever does.
      role: 'readonly',
      scopes: 'read',
    }).returning();
    if (!key) throw AppError.internal('Failed to create the AI connection');
    await auditLog(tenantId, 'create', 'mcp_connection', user.id, null,
      { name: input.name, role: input.role, templateId: input.templateId ?? null, keyPrefix }, createdBy, tx);
    return { user, key };
  });

  return {
    connection: {
      id: result.user.id,
      name: input.name,
      role: input.role,
      templateId: input.templateId ?? null,
      isActive: true,
      keyPrefix,
      lastUsedAt: null,
      createdAt: iso(result.user.createdAt),
    },
    apiKey: rawKey,
  };
}

/** The company's AI connections (agent users with an access row here), oldest first. */
export async function listAgentConnections(tenantId: string): Promise<AgentConnection[]> {
  const rows = await db.execute<{
    id: string; name: string | null; role: string; template_id: string | null; is_active: boolean;
    key_prefix: string | null; last_used_at: Date | null; created_at: Date | null;
  }>(sql`
    SELECT u.id, u.display_name AS name, COALESCE(uta.role, u.role) AS role, up.template_id,
      (uta.is_active AND COALESCE(u.is_active, true) AND COALESCE(k.is_active, false)) AS is_active,
      k.key_prefix, k.last_used_at, u.created_at
    FROM user_tenant_access uta
    JOIN users u ON u.id = uta.user_id AND u.user_type = 'agent'
    LEFT JOIN user_permissions up ON up.tenant_id = uta.tenant_id AND up.user_id = u.id
    LEFT JOIN LATERAL (
      SELECT key_prefix, last_used_at, is_active FROM api_keys
      WHERE user_id = u.id AND tenant_id = uta.tenant_id ORDER BY created_at DESC LIMIT 1
    ) k ON true
    WHERE uta.tenant_id = ${tenantId}
    ORDER BY u.created_at, u.id`);
  return rows.rows.map((r) => ({
    id: r.id,
    name: r.name ?? '',
    role: r.role,
    templateId: r.template_id ?? null,
    isActive: r.is_active === true,
    keyPrefix: r.key_prefix ?? null,
    lastUsedAt: iso(r.last_used_at),
    createdAt: iso(r.created_at),
  }));
}

/**
 * Removes an AI connection: its keys, its access here and the agent user are
 * turned off in one transaction, so its next request is refused (401). Rows
 * stay for the audit trail. Idempotent; 404 for an id that is not an agent of
 * this company.
 */
export async function revokeAgentConnection(tenantId: string, agentUserId: string, revokedBy: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx.select({ id: users.id, isActive: users.isActive }).from(users)
      .innerJoin(userTenantAccess, and(eq(userTenantAccess.userId, users.id), eq(userTenantAccess.tenantId, tenantId)))
      .where(and(eq(users.id, agentUserId), eq(users.userType, 'agent')))
      .for('update', { of: users })
      .limit(1);
    if (!row) throw AppError.notFound('AI connection not found');
    const keys = await tx.update(apiKeys).set({ isActive: false, revokedAt: new Date(), revokedBy })
      .where(and(eq(apiKeys.userId, agentUserId), eq(apiKeys.isActive, true)))
      .returning({ id: apiKeys.id });
    await tx.update(userTenantAccess).set({ isActive: false }).where(eq(userTenantAccess.userId, agentUserId));
    await tx.update(users).set({ isActive: false, updatedAt: new Date() }).where(eq(users.id, agentUserId));
    if (row.isActive !== false || keys.length > 0) {
      await auditLog(tenantId, 'update', 'mcp_connection', agentUserId, { isActive: true }, { isActive: false, action: 'revoke' }, revokedBy, tx);
    }
  });
}
