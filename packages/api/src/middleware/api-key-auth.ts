// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import crypto from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { apiKeys, users } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';

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
  const owner = await db.query.users.findFirst({ where: eq(users.id, record.userId) });
  if (!owner || !owner.isActive) {
    throw AppError.unauthorized('Account is deactivated');
  }

  // Set request context
  req.userId = record.userId;
  req.tenantId = record.tenantId;
  req.userRole = record.role;
  // Replay the OWNER's userType, never a blanket 'staff': a key minted
  // (historically) by an external client-type user must keep every
  // client gate (practice/TB/portal-staff routers 404 on 'client').
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
