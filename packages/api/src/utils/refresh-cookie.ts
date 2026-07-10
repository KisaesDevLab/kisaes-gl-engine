// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import type { Request, Response } from 'express';
import { env } from '../config/env.js';
import { resolvedSecure, appendSetCookie } from './cookie-secure.js';

// Refresh tokens live in an HttpOnly cookie scoped to /api/v1/auth so they
// are not exposed to any page script, cannot be exfiltrated via XSS, and
// only ride along on auth-route requests. SameSite=Lax still blocks the
// classic CSRF vector (POSTs from attacker origins don't carry the cookie)
// while allowing the cookie to ride top-level navigations — this matters
// when a user clicks a magic link or an invoice-share link from Gmail /
// Outlook and lands on our origin: the first navigation must be able to
// pick up an existing session or complete the auth flow. Path scoping
// keeps the cookie off every request that isn't /api/v1/auth/*.
//
// vibe-distribution-plan §multi-app cookie isolation: in multi-app mode
// (Caddy ingress at https://<host>/mybooks/) the operator sets
// COOKIE_PATH=/mybooks so the cookie is scoped under the app's prefix
// — otherwise the browser would also send it to /connect/, /tb/, etc.
// Single-app mode keeps COOKIE_PATH='/' (the env-default) and the
// resolved Path is just /api/v1/auth, unchanged from before.

const REFRESH_COOKIE_NAME = 'kb_refresh';
const COOKIE_SUB_PATH = '/api/v1/auth';
const SEVEN_DAYS_SECONDS = 7 * 24 * 60 * 60;

// Resolve the final Path value once. env.COOKIE_PATH is normalized to
// '/' or '/<prefix>' (no trailing slash), so concatenation with the
// fixed sub-path always produces a single leading slash.
//
// Hardening: when COOKIE_PATH is left at the '/' default, derive the prefix
// from PUBLIC_URL's path instead. In a sub-pathed deployment (e.g.
// https://host/mybooks) the browser POSTs /auth/refresh to
// /mybooks/api/v1/auth/refresh, so the cookie Path MUST include /mybooks to
// be sent back. Previously COOKIE_PATH had to be set by hand to match the
// web's VITE_BASE_PATH; a mismatch dropped the refresh cookie and logged
// users out every ~15 minutes. Deriving from PUBLIC_URL removes that footgun
// while an explicit COOKIE_PATH still wins when an operator needs to override.
// The web sends its mount prefix (import.meta.env.BASE_URL) as `X-App-Base` on
// auth requests. On an appliance that strips the prefix before the API sees the
// request, this header is the ONLY reliable signal of the sub-path — so the
// refresh cookie's Path is correct with ZERO operator config. The value flows
// into a Set-Cookie Path, so validate it strictly (reject anything that could
// inject cookie attributes via ';', CR/LF, or odd characters).
function headerPrefix(req?: Request): string | null {
  const raw = req?.headers?.['x-app-base'];
  const val = Array.isArray(raw) ? raw[0] : raw;
  if (val === undefined) return null;
  if (val === '' || val === '/') return ''; // genuine root mount
  if (val.length > 128 || !/^\/[A-Za-z0-9_\-./]*$/.test(val)) return null; // invalid → ignore
  return val.replace(/\/+$/, '');
}

// Precedence: explicit COOKIE_PATH override > web-supplied X-App-Base (zero
// config) > PUBLIC_URL path > root.
function resolvedCookiePath(req?: Request): string {
  let prefix = env.COOKIE_PATH === '/' ? '' : env.COOKIE_PATH;
  if (!prefix) {
    const hp = headerPrefix(req);
    if (hp !== null) {
      prefix = hp; // web base wins; '' means genuine root
    } else {
      try {
        const fromPublicUrl = new URL(env.PUBLIC_URL).pathname.replace(/\/+$/, '');
        if (fromPublicUrl && fromPublicUrl !== '/') prefix = fromPublicUrl;
      } catch {
        // PUBLIC_URL is URL-validated in config/env.ts; this catch is defensive.
      }
    }
  }
  return `${prefix}${COOKIE_SUB_PATH}`;
}

export function setRefreshCookie(res: Response, refreshToken: string): void {
  const parts = [
    `${REFRESH_COOKIE_NAME}=${refreshToken}`,
    'HttpOnly',
    'SameSite=Lax',
    `Path=${resolvedCookiePath(res.req)}`,
    `Max-Age=${SEVEN_DAYS_SECONDS}`,
  ];
  if (resolvedSecure()) parts.push('Secure');
  appendSetCookie(res, parts.join('; '));
}

export function clearRefreshCookie(res: Response): void {
  const parts = [
    `${REFRESH_COOKIE_NAME}=`,
    'HttpOnly',
    'SameSite=Lax',
    `Path=${resolvedCookiePath(res.req)}`,
    'Max-Age=0',
  ];
  if (resolvedSecure()) parts.push('Secure');
  appendSetCookie(res, parts.join('; '));
}

export function readRefreshCookie(req: Request): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  // Parse cookies manually — we only need one name and don't want to pull in
  // another dependency. Cookie name is fixed and the value is hex.
  for (const pair of header.split(';')) {
    const idx = pair.indexOf('=');
    if (idx < 0) continue;
    const name = pair.slice(0, idx).trim();
    if (name !== REFRESH_COOKIE_NAME) continue;
    const value = pair.slice(idx + 1).trim();
    return value || undefined;
  }
  return undefined;
}

