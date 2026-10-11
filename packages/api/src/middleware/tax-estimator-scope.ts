// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import type { Request, Response, NextFunction } from 'express';
import type { FirmScope } from '../services/tax-estimator/firm-scope.service.js';
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
