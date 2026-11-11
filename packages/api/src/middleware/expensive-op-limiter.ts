// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

import rateLimit from 'express-rate-limit';
import { getRateLimitStore } from '../utils/rate-limit-store.js';
import { isDesktop } from '../desktop/profile.js';

/** Server / MyBooks Online: 30 report or export requests per user per minute. */
export const EXPENSIVE_OP_MAX_SERVER = 30;
/**
 * Desktop profile (CL_MODE=desktop): a local sidecar for one owner, where
 * drilling through a report fires a burst of report reads (ClientLedger P28;
 * 30/min gave 429s). Still bounded per user, since LAN mode has several.
 */
export const EXPENSIVE_OP_MAX_DESKTOP = 600;

/** The per-user limit for this process, read per request (the profile can load after this module). */
export function expensiveOpMax(): number {
  return isDesktop() ? EXPENSIVE_OP_MAX_DESKTOP : EXPENSIVE_OP_MAX_SERVER;
}

// Shared per-user limiter for endpoints that do meaningful work on each call:
// report generation hits big aggregate queries, PDF export spins up Puppeteer
// (which is expensive to cold-start and holds a chromium process), CSV
// exports materialize entire result sets into memory. Without this the only
// cap is the 200/min/IP global limiter, which one authenticated user can
// exhaust to deny service to the rest of their tenant.
//
// 30/min/user leaves plenty of headroom for interactive use (clicking through
// reports, re-running with different filters) while keeping a hostile caller
// bounded to something the DB and Puppeteer pool can handle without OOM.
// The desktop profile raises it to 600/min (expensiveOpMax above).
export const expensiveOpLimiter = rateLimit({
  store: getRateLimitStore('expensive-op-limiter:expensiveOp'),
  windowMs: 60 * 1000,
  max: () => expensiveOpMax(),
  standardHeaders: true,
  legacyHeaders: false,
  // Route tests mount the whole reports router and fire dozens of report
  // requests from one user inside a single sub-5s window; the limiter would
  // 429 the tail and surface as spurious "No data" exports. No test exercises
  // the limit itself, so bypass it under NODE_ENV=test. Production/dev unaffected.
  skip: () => process.env['NODE_ENV'] === 'test',
  keyGenerator: (req) => (req as { userId?: string }).userId || req.ip || 'anonymous',
  message: {
    error: {
      message: 'You are generating reports too quickly. Please wait a moment and try again.',
      code: 'EXPENSIVE_OP_RATE_LIMIT',
    },
  },
});
