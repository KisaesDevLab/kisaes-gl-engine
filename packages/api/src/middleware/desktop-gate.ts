// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

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
 * LAN mode (CL_LAN=1, U-289): a request carrying CL_LAN_TOKEN instead of
 * CL_TOKEN is a workstation request, forwarded by the desktop app's host
 * proxy. Then also:
 *   4. `X-Forwarded-For` (one IP) or `X-CL-Device` (64 hex) bad → 400 LAN_HEADERS_INVALID
 *   5. the route is not `x-lan: workstation` (desktop/route-classes.ts) → 403 HOST_ONLY
 * and `req.ip` becomes the workstation's address, `req.lanDevice` its device.
 *
 * Paths: `encodeURI`-style tricks cannot widen access: a path the
 * classifier does not recognise is host-only (default deny).
 *
 * The launch token is transport trust only ("this is the desktop app").
 * User identity still comes from the JWT in `Authorization: Bearer`, so
 * per-route auth and roles are unchanged.
 */

import type { NextFunction, Request, Response } from 'express';
import { desktopProfile, matchDesktopToken } from '../desktop/profile.js';
import { lanClassOf } from '../desktop/route-classes.js';
import { LAN_DEVICE_HEADER, parseLanDevice, parseLanPeer, runWithLanContext } from '../desktop/lan-context.js';

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
    // Bound to all interfaces: clients may use any name or address of
    // this machine, so only the port is checked. Origin rejection and the
    // token still apply. Unreachable: the profile refuses every non-loopback
    // bind, also with CL_LAN=1 (the desktop app's proxy faces the LAN).
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
    const tokenClass = matchDesktopToken(req.headers[DESKTOP_TOKEN_HEADER]);
    if (tokenClass === null) {
      deny(res, 401, 'DESKTOP_TOKEN_REQUIRED', 'Missing or invalid X-CL-Token.');
      return;
    }
    req.desktopTrusted = true;
    if (tokenClass === 'host') {
      if (desktopProfile().lan) req.lanClass = 'host';
      next();
      return;
    }

    // Workstation (CL_LAN=1, U-289): the class comes from the token that
    // matched, never from a header. The host proxy sets exactly one
    // X-Forwarded-For hop and the device fingerprint on every request.
    const peerIp = parseLanPeer(req.headers['x-forwarded-for']);
    const device = parseLanDevice(req.headers[LAN_DEVICE_HEADER]);
    if (!peerIp || !device) {
      deny(res, 400, 'LAN_HEADERS_INVALID', 'Missing or invalid X-Forwarded-For or X-CL-Device.');
      return;
    }
    req.lanClass = 'workstation';
    req.lanDevice = device;
    // Limiters, logs and audit rows see the workstation, not the proxy.
    Object.defineProperty(req, 'ip', { value: peerIp, configurable: true, enumerable: true, writable: false });
    // Default deny: only routes classified x-lan: workstation.
    if (lanClassOf(req.method, req.path) !== 'workstation') {
      deny(res, 403, 'HOST_ONLY', 'Do this on the host computer.');
      return;
    }
    runWithLanContext({ device, peerIp }, next);
  };
}
