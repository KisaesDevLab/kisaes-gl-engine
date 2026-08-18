// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import crypto from 'crypto';
import { Router } from 'express';
import { eq, and } from 'drizzle-orm';
import { authenticate, requireSessionAuth } from '../middleware/auth.js';
import { db } from '../db/index.js';
import { apiKeys } from '../db/schema/index.js';
import { auditLog } from '../middleware/audit.js';
import { AppError } from '../utils/errors.js';

export const apiKeysRouter = Router();
apiKeysRouter.use(authenticate);
// Keys are durable credentials: only an interactive staff session may mint
// or manage them. An API key must not be able to mint further keys, and
// external (client-type) users have no API surface — their portal access
// is cookie-based and permission-templated, and an sk_ key would replay
// as userType 'staff' (see api-key-auth.ts), bypassing every client gate.
apiKeysRouter.use(requireSessionAuth);
apiKeysRouter.use((req, _res, next) => {
  if (req.userType === 'client') throw AppError.notFound('Not found');
  next();
});

function generateApiKey(): string {
  return 'sk_live_' + crypto.randomBytes(32).toString('hex');
}

function hashKey(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex');
}

// List API keys (never returns full key)
apiKeysRouter.get('/', async (req, res) => {
  const keys = await db.select({
    id: apiKeys.id,
    name: apiKeys.name,
    keyPrefix: apiKeys.keyPrefix,
    role: apiKeys.role,
    isActive: apiKeys.isActive,
    lastUsedAt: apiKeys.lastUsedAt,
    expiresAt: apiKeys.expiresAt,
    createdAt: apiKeys.createdAt,
  }).from(apiKeys).where(eq(apiKeys.tenantId, req.tenantId));

  res.json({ keys });
});

// What MCP scopes a role is permitted to mint. The previous
// implementation wrote no `scopes` column on insert, so the table default
// `all` applied and a readonly user could create an `sk_live_` key whose
// MCP session bypasses role-level write restrictions. Now the key's
// scopes are clamped to what the creating role is itself entitled to.
const SCOPES_FOR_ROLE: Record<string, string[]> = {
  owner: ['all'],
  accountant: ['read', 'write', 'reports', 'invoicing', 'banking'],
  readonly: ['read', 'reports'],
};

// Generate new API key
apiKeysRouter.post('/', async (req, res) => {
  const { name, role, expiresAt, scopes } = req.body;
  if (!name) {
    res.status(400).json({ error: { message: 'Name is required' } });
    return;
  }

  // Role authorization — cannot create keys with higher privileges than your own.
  // The key's role is replayed verbatim as req.userRole on every request
  // (api-key-auth.ts), so this clamp IS the privilege boundary: a readonly
  // or template-restricted bookkeeper minting an 'accountant' key would
  // otherwise get full accountant permissions through the REST/MCP surface.
  const validRoles = ['owner', 'accountant', 'readonly'];
  const requestedRole = role || (validRoles.includes(req.userRole) ? req.userRole : 'readonly');
  if (!validRoles.includes(requestedRole)) {
    res.status(400).json({ error: { message: `Invalid role. Must be one of: ${validRoles.join(', ')}` } });
    return;
  }
  const ROLE_RANK: Record<string, number> = { readonly: 1, bookkeeper: 1, accountant: 2, owner: 3 };
  const callerRank = req.isSuperAdmin ? 3 : (ROLE_RANK[req.userRole] ?? 0);
  const requestedRank = ROLE_RANK[requestedRole] ?? 99;
  if (requestedRank > callerRank) {
    res.status(403).json({ error: { message: 'Cannot create an API key with more privileges than your own role', code: 'API_KEY_ROLE_ESCALATION' } });
    return;
  }

  // Clamp requested scopes to what the role allows. If the caller didn't
  // specify scopes, default to the role's full envelope (which is still
  // narrower than the previous `all` default for non-owners).
  const allowedForRole = SCOPES_FOR_ROLE[requestedRole] || ['read'];
  const requestedScopes: string[] = Array.isArray(scopes)
    ? scopes
    : typeof scopes === 'string' && scopes.length > 0
      ? scopes.split(',').map((s) => s.trim()).filter(Boolean)
      : allowedForRole;
  const scopesToStore = requestedScopes.filter((s) => allowedForRole.includes(s));
  if (scopesToStore.length === 0) {
    res.status(400).json({ error: { message: `No valid scopes for role ${requestedRole}` } });
    return;
  }

  const rawKey = generateApiKey();
  const keyHash = hashKey(rawKey);
  const keyPrefix = rawKey.slice(0, 12);

  const [record] = await db.insert(apiKeys).values({
    tenantId: req.tenantId,
    userId: req.userId,
    name,
    keyPrefix,
    keyHash,
    role: requestedRole,
    scopes: scopesToStore.join(','),
    expiresAt: expiresAt ? new Date(expiresAt) : null,
  }).returning();

  // Audit only the metadata — never log keyHash/rawKey.
  if (record) {
    await auditLog(req.tenantId, 'create', 'api_key', record.id, null,
      { name: record.name, role: record.role, keyPrefix, scopes: scopesToStore }, req.userId);
  }

  // Return the full key ONCE — it cannot be retrieved again
  res.status(201).json({
    key: {
      id: record!.id,
      name: record!.name,
      keyPrefix,
      role: record!.role,
      createdAt: record!.createdAt,
      expiresAt: record!.expiresAt,
    },
    apiKey: rawKey, // Only returned on creation
  });
});

// Update API key
apiKeysRouter.put('/:id', async (req, res) => {
  const { name, isActive } = req.body;
  const before = await db.query.apiKeys.findFirst({
    where: and(eq(apiKeys.id, req.params['id']!), eq(apiKeys.tenantId, req.tenantId)),
  });
  const [updated] = await db.update(apiKeys)
    .set({
      ...(name !== undefined ? { name } : {}),
      ...(isActive !== undefined ? { isActive } : {}),
    })
    .where(and(eq(apiKeys.id, req.params['id']!), eq(apiKeys.tenantId, req.tenantId)))
    .returning();

  if (!updated) {
    res.status(404).json({ error: { message: 'API key not found' } });
    return;
  }
  await auditLog(req.tenantId, 'update', 'api_key', updated.id,
    before ? { name: before.name, isActive: before.isActive } : null,
    { name: updated.name, isActive: updated.isActive }, req.userId);
  res.json({ key: { id: updated.id, name: updated.name, isActive: updated.isActive } });
});

// Revoke API key
apiKeysRouter.delete('/:id', async (req, res) => {
  const before = await db.query.apiKeys.findFirst({
    where: and(eq(apiKeys.id, req.params['id']!), eq(apiKeys.tenantId, req.tenantId)),
  });
  await db.update(apiKeys)
    .set({ isActive: false })
    .where(and(eq(apiKeys.id, req.params['id']!), eq(apiKeys.tenantId, req.tenantId)));
  if (before) {
    await auditLog(req.tenantId, 'update', 'api_key', req.params['id']!,
      { name: before.name, isActive: before.isActive },
      { name: before.name, isActive: false, action: 'revoke' }, req.userId);
  }
  res.json({ message: 'API key revoked' });
});
