// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import type { Response } from 'express';
import { env } from '../config/env.js';

/**
 * Resolve whether to set the Secure attribute on a cookie.
 *
 * Explicit `COOKIE_SECURE` env wins:
 * - `COOKIE_SECURE=true` (or `1`) — force Secure on regardless of
 *   NODE_ENV. Used in multi-app mode where the front door is always
 *   HTTPS even when NODE_ENV=development on the host.
 * - `COOKIE_SECURE=false` (or `0`) — force Secure off regardless of
 *   NODE_ENV. Used by the appliance's emergency-access proxy at
 *   http://<lan-ip>:5171, where `NODE_ENV=production` would otherwise
 *   set the Secure flag and the browser would silently drop the
 *   cookie on the next plain-HTTP request — login appears to succeed
 *   but the next request comes in unauthenticated.
 *
 * Unset (the default): `secure: 'auto'` semantics keyed on
 * `NODE_ENV === 'production'`. Single-app standalone preserves its
 * original behavior — Secure on in production, off in development —
 * so existing customers see no change.
 *
 * vibe-mybooks-compatibility-addendum §3.14.4.
 */
export function resolvedSecure(): boolean {
  if (env.COOKIE_SECURE !== undefined) return env.COOKIE_SECURE;
  return env.NODE_ENV === 'production';
}

/**
 * Append a Set-Cookie header without clobbering existing ones.
 *
 * `res.setHeader('Set-Cookie', ...)` *replaces* the header — so a
 * route that writes one session cookie and then writes a refresh
 * cookie via direct `setHeader` ends up with only the refresh cookie
 * landing at the browser. Use this helper instead.
 *
 * Express also exposes `res.cookie()` which appends correctly, but it
 * serializes the cookie via the `cookie` package's quoting rules —
 * pre-formatted Set-Cookie strings (with our specific Path / SameSite
 * / Max-Age / Secure / HttpOnly attribute layout) are easier to read
 * and easier to test against by string match. So we keep the
 * pre-formatted strings and just merge them safely here.
 */
export function appendSetCookie(res: Response, cookie: string): void {
  const existing = res.getHeader('Set-Cookie');
  if (!existing) {
    res.setHeader('Set-Cookie', cookie);
  } else if (Array.isArray(existing)) {
    res.setHeader('Set-Cookie', [...existing, cookie]);
  } else {
    res.setHeader('Set-Cookie', [String(existing), cookie]);
  }
}
