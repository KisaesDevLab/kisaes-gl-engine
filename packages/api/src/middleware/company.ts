// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import type { Request, Response, NextFunction } from 'express';
import { eq, and } from 'drizzle-orm';
import { db } from '../db/index.js';
import { companies, accountantCompanyExclusions } from '../db/schema/index.js';
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

  // Admin → "exclude this accountant from company X" (accountant_company_
  // exclusions). Historically this only filtered GET /company/list, so an
  // excluded user could still send X-Company-Id and work in the company.
  // Enforce it here, the one choke point every company-scoped router
  // passes through. Super-admins are never excluded.
  const excluded = req.isSuperAdmin || !req.userId
    ? new Set<string>()
    : new Set(
        (await db.select({ companyId: accountantCompanyExclusions.companyId })
          .from(accountantCompanyExclusions)
          .where(eq(accountantCompanyExclusions.userId, req.userId))
        ).map((e) => e.companyId),
      );

  if (headerCompanyId) {
    // Validate it belongs to this tenant
    const company = await db.query.companies.findFirst({
      where: and(eq(companies.id, headerCompanyId), eq(companies.tenantId, req.tenantId)),
    });
    if (!company || excluded.has(company.id)) {
      throw AppError.forbidden('Company not found or access denied');
    }
    req.companyId = company.id;
  } else {
    // Fallback: first company for the tenant the user is NOT excluded from
    // (backward compatibility for clients that don't send X-Company-Id).
    const candidates = await db.query.companies.findMany({
      where: eq(companies.tenantId, req.tenantId),
      orderBy: (c, { asc }) => [asc(c.createdAt)],
    });
    const company = candidates.find((c) => !excluded.has(c.id));
    if (!company) {
      throw AppError.notFound('No company found for this account');
    }
    req.companyId = company.id;
  }

  next();
}
