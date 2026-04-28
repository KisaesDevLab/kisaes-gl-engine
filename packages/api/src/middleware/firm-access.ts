// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import type { Request, Response, NextFunction } from 'express';
import type { FirmRole } from '@kis-books/shared';
import { AppError } from '../utils/errors.js';
import * as firmUsersService from '../services/firm-users.service.js';
import * as tenantFirmAssignmentService from '../services/tenant-firm-assignment.service.js';

// 3-tier rules plan, Phase 1 — firm-access middleware.
// Two reusable gates the rules + firms routers compose with the
// existing `authenticate` middleware.

declare global {
  namespace Express {
    interface Request {
      /** Set by `requireFirmStaffOnTenant` after resolving the
       *  current tenant's managing firm. Undefined on routes
       *  that don't compose firm-access. */
      firmId?: string;
      /** Set by `requireFirmStaffOnTenant` and `requireFirmAdmin`
       *  with the calling user's role inside the firm. */
      firmRole?: FirmRole;
    }
  }
}

// Asserts the calling user is firm-staff on the tenant context
// of the current request (via `req.tenantId`, set by `authenticate`).
// Resolves the tenant's active firm assignment, then the user's
// role within that firm. Sets `req.firmId` + `req.firmRole`.
//
// 404 (not 403) is returned when the tenant has no managing firm
// — solo books should not expose the firm surface.
//
// Mount AFTER `authenticate`. Super-admins bypass the firm-staff
// check (they can act on any firm) but still get `req.firmRole`
// set to `firm_admin` so downstream code reads consistently.
export async function requireFirmStaffOnTenant(req: Request, _res: Response, next: NextFunction) {
  const assignment = await tenantFirmAssignmentService.getActiveForTenant(req.tenantId);
  if (!assignment) {
    throw AppError.notFound('This tenant is not managed by a firm');
  }
  if (req.isSuperAdmin) {
    req.firmId = assignment.firmId;
    req.firmRole = 'firm_admin';
    return next();
  }
  const role = await firmUsersService.getRoleForUser(assignment.firmId, req.userId);
  if (!role) {
    throw AppError.forbidden('Not a member of this firm', 'NOT_FIRM_MEMBER');
  }
  req.firmId = assignment.firmId;
  req.firmRole = role;
  next();
}

// Stricter variant: requires `firm_admin`. Use for global-rule
// authoring and firm-management endpoints. Mount AFTER
// `requireFirmStaffOnTenant` OR after a route-specific resolver
// that has set `req.firmId`/`req.firmRole`.
export function requireFirmAdmin(req: Request, _res: Response, next: NextFunction) {
  if (req.firmRole !== 'firm_admin') {
    throw AppError.forbidden('Firm admin role required', 'NOT_FIRM_ADMIN');
  }
  next();
}

// Variant for firm-management routes that take the firmId from
// the URL path (`/firms/:firmId/...`) rather than from the
// tenant context. Resolves the user's role within the path-
// specified firm and sets `req.firmId`/`req.firmRole`.
export function resolveFirmFromPath(paramName: string = 'firmId') {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const firmId = req.params[paramName];
    if (!firmId) {
      throw AppError.badRequest(`Missing ${paramName} path parameter`);
    }
    if (req.isSuperAdmin) {
      req.firmId = firmId;
      req.firmRole = 'firm_admin';
      return next();
    }
    const role = await firmUsersService.getRoleForUser(firmId, req.userId);
    if (!role) {
      // 404 hides the firm from non-members so they can't probe
      // for firm ids.
      throw AppError.notFound('Firm not found');
    }
    req.firmId = firmId;
    req.firmRole = role;
    next();
  };
}
