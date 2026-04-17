// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import crypto from 'crypto';
import { Router } from 'express';
import { eq, and } from 'drizzle-orm';
import { authenticate } from '../middleware/auth.js';
import { db } from '../db/index.js';
import { apiKeys } from '../db/schema/index.js';

export const apiKeysRouter = Router();
apiKeysRouter.use(authenticate);

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

  // Role authorization — cannot create keys with higher privileges than your own
  const validRoles = ['owner', 'accountant', 'readonly'];
  const requestedRole = role || req.userRole || 'readonly';
  if (!validRoles.includes(requestedRole)) {
    res.status(400).json({ error: { message: `Invalid role. Must be one of: ${validRoles.join(', ')}` } });
    return;
  }
  if (requestedRole === 'owner' && req.userRole !== 'owner') {
    res.status(403).json({ error: { message: 'Only owners can create full-access API keys' } });
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
  res.json({ key: { id: updated.id, name: updated.name, isActive: updated.isActive } });
});

// Revoke API key
apiKeysRouter.delete('/:id', async (req, res) => {
  await db.update(apiKeys)
    .set({ isActive: false })
    .where(and(eq(apiKeys.id, req.params['id']!), eq(apiKeys.tenantId, req.tenantId)));
  res.json({ message: 'API key revoked' });
});
