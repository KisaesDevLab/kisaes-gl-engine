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
      /** 'staff' (firm employee) or 'client' (read-only contact in /portal).
       *  Practice routes server-side gate on this so a client user with a
       *  bookkeeper role can't reach /api/v1/practice/* by skipping the UI. */
      userType: 'staff' | 'client';
      isSuperAdmin: boolean;
      impersonating?: string;
      /** JWT `iat` claim in seconds. Set by authenticate() — used by
       *  requireSuperAdmin to enforce the admin idle-timeout bound. */
      tokenIssuedAt?: number;
    }
  }
}

function parseExpiryToSeconds(expiry: string): number {
  const match = expiry.match(/^(\d+)(s|m|h|d)$/);
  if (!match) return 1800;
  const value = parseInt(match[1]!, 10);
  const unit = match[2]!;
  switch (unit) {
    case 's': return value;
    case 'm': return value * 60;
    case 'h': return value * 3600;
    case 'd': return value * 86400;
    default: return 1800;
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
    // Download tokens are issued only to staff sessions; clients have no
    // PDF-export surface in /portal. Default 'staff' is safe.
    req.userType = 'staff';
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
    const payload = jwt.verify(token, env.JWT_SECRET, { algorithms: ['HS256'] }) as JwtPayload & { iat?: number };

    // Verify user is still active
    const user = await db.query.users.findFirst({ where: eq(users.id, payload.userId) });
    if (!user || !user.isActive) {
      throw AppError.unauthorized('Account is deactivated');
    }

    req.userId = payload.userId;
    req.tenantId = payload.tenantId;
    req.userRole = payload.role;
    // user.userType is constrained at the DB layer (CHECK IN ('staff','client'))
    // but defaults to 'staff' for any column null/legacy edge.
    req.userType = user.userType === 'client' ? 'client' : 'staff';
    req.isSuperAdmin = !!user.isSuperAdmin;
    req.impersonating = payload.impersonating;
    req.tokenIssuedAt = typeof payload.iat === 'number' ? payload.iat : undefined;
    next();
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw AppError.unauthorized('Invalid or expired token');
  }
}

/**
 * Middleware that requires super admin role.
 * Must be used AFTER authenticate.
 *
 * Also enforces the admin idle-timeout bound (CLOUDFLARE_TUNNEL_PLAN
 * Phase 3). Tokens older than JWT_ADMIN_MAX_AGE are rejected with
 * `ADMIN_SESSION_EXPIRED` so the frontend can force a re-login on
 * admin routes without affecting the normal staff session. Skipped
 * for API-key callers (req.tokenIssuedAt is undefined) because API
 * keys have their own rotation policy.
 */
export function requireSuperAdmin(req: Request, _res: Response, next: NextFunction) {
  if (!req.isSuperAdmin) {
    throw AppError.forbidden('Super admin access required');
  }
  if (req.tokenIssuedAt) {
    const maxAgeSec = parseExpiryToSeconds(env.JWT_ADMIN_MAX_AGE);
    const ageSec = Math.floor(Date.now() / 1000) - req.tokenIssuedAt;
    if (ageSec > maxAgeSec) {
      throw AppError.unauthorized(
        `Admin session idle timeout exceeded (${Math.floor(maxAgeSec / 60)} minutes). Please sign in again.`,
        'ADMIN_SESSION_EXPIRED',
      );
    }
  }
  next();
}
