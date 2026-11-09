// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

/**
 * db.transaction with an opt-in retry of the whole database transaction
 * after a deadlock (40P01) or a serialization failure (40001), U-197.
 *
 * Postgres rolls the whole transaction back on either error, so running the
 * callback again from the start on a fresh transaction is safe as long as
 * everything it does is on `tx` (rows, audit rows, idempotency claim). The
 * helper also undoes the request-scoped state an attempt leaves behind
 * outside the database: the Idempotency-Key claim (re-claimed on the new
 * tx) and the inventory warnings noted for the reply. Callers opt in only
 * where the callback has no other side effect outside the transaction (no
 * files, queues, mail or HTTP before the commit).
 *
 * Used by the write paths that take a reconciliation header lock (U-193)
 * and so can, rarely, deadlock with a multi-entry void (edit, void and
 * delete of an entry; payment and bill payment void, payment edit). Only the outermost
 * db.transaction retries: a callback running inside the caller's own
 * transaction (an `outerTx`, a savepoint) is left to that caller.
 *
 * A lock wait past lock_timeout (55P03) is not retried: waiting again would
 * double the wait. The error of the last attempt is rethrown unchanged, so
 * the existing 409 RETRY mapping (utils/deadlock.ts) still answers it.
 */

import { db, type Tx } from './index.js';
import { log } from '../utils/logger.js';
import { idempotencyFailed, releaseRolledBackClaim } from '../services/idempotency-context.js';
import { inventoryWarningsMark, rollbackInventoryWarnings } from '../services/inventory-warnings-context.js';

/** Postgres error codes after which the whole transaction may simply run again. */
const RETRY_CODES = new Set(['40P01', '40001']);

/** The SQLSTATE of a pg error, or of the pg error Drizzle wrapped as `cause`. */
function sqlState(e: unknown): string | undefined {
  const err = e as { code?: unknown; cause?: { code?: unknown } } | null;
  const code = err?.code ?? err?.cause?.code;
  return typeof code === 'string' ? code : undefined;
}

/** A deadlock (40P01) or serialization failure (40001): the transaction rolled back and may run again. */
export function isTransactionRetryable(e: unknown): boolean {
  const code = sqlState(e);
  return code !== undefined && RETRY_CODES.has(code);
}

export interface TransactionRetryOptions {
  /** Total attempts, first included (default 2: one retry). */
  attempts?: number;
  /** For logs: which write path retried. */
  label?: string;
  /** Test seam: how one attempt opens its transaction (default db.transaction). */
  open?: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;
}

/**
 * Runs `fn` in a database transaction; on a deadlock or serialization
 * failure runs it again, from the start, on a new transaction, up to
 * `attempts` times in all. Anything else is rethrown at once.
 */
export async function transactionWithRetry<T>(
  fn: (tx: Tx) => Promise<T>,
  opts: TransactionRetryOptions = {},
): Promise<T> {
  const attempts = Math.max(1, opts.attempts ?? 2);
  const open = opts.open ?? (<R>(f: (tx: Tx) => Promise<R>) => db.transaction(f));
  for (let attempt = 1; ; attempt++) {
    let attemptTx: Tx | undefined;
    const mark = inventoryWarningsMark();
    try {
      return await open((tx) => {
        attemptTx = tx;
        return fn(tx);
      });
    } catch (err) {
      if (attempt >= attempts || !isTransactionRetryable(err) || idempotencyFailed()) throw err;
      if (attemptTx) releaseRolledBackClaim(attemptTx);
      rollbackInventoryWarnings(mark);
      log.warn({
        component: 'db', event: 'transaction_retry', code: sqlState(err), attempt,
        ...(opts.label ? { label: opts.label } : {}),
      });
    }
  }
}
