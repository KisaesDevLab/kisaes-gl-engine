// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import type { Request, Response, NextFunction } from 'express';
import {
  can,
  type PermissionAction,
  type ResourceKey,
  type EffectivePermissions,
} from '@kis-books/shared';
import { AppError } from '../utils/errors.js';
import * as permissionService from '../services/permission.service.js';

// Per-request permission enforcement. Mirrors the shape of
// requirePracticeAccess: a small factory returning an async guard that
// throws AppError (caught by express-async-errors). Mount AFTER
// `authenticate` (and `companyContext` for company-scoped routers) so
// req.userRole / req.userType / req.tenantId are populated.
//
// The effective map is resolved at most once per request and memoized
// on a WeakMap keyed by the request object, so stacking guards or
// re-checking in a handler costs a single DB read.

const perRequestCache = new WeakMap<Request, Promise<EffectivePermissions>>();

export function resolvePermissionsForRequest(req: Request): Promise<EffectivePermissions> {
  let cached = perRequestCache.get(req);
  if (!cached) {
    cached = permissionService.getEffectivePermissions(
      req.tenantId,
      req.userId,
      req.userRole,
      req.userType,
      !!req.isSuperAdmin,
    );
    perRequestCache.set(req, cached);
  }
  return cached;
}

// Idempotent read verbs → 'read'; everything else is treated as a
// mutation requiring 'full'. OPTIONS is a read so CORS preflight is
// never blocked.
function actionForMethod(method: string): PermissionAction {
  return method === 'GET' || method === 'HEAD' || method === 'OPTIONS' ? 'read' : 'update';
}

// Router-level guard: infers read/write from the HTTP method. This one
// line per domain router subsumes the scattered `req.userRole ===
// 'readonly'` checks.
export function requireResource(resource: ResourceKey) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const perms = await resolvePermissionsForRequest(req);
    if (!can(perms, resource, actionForMethod(req.method))) {
      throw AppError.forbidden('You do not have permission for this feature', 'PERMISSION_DENIED');
    }
    next();
  };
}

// Finer guard when a single route needs a specific action regardless of
// method (e.g. a POST that is semantically a read, or gating delete
// separately from update).
export function requirePermission(resource: ResourceKey, action: PermissionAction) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const perms = await resolvePermissionsForRequest(req);
    if (!can(perms, resource, action)) {
      throw AppError.forbidden('You do not have permission for this feature', 'PERMISSION_DENIED');
    }
    next();
  };
}
