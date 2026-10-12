// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import type { Request, Response, NextFunction } from 'express';
import { can } from '@kis-books/shared';
import type { FirmScope } from '../services/tax-estimator/firm-scope.service.js';
import { resolvePackScope } from '../services/tax-estimator/estimate-documents.service.js';
import { resolvePermissionsForRequest } from './permission.js';
import * as scopeService from '../services/tax-estimator/firm-scope.service.js';
import { AppError } from '../utils/errors.js';

declare global {
  namespace Express {
    interface Request {
      /** Set by `resolveTaxEstimatorScope`. Server-resolved; never client input. */
      taxEstimatorScope?: FirmScope;
    }
  }
}

/** Resolve the firm + allowed-tenant set once per request (MODULE.md D1). Mount after authenticate. */
export async function resolveTaxEstimatorScope(req: Request, _res: Response, next: NextFunction) {
  const header = req.header('x-firm-id');
  const requested = typeof header === 'string' && header.length > 0 ? header : undefined;
  const scope = await scopeService.resolveScope(req.userId, req.isSuperAdmin === true, requested);
  req.taxEstimatorScope = scope;
  req.firmId = scope.firmId;
  req.firmRole = scope.firmRole;
  next();
}

/** Mutations need firm_admin or firm_staff; firm_readonly may read only. */
export function requireTaxEstimatorWrite(req: Request, _res: Response, next: NextFunction) {
  const role = req.taxEstimatorScope?.firmRole;
  if (role !== 'firm_admin' && role !== 'firm_staff') {
    throw AppError.forbidden('Firm staff role required', 'TE_NOT_FIRM_STAFF');
  }
  next();
}

export function getScope(req: Request): FirmScope {
  if (!req.taxEstimatorScope) throw AppError.forbidden('Scope not resolved', 'TE_SCOPE_MISSING');
  return req.taxEstimatorScope;
}

/**
 * Phase 13 gate for the Report Pack `tax-estimate` section and /reports/tax-estimate*
 * (these ride the reports routers, not the tax-estimator router). Same rules as the
 * staff router — interactive session, not a client user, TAX_ESTIMATOR_V1 on the active
 * tenant, the tax_estimator resource, firm membership — with the firm taken from the
 * ACTIVE tenant's managing firm (the pack's company lives there) and that tenant inside
 * the caller's D1 scope. Returns null when the caller may not use the section.
 */
export async function taxEstimateReportScope(req: Request): Promise<FirmScope | null> {
  if (req.userType === 'client') return null;
  if (req.authKind && req.authKind !== 'session') return null;
  const perms = await resolvePermissionsForRequest(req);
  if (!can(perms, 'tax_estimator', 'read')) return null;
  try {
    return await resolvePackScope(req.tenantId, req.userId, req.isSuperAdmin === true);
  } catch (err) {
    if (err instanceof AppError && err.statusCode === 404) return null;
    throw err;
  }
}
