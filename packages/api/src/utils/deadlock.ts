// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * A deadlock (Postgres 40P01) as 409 RETRY (U-146 S1), as billable costs
 * map it (billable-costs.service.ts): the transaction is already rolled
 * back and nothing was stored, so the client resends under the same
 * Idempotency-Key. Mounted last on the receivables routers (payments,
 * credit memos, customer refunds, finance charges), where two requests
 * lock the same invoices, counter and account rows.
 */

import type { ErrorRequestHandler } from 'express';
import { AppError } from './errors.js';

export function isDeadlock(e: unknown): boolean {
  const err = e as { code?: string; cause?: { code?: string } } | null;
  return (err?.code ?? err?.cause?.code) === '40P01';
}

export function retryError(): AppError {
  return AppError.conflict('Someone else was changing the same records at the same moment. Nothing was saved; try again.', 'RETRY');
}

/** Router-level error handler: a deadlock becomes 409 RETRY; anything else passes on. */
export const deadlockAsRetry: ErrorRequestHandler = (err, _req, _res, next) => {
  next(isDeadlock(err) ? retryError() : err);
};
