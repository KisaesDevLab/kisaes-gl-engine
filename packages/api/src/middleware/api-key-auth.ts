// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

import crypto from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { apiKeys, users, userTenantAccess } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import { assertUserUsable } from './principal-check.js';
import { agentOrigin } from '../services/principal-context.js';

function hashKey(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex');
}

export async function apiKeyAuth(req: Request, _res: Response, next: NextFunction) {
  const key = req.headers['x-api-key'] as string;
  if (!key) {
    throw AppError.unauthorized('Missing API key');
  }

  const keyHash = hashKey(key);
  const record = await db.query.apiKeys.findFirst({
    where: eq(apiKeys.keyHash, keyHash),
  });

  if (!record) {
    throw AppError.unauthorized('Invalid API key');
  }

  // Timing-safe comparison to prevent timing attacks
  try {
    if (!crypto.timingSafeEqual(Buffer.from(keyHash, 'hex'), Buffer.from(record.keyHash, 'hex'))) {
      throw AppError.unauthorized('Invalid API key');
    }
  } catch {
    throw AppError.unauthorized('Invalid API key');
  }

  if (!record.isActive) {
    throw AppError.unauthorized('API key has been revoked');
  }

  if (record.expiresAt && new Date() > record.expiresAt) {
    throw AppError.unauthorized('API key has expired');
  }

  // The key is only as alive as its owner: a deactivated (offboarded) user
  // must not keep API access through a key issued while they were active —
  // JWT auth enforces the same check on every request.
  // Security review S3: and while the owner must choose a new password (U-230), the key waits too.
  const owner = await db.query.users.findFirst({ where: eq(users.id, record.userId) });
  assertUserUsable(req, owner);
  if (!owner) throw AppError.unauthorized('Account is deactivated');

  // U-297 (agent-principal-v1): an agent user's key never replays the role
  // stored on the key. The role is read live from the agent's access row for
  // the key's company (falling back to users.role, as refresh() does), so a
  // role or template change in Team applies on the agent's next request, and
  // a removed access row ends the key at once.
  let role = record.role;
  const isAgent = owner.userType === 'agent';
  if (isAgent) {
    const access = await db.query.userTenantAccess.findFirst({
      where: and(eq(userTenantAccess.userId, owner.id), eq(userTenantAccess.tenantId, record.tenantId)),
    });
    if (!access || !access.isActive) throw AppError.unauthorized('This AI connection was removed.', 'AGENT_REVOKED');
    role = access.role || owner.role;
  }

  // Set request context
  req.userId = record.userId;
  req.tenantId = record.tenantId;
  req.userRole = role;
  req.principalKind = isAgent ? 'agent' : undefined;
  req.principalOrigin = isAgent ? agentOrigin(owner.id) : undefined;
  req.principalActionId = undefined;
  // Replay the OWNER's userType, never a blanket 'staff': a key minted
  // (historically) by an external client-type user must keep every
  // client gate (practice/TB/portal-staff routers 404 on 'client').
  // An agent stays 'staff' here; its kind is req.principalKind.
  req.userType = owner.userType === 'client' ? 'client' : 'staff';
  req.isSuperAdmin = false;
  req.impersonating = undefined;
  req.authKind = 'api_key';

  // Update last used — log failures instead of silently swallowing
  db.update(apiKeys).set({ lastUsedAt: new Date() })
    .where(eq(apiKeys.id, record.id))
    .catch((err) => console.error(`Failed to update lastUsedAt for API key ${record.id}:`, err));

  next();
}

/**
 * True when `key` is a live API key (exists, active, not expired). For
 * pre-auth gates (e.g. the larger invoice-email body limit) that must not
 * trust a header's mere presence; authenticate still runs in full after.
 */
export async function isLiveApiKey(key: string): Promise<boolean> {
  const record = await db.query.apiKeys.findFirst({ where: eq(apiKeys.keyHash, hashKey(key)) });
  if (!record || !record.isActive) return false;
  return !(record.expiresAt && new Date() > record.expiresAt);
}
