// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import type { Request, Response, NextFunction } from 'express';
import type { FirmRole } from '@kis-books/shared';
import { AppError } from '../utils/errors.js';
import * as firmsService from '../services/firms.service.js';
import * as firmUsersService from '../services/firm-users.service.js';

// 3-tier rules plan, Phase 1 — firm-access middleware.
// Two reusable gates the rules + firms routers compose with the
// existing `authenticate` middleware.

declare global {
  namespace Express {
    interface Request {
      /** Set by `resolveFirmFromPath` with the path firm. Undefined
       *  on routes that don't compose firm-access. */
      firmId?: string;
      /** Set by `resolveFirmFromPath` with the calling user's role
       *  inside the firm (super admins read as `firm_admin`). */
      firmRole?: FirmRole;
    }
  }
}

// Requires `firm_admin`. Use for global-rule authoring and
// firm-management endpoints. Mount AFTER a route-specific resolver
// (`resolveFirmFromPath`) that has set `req.firmId`/`req.firmRole`.
//
// On a `superAdminManaged` firm (the shared appliance firm), firm
// management is reserved for super admins regardless of firmRole.
// Without this, any firm_admin member of the appliance firm could
// manage a firm that spans EVERY tenant on the box — including
// granting themselves tenant access to other tenants' books.
export async function requireFirmAdmin(req: Request, _res: Response, next: NextFunction) {
  if (req.firmRole !== 'firm_admin') {
    throw AppError.forbidden('Firm admin role required', 'NOT_FIRM_ADMIN');
  }
  if (!req.isSuperAdmin && req.firmId) {
    const firm = await firmsService.getById(req.firmId);
    if (firm.superAdminManaged) {
      throw AppError.forbidden(
        'This firm is managed by the system administrator',
        'FIRM_SUPER_ADMIN_MANAGED',
      );
    }
  }
  next();
}

// Firm CONFIGURATION gate: allows any active firm member with a write
// role (`firm_admin` OR `firm_staff`), excluding `firm_readonly`. Use for
// firm-level SETTINGS that staff manage day to day — 1099 e-file read/test,
// tag templates — as opposed to firm ADMINISTRATION (membership, tenant-
// access grants, identity/credentials), which stays on `requireFirmAdmin`.
//
// Deliberately has NO superAdminManaged lockdown: unlike requireFirmAdmin,
// these are settings rather than box-wide administration, so trusted firm
// staff may edit them on the shared appliance firm. Mount AFTER
// resolveFirmFromPath, which sets req.firmRole.
export async function requireFirmStaff(req: Request, _res: Response, next: NextFunction) {
  if (req.firmRole !== 'firm_admin' && req.firmRole !== 'firm_staff') {
    throw AppError.forbidden('Firm staff role required', 'NOT_FIRM_STAFF');
  }
  next();
}

// Resolver for firm-management routes that take the firmId from
// the URL path (`/firms/:firmId/...`). Resolves the user's role
// within the path-specified firm and sets `req.firmId`/`req.firmRole`.
// `getRoleForUser` returns null for a deactivated firm, so members of
// an inactive firm get the same 404 as non-members.
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
