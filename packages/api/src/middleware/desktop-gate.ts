// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * Desktop transport gate (CL_MODE=desktop only). Mounted as the very first
 * middleware in app.ts, before helmet, CORS, the raw-body webhook routers
 * and every route, so nothing in the engine runs for a request that fails
 * it. There are NO exemptions: /health, /ping and OPTIONS need the token
 * too (the desktop supervisor always has it).
 *
 * Checks, in order:
 *   1. any `Origin` header            → 403 ORIGIN_NOT_ALLOWED
 *      (the engine has no browser clients; blocks CSRF and DNS rebinding)
 *   2. `Host` is not the bound address → 421 HOST_NOT_ALLOWED
 *   3. `X-CL-Token` missing or wrong   → 401 DESKTOP_TOKEN_REQUIRED
 *      (same body for both cases; constant-time compare of SHA-256 digests)
 *
 * The launch token is transport trust only ("this is the desktop app").
 * User identity still comes from the JWT in `Authorization: Bearer`, so
 * per-route auth and roles are unchanged.
 */

import type { NextFunction, Request, Response } from 'express';
import { verifyDesktopToken } from '../desktop/profile.js';

declare global {
  namespace Express {
    interface Request {
      /** Set by the desktop gate after the launch token checked out. */
      desktopTrusted?: boolean;
    }
  }
}

export const DESKTOP_TOKEN_HEADER = 'x-cl-token';

let bound: { host: string; port: number } | null = null;

/** index.ts calls this once the server is listening (port 0 resolved). */
export function setDesktopBoundAddress(host: string, port: number): void {
  bound = { host: host.toLowerCase(), port };
}

/** Test hook. */
export function _resetDesktopBoundAddressForTests(): void {
  bound = null;
}

function isUnspecified(host: string): boolean {
  return host === '0.0.0.0' || host === '::';
}

/** Whether a Host header names the address the engine is bound to. */
export function hostAllowed(hostHeader: string | undefined): boolean {
  if (!bound || !hostHeader) return false;
  const h = hostHeader.trim().toLowerCase();
  const port = String(bound.port);
  if (isUnspecified(bound.host)) {
    // CL_LAN=1 bound to all interfaces: clients may use any name or
    // address of this machine, so only the port is checked. Origin
    // rejection and the token still apply.
    return h.endsWith(`:${port}`);
  }
  const literal = bound.host.includes(':') ? `[${bound.host}]` : bound.host;
  return h === `${literal}:${port}` || h === `localhost:${port}`;
}

function deny(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: { message, code } });
}

export function desktopGate() {
  return function clDesktopGate(req: Request, res: Response, next: NextFunction): void {
    if (req.headers.origin !== undefined) {
      deny(res, 403, 'ORIGIN_NOT_ALLOWED', 'Browser requests are not accepted by the desktop engine.');
      return;
    }
    if (!hostAllowed(req.headers.host)) {
      deny(res, 421, 'HOST_NOT_ALLOWED', 'Unexpected Host header.');
      return;
    }
    if (!verifyDesktopToken(req.headers[DESKTOP_TOKEN_HEADER])) {
      deny(res, 401, 'DESKTOP_TOKEN_REQUIRED', 'Missing or invalid X-CL-Token.');
      return;
    }
    req.desktopTrusted = true;
    next();
  };
}
