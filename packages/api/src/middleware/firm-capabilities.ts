// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import type { Request, Response, NextFunction } from 'express';
import type { EffectiveFirmCapabilities, FirmCapabilityKey } from '@kis-books/shared';
import { AppError } from '../utils/errors.js';
import { assertAdminSessionFresh } from './auth.js';
import * as firmCapabilitiesService from '../services/firm-capabilities.service.js';
import type { AdminScope } from '../services/firm-capabilities.service.js';

// Firm member access rights — request guards.
//
// Three gates, mirroring the shape of middleware/permission.ts (small
// factories returning async guards that throw AppError; the effective
// map is resolved at most once per request and memoized on a WeakMap).
//
//   requireTenantCapability(cap)  owner-parity gate for tenant settings
//   requireAdminPrincipal         router-level "may enter /admin at all"
//   requireAdminCapability(cap)   route-level delegated-admin gate + scope
//
// Capability elevation is SESSION-ONLY and STAFF-ONLY: API keys and
// download tokens (authKind !== 'session') and client users never inherit
// a firm member's rights. Owners and super admins pass on their own.

declare global {
  namespace Express {
    interface Request {
      /** True when an /admin/* request is being served for a delegated
       *  firm member rather than a super admin. */
      adminDelegated?: boolean;
      /** Set by requireAdminCapability for delegated callers: the firms
       *  and tenants the capability authorizes. Undefined for super
       *  admins, whose view is unfiltered. */
      adminScope?: AdminScope;
    }
  }
}

const tenantCapCache = new WeakMap<Request, Promise<EffectiveFirmCapabilities>>();
const adminCapCache = new WeakMap<Request, Promise<EffectiveFirmCapabilities>>();
const adminScopeCache = new WeakMap<Request, Map<FirmCapabilityKey, Promise<AdminScope>>>();

function isElevatablePrincipal(req: Request): boolean {
  return req.userType !== 'client' && (req.authKind === undefined || req.authKind === 'session');
}

export function resolveTenantCapabilitiesForRequest(req: Request): Promise<EffectiveFirmCapabilities> {
  let cached = tenantCapCache.get(req);
  if (!cached) {
    cached = firmCapabilitiesService.getTenantCapabilitiesForUser(req.userId, req.tenantId);
    tenantCapCache.set(req, cached);
  }
  return cached;
}

export function resolveAdminCapabilitiesForRequest(req: Request): Promise<EffectiveFirmCapabilities> {
  let cached = adminCapCache.get(req);
  if (!cached) {
    cached = firmCapabilitiesService.getAdminCapabilitiesForUser(req.userId);
    adminCapCache.set(req, cached);
  }
  return cached;
}

export function resolveAdminScopeForRequest(req: Request, cap: FirmCapabilityKey): Promise<AdminScope> {
  let perCap = adminScopeCache.get(req);
  if (!perCap) {
    perCap = new Map();
    adminScopeCache.set(req, perCap);
  }
  let cached = perCap.get(cap);
  if (!cached) {
    cached = firmCapabilitiesService.getAdminScope(req.userId, cap);
    perCap.set(cap, cached);
  }
  return cached;
}

// Boolean form of the owner-parity rule, for handlers that need to branch
// rather than gate (e.g. check-signature visibility).
export async function hasTenantOwnerPower(req: Request, cap: FirmCapabilityKey): Promise<boolean> {
  if (req.userRole === 'owner' || req.isSuperAdmin) return true;
  if (!isElevatablePrincipal(req)) return false;
  const caps = await resolveTenantCapabilitiesForRequest(req);
  return caps[cap] === true;
}

// Owner-parity gate. Replaces the inline
//   if (req.userRole !== 'owner' && !req.isSuperAdmin) throw forbidden
// checks: passes for the tenant owner, a super admin, or a firm member
// whose effective capabilities on req.tenantId include `cap`.
export function requireTenantCapability(
  cap: FirmCapabilityKey,
  message = 'Owner role required',
  code = 'OWNER_REQUIRED',
) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    if (await hasTenantOwnerPower(req, cap)) return next();
    throw AppError.forbidden(message, code);
  };
}

// Uniform refusal so a probing caller can't tell "not delegable" from
// "not an admin at all".
const SUPER_ADMIN_REQUIRED = 'Super admin access required';

// Router-level gate for the admin router: super admin, OR a staff session
// holding at least one admin-scoped capability. Both are subject to the
// same idle + absolute admin session bounds (ADMIN_SESSION_EXPIRED).
export async function requireAdminPrincipal(req: Request, _res: Response, next: NextFunction) {
  if (req.isSuperAdmin) {
    assertAdminSessionFresh(req);
    return next();
  }
  if (!isElevatablePrincipal(req) || req.authKind !== 'session') {
    throw AppError.forbidden(SUPER_ADMIN_REQUIRED);
  }
  const caps = await resolveAdminCapabilitiesForRequest(req);
  if (!firmCapabilitiesService.hasAnyAdminCapability(caps)) {
    throw AppError.forbidden(SUPER_ADMIN_REQUIRED);
  }
  assertAdminSessionFresh(req);
  req.adminDelegated = true;
  next();
}

export type AdminCapabilityGuard = ((req: Request, res: Response, next: NextFunction) => Promise<void>) & {
  /** Marker consumed by the delegation-manifest test. */
  adminCapability: FirmCapabilityKey;
};

// Route-level gate for a delegable admin route. Super admins pass with no
// scope (unfiltered). Delegated callers need `cap` in at least one firm and
// receive req.adminScope for the handler / service to filter by.
export function requireAdminCapability(cap: FirmCapabilityKey): AdminCapabilityGuard {
  const guard = async (req: Request, _res: Response, next: NextFunction) => {
    if (req.isSuperAdmin) return next();
    if (!req.adminDelegated) throw AppError.forbidden(SUPER_ADMIN_REQUIRED);
    const scope = await resolveAdminScopeForRequest(req, cap);
    if (scope.firmIds.length === 0) {
      throw AppError.forbidden(SUPER_ADMIN_REQUIRED, 'ADMIN_CAPABILITY_REQUIRED');
    }
    req.adminScope = scope;
    next();
  };
  return Object.assign(guard, { adminCapability: cap });
}
