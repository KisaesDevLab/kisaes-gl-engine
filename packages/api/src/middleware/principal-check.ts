// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

// The user checks every way of authenticating shares (security review S3):
// a session, an API key and a download token all stop working when their
// user is turned off, and all wait for a new password while the user must
// change one (U-230, set by a temporary password), except on the few routes
// that let them choose it.

import type { Request } from 'express';
import { AppError } from '../utils/errors.js';

/** Routes a principal that must change its password may still use (U-230). Logout and refresh do not authenticate. */
const MUST_CHANGE_ALLOWED: ReadonlyArray<{ method: string; path: string }> = [
  { method: 'POST', path: '/api/v1/auth/change-password' },
  { method: 'GET', path: '/api/v1/auth/me' },
];

export function mustChangeAllows(req: Request): boolean {
  const path = '/' + (req.originalUrl ?? req.url).split('?')[0]!.toLowerCase().split('/').filter(Boolean).join('/');
  const method = req.method === 'HEAD' ? 'GET' : req.method;
  return MUST_CHANGE_ALLOWED.some((r) => r.method === method && r.path === path);
}

/**
 * 401 when the user is gone or turned off; 403 PASSWORD_CHANGE_REQUIRED
 * while the user must choose a new password (outside MUST_CHANGE_ALLOWED).
 */
export function assertUserUsable(
  req: Request,
  user: { isActive: boolean | null; passwordChangeRequired?: boolean | null } | null | undefined,
): void {
  if (!user || !user.isActive) {
    throw AppError.unauthorized('Account is deactivated');
  }
  if (user.passwordChangeRequired && !mustChangeAllows(req)) {
    throw AppError.forbidden('Choose a new password to continue', 'PASSWORD_CHANGE_REQUIRED');
  }
}
