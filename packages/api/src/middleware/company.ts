// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import type { Request, Response, NextFunction } from 'express';
import { eq, and } from 'drizzle-orm';
import { db } from '../db/index.js';
import { companies } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';

// Extend Express Request with companyId
declare global {
  namespace Express {
    interface Request {
      companyId: string;
    }
  }
}

/**
 * Middleware that extracts and validates the active company from the X-Company-Id header.
 * Falls back to the first company for the tenant if no header is provided (backward compat).
 * Must be used AFTER the authenticate middleware.
 */
export async function companyContext(req: Request, _res: Response, next: NextFunction) {
  // Accept company ID from header or query param (direct-navigation PDF exports).
  const headerCompanyId = (req.headers['x-company-id'] as string | undefined)
    || (req.query['_company'] as string | undefined);

  if (headerCompanyId) {
    // Validate it belongs to this tenant
    const company = await db.query.companies.findFirst({
      where: and(eq(companies.id, headerCompanyId), eq(companies.tenantId, req.tenantId)),
    });
    if (!company) {
      throw AppError.forbidden('Company not found or access denied');
    }
    req.companyId = company.id;
  } else {
    // Fallback: use first company for tenant (backward compatibility)
    const company = await db.query.companies.findFirst({
      where: eq(companies.tenantId, req.tenantId),
    });
    if (!company) {
      throw AppError.notFound('No company found for this account');
    }
    req.companyId = company.id;
  }

  next();
}
