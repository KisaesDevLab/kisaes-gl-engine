// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Request-scoped actor context for the closed-period rule (TB module
// ADR-TB-04). checkLockDate sits at the bottom of ~20 posting services;
// threading { userType, overrideConfirmed } through every signature
// would smear a transport concern across the domain layer. Instead the
// transactions router runs its handlers inside this AsyncLocalStorage
// and the choke point reads it. Paths that never enter the store
// (importers, schedulers, api-v2, MCP) present no actor → hard 423,
// which is exactly the "jobs fail items gracefully, never bypass"
// behavior 10.6 requires.

import { AsyncLocalStorage } from 'node:async_hooks';
import type { Request, Response, NextFunction } from 'express';
import type { LockDateContext } from './ledger.service.js';

const storage = new AsyncLocalStorage<LockDateContext>();

export function getLockContext(): LockDateContext | undefined {
  return storage.getStore();
}

/**
 * Takes `closingPassword` (U-15) out of a JSON body: returns it when it is a
 * string and deletes the key either way, so the password never reaches a
 * schema, a service input, an audit row or a log. Anything that is not a
 * non-empty string counts as absent.
 */
export function takeClosingPassword(req: Request): string | undefined {
  const body = req.body as Record<string, unknown> | undefined;
  if (!body || typeof body !== 'object' || !('closingPassword' in body)) return undefined;
  const value = body['closingPassword'];
  delete body['closingPassword'];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

// Express middleware: carries the caller's identity, the request's
// overrideConfirmed flag and its closing-date password into everything the
// handler awaits.
export function lockContextMiddleware(req: Request, _res: Response, next: NextFunction) {
  const closingPassword = takeClosingPassword(req);
  storage.run({
    userType: req.userType === 'client' ? 'client' : 'staff',
    overrideConfirmed: (req.body as { overrideConfirmed?: unknown } | undefined)?.overrideConfirmed === true,
    userId: req.userId,
    ...(closingPassword !== undefined ? { closingPassword } : {}),
  }, next);
}
