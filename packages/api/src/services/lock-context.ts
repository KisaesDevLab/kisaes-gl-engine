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

// Express middleware: carries the caller's identity + the request's
// overrideConfirmed flag into everything the handler awaits.
export function lockContextMiddleware(req: Request, _res: Response, next: NextFunction) {
  storage.run({
    userType: req.userType === 'client' ? 'client' : 'staff',
    overrideConfirmed: (req.body as { overrideConfirmed?: unknown } | undefined)?.overrideConfirmed === true,
    userId: req.userId,
  }, next);
}
