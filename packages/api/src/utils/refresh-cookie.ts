// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

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
function resolvedCookiePath(): string {
  const prefix = env.COOKIE_PATH === '/' ? '' : env.COOKIE_PATH;
  return `${prefix}${COOKIE_SUB_PATH}`;
}

export function setRefreshCookie(res: Response, refreshToken: string): void {
  const parts = [
    `${REFRESH_COOKIE_NAME}=${refreshToken}`,
    'HttpOnly',
    'SameSite=Lax',
    `Path=${resolvedCookiePath()}`,
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
    `Path=${resolvedCookiePath()}`,
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

