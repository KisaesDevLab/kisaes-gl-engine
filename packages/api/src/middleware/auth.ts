import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { eq } from 'drizzle-orm';
import type { JwtPayload } from '@kis-books/shared';
import { env } from '../config/env.js';
import { AppError } from '../utils/errors.js';
import { db } from '../db/index.js';
import { users } from '../db/schema/index.js';
import { apiKeyAuth } from './api-key-auth.js';

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

  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    throw AppError.unauthorized('Missing or invalid authorization header');
  }

  const token = authHeader.slice(7);
  try {
    const payload = jwt.verify(token, env.JWT_SECRET) as JwtPayload;

    // Verify user is still active
    const user = await db.query.users.findFirst({ where: eq(users.id, payload.userId) });
    if (!user || !user.isActive) {
      throw AppError.unauthorized('Account is deactivated');
    }

    req.userId = payload.userId;
    req.tenantId = payload.tenantId;
    req.userRole = payload.role;
    req.isSuperAdmin = payload.isSuperAdmin || false;
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
