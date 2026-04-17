// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { eq } from 'drizzle-orm';
import type { JwtPayload } from '@kis-books/shared';
import { env } from '../config/env.js';
import { AppError } from '../utils/errors.js';
import { db } from '../db/index.js';
import { users } from '../db/schema/index.js';
import { apiKeyAuth } from './api-key-auth.js';
import { consumeDownloadToken } from '../utils/download-token.js';

declare global {
  namespace Express {
    interface Request {
      userId: string;
      tenantId: string;
      userRole: string;
      isSuperAdmin: boolean;
      impersonating?: string;
    }
  }
}

export async function authenticate(req: Request, res: Response, next: NextFunction) {
  const hasApiKey = !!req.headers['x-api-key'];
  const hasJwt = !!req.headers.authorization?.startsWith('Bearer ');

  if (hasApiKey && hasJwt) {
    throw AppError.unauthorized('Cannot use both API key and JWT authentication simultaneously');
  }

  if (hasApiKey) {
    return apiKeyAuth(req, res, next);
  }

  // Preferred URL-auth path for direct-navigation exports (open PDF in new
  // tab): single-use ~60s download tokens issued by /api/v1/downloads/token.
  // The token carries the session context forward without exposing the JWT
  // in URLs, history, or proxy logs.
  const dlTokenRaw = req.query['_dl'];
  const dlToken = typeof dlTokenRaw === 'string' ? dlTokenRaw : undefined;
  if (dlToken) {
    const payload = consumeDownloadToken(dlToken);
    if (!payload) throw AppError.unauthorized('Invalid or expired download token');
    req.userId = payload.userId;
    req.tenantId = payload.tenantId;
    req.userRole = payload.userRole;
    req.isSuperAdmin = payload.isSuperAdmin;
    if (payload.companyId && !req.headers['x-company-id']) {
      req.headers['x-company-id'] = payload.companyId;
    }
    next();
    return;
  }

  const authHeader = req.headers.authorization;
  // Legacy URL-auth path kept for backward compatibility. Prefer ?_dl= for
  // new integrations — it avoids putting the full access token in URLs,
  // browser history, and referer headers.
  const queryToken = req.query['_token'] as string | undefined;

  if (!authHeader?.startsWith('Bearer ') && !queryToken) {
    throw AppError.unauthorized('Missing or invalid authorization header');
  }

  const token = queryToken || authHeader!.slice(7);
  try {
    const payload = jwt.verify(token, env.JWT_SECRET, { algorithms: ['HS256'] }) as JwtPayload;

    // Verify user is still active
    const user = await db.query.users.findFirst({ where: eq(users.id, payload.userId) });
    if (!user || !user.isActive) {
      throw AppError.unauthorized('Account is deactivated');
    }

    req.userId = payload.userId;
    req.tenantId = payload.tenantId;
    req.userRole = payload.role;
    req.isSuperAdmin = !!user.isSuperAdmin;
    req.impersonating = payload.impersonating;
    next();
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw AppError.unauthorized('Invalid or expired token');
  }
}

/**
 * Middleware that requires super admin role.
 * Must be used AFTER authenticate.
 */
export function requireSuperAdmin(req: Request, _res: Response, next: NextFunction) {
  if (!req.isSuperAdmin) {
    throw AppError.forbidden('Super admin access required');
  }
  next();
}
