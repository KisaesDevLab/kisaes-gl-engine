// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import type { Request, Response, NextFunction } from 'express';
import { isIpAllowed } from '../services/staff-ip-allowlist.service.js';

// CLOUDFLARE_TUNNEL_PLAN Phase 6 — enforce the configured CIDR list on
// staff routes. Off unless STAFF_IP_ALLOWLIST_ENFORCED=1.
//
// Mounted AFTER the webhook routers (stripe, plaid) in app.ts so
// external machine-to-machine traffic bypasses this check by route
// order. Also placed BEFORE authenticate() so an unauthorised IP gets
// a uniform 403 whether the caller has a valid session or not —
// otherwise the service would leak "that IP would be valid if you
// also had a session" via timing.
//
// Super-admin break-glass:
//   When the request presents a valid access token whose `isSuperAdmin`
//   flag is true, the check is skipped. The JWT middleware runs later
//   in the chain, so we inspect the token here without the full decode
//   pipeline — a lightweight, same-library verify keeps the break-glass
//   path working during a lockout without loading every service.

import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';

function extractSuperAdminFromAuthHeader(header: string | undefined): boolean {
  if (!header || !header.startsWith('Bearer ')) return false;
  const token = header.slice(7);
  try {
    // Pin HS256 to match every other jwt.verify site in the app.
    // jsonwebtoken@9 already rejects `alg: none`, but leaving the
    // algorithms array implicit means a future library-upgrade
    // default change (or an accidental asymmetric-key confusion)
    // could weaken this specific bypass path.
    const payload = jwt.verify(token, env.JWT_SECRET, { algorithms: ['HS256'] }) as { isSuperAdmin?: boolean };
    return !!payload.isSuperAdmin;
  } catch {
    return false;
  }
}

export function staffIpAllowlist() {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (process.env['STAFF_IP_ALLOWLIST_ENFORCED'] !== '1') {
      next();
      return;
    }

    // Break-glass: super-admin sessions are never blocked so an
    // operator locked out of their own office can recover via their
    // Kisaes-managed super-admin account. The bypass is deliberate
    // and documented in CLOUDFLARE_TUNNEL_PLAN Phase 6.
    if (extractSuperAdminFromAuthHeader(req.headers.authorization)) {
      next();
      return;
    }

    const allowed = await isIpAllowed(req.ip);
    if (allowed) {
      next();
      return;
    }

    console.warn(`[Staff IP Allowlist] Denied ${req.method} ${req.originalUrl} from ${req.ip}`);
    res.status(403).json({
      error: {
        message: 'Your IP address is not on the staff allowlist.',
        code: 'STAFF_IP_BLOCKED',
      },
    });
  };
}
