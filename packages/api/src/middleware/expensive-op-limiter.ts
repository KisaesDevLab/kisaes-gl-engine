import rateLimit from 'express-rate-limit';

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
export const expensiveOpLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req as { userId?: string }).userId || req.ip || 'anonymous',
  message: {
    error: {
      message: 'You are generating reports too quickly. Please wait a moment and try again.',
      code: 'EXPENSIVE_OP_RATE_LIMIT',
    },
  },
});
