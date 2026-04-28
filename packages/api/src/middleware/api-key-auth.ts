// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import crypto from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { apiKeys } from '../db/schema/index.js';
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

  // Set request context
  req.userId = record.userId;
  req.tenantId = record.tenantId;
  req.userRole = record.role;
  // API keys are issued by staff users for staff workflows. Practice
  // routes still gate on userType so default 'staff' is correct here.
  req.userType = 'staff';
  req.isSuperAdmin = false;
  req.impersonating = undefined;

  // Update last used — log failures instead of silently swallowing
  db.update(apiKeys).set({ lastUsedAt: new Date() })
    .where(eq(apiKeys.id, record.id))
    .catch((err) => console.error(`Failed to update lastUsedAt for API key ${record.id}:`, err));

  next();
}
