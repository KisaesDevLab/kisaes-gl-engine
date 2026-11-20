// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

import rateLimit from 'express-rate-limit';
import type { Response } from 'express';
import { getRateLimitStore } from '../utils/rate-limit-store.js';
import { limiterClientKey } from '../desktop/lan-context.js';

// Closing-date password guessing bound (U-15). Every route that accepts a
// `closingPassword` (postings, the closing date), a `currentPassword`
// (PUT /company/closing-password) or an `accountPassword` (the owner reset,
// POST /company/closing-password/reset) is an oracle for one, so failed attempts
// are counted per user: 10 failures in 15 minutes, then 429 until the
// window passes. Requests without a password are not counted at all, and
// successful ones are not either (skipSuccessfulRequests), so ordinary
// posting never trips it. Mount it BEFORE the middleware that removes the
// password from the body (lockContextMiddleware / takeClosingPassword).
export const closingPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  store: getRateLimitStore('closing-password'),
  skipSuccessfulRequests: true,
  // A non-admin refused a closing-date or password change (U-229, 403
  // CLOSING_DATE_ADMIN_ONLY) tried no password, so that is no strike;
  // routes mark it with markClosingDateAdminRefusal.
  requestWasSuccessful: (_req, res) => res.statusCode < 400 || res.locals['closingDateAdminRefused'] === true,
  skip: (req) => {
    const body = req.body as Record<string, unknown> | undefined;
    if (!body || typeof body !== 'object') return true;
    return typeof body['closingPassword'] !== 'string'
      && typeof body['currentPassword'] !== 'string'
      && typeof body['accountPassword'] !== 'string';
  },
  keyGenerator: (req) => {
    const userId = (req as { userId?: string }).userId;
    return userId ? `user:${userId}` : limiterClientKey(req);
  },
  message: {
    error: {
      message: 'Too many closing date password attempts. Try again in 15 minutes.',
      code: 'CLOSING_PASSWORD_RATE_LIMIT',
    },
  },
});

/**
 * Runs `fn`; a 403 CLOSING_DATE_ADMIN_ONLY from it is marked on `res` so
 * closingPasswordLimiter does not count it, then rethrown.
 */
export async function markClosingDateAdminRefusal<T>(res: Response, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if ((err as { code?: unknown } | null)?.code === 'CLOSING_DATE_ADMIN_ONLY') res.locals['closingDateAdminRefused'] = true;
    throw err;
  }
}
