import type { Request, Response, NextFunction } from 'express';
import { AppError } from '../utils/errors.js';

/**
 * Ensures tenantId is present on the request (set by authenticate middleware).
 * This is a safety net — authenticate already sets tenantId.
 */
export function requireTenant(req: Request, _res: Response, next: NextFunction) {
  if (!req.tenantId) {
    throw AppError.unauthorized('Tenant context not available');
  }
  next();
}
