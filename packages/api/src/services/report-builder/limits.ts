// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

/**
 * Report Builder run limits (U-119, Q-311, Q-A07l, Q-A07p).
 *
 * A run is one READ ONLY, REPEATABLE READ transaction (one snapshot for
 * every statement, earnings and open items included) with a 30 s deadline:
 * before every statement the executor wrapper sets statement_timeout to the
 * time left. A statement cancelled by the timeout is 503 REPORT_TIMEOUT. If
 * the client goes away (`signal`), the backend's query is cancelled with
 * pg_cancel_backend from another connection.
 */

import { sql, type SQL } from 'drizzle-orm';
import { db, type Tx } from '../../db/index.js';
import { AppError } from '../../utils/errors.js';

export const RUN_DEADLINE_MS = 30_000;
/** Group-by and line rows a run may return (Q-A07p). */
export const MAX_LINE_ROWS = 100_000;
/** Detail rows per run on screen, and for an export (A09). */
export const MAX_DETAIL_ROWS_SCREEN = 5_000;
export const MAX_DETAIL_ROWS_EXPORT = 100_000;
/** Detail rows per /run/detail page. */
export const DETAIL_PAGE_ROWS = 500;

export function timeoutError(): AppError {
  return new AppError(503, 'This report took too long. Try fewer months or add a filter.', 'REPORT_TIMEOUT');
}

export function tooLargeError(): AppError {
  return new AppError(422, 'This report has too many rows. Add a filter or fewer group-bys.', 'REPORT_TOO_LARGE', { limit: MAX_LINE_ROWS });
}

function pgCode(err: unknown): string | undefined {
  let e: unknown = err;
  for (let i = 0; i < 4 && e && typeof e === 'object'; i++) {
    const c = (e as { code?: unknown }).code;
    if (typeof c === 'string' && /^[0-9A-Z]{5}$/.test(c)) return c;
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
}

/** The executor every run statement goes through: statement_timeout = the time left. */
export interface RunExec {
  execute: (q: SQL) => Promise<{ rows: unknown[] }>;
  /** Milliseconds left before the deadline. */
  left: () => number;
  /** The snapshot transaction with the same per-statement timeout, for helpers that take a DbOrTx. */
  tx: Tx;
}

/**
 * Runs `body` in one READ ONLY REPEATABLE READ transaction with the run's
 * deadline. 503 REPORT_TIMEOUT when the deadline passes or a statement is
 * cancelled; a client abort cancels the backend and rejects.
 */
export async function inSnapshot<T>(body: (exec: RunExec, tx: Tx) => Promise<T>, opts: { signal?: AbortSignal; deadlineMs?: number } = {}): Promise<T> {
  const deadline = Date.now() + (opts.deadlineMs ?? RUN_DEADLINE_MS);
  let pid: number | null = null;
  let aborted = false;
  const onAbort = () => {
    aborted = true;
    if (pid !== null) void db.execute(sql`SELECT pg_cancel_backend(${pid})`).catch(() => undefined);
  };
  opts.signal?.addEventListener('abort', onAbort);
  try {
    return await db.transaction(async (tx) => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
      const r = await tx.execute(sql`SELECT pg_backend_pid() AS pid`);
      pid = Number((r.rows[0] as { pid: number }).pid);
      if (opts.signal?.aborted) onAbort();
      const execute = async (q: SQL) => {
        if (aborted) throw new AppError(499, 'The request was cancelled.', 'REQUEST_CANCELLED');
        const ms = Math.floor(deadline - Date.now());
        if (ms <= 0) throw timeoutError();
        await tx.execute(sql`SELECT set_config('statement_timeout', ${String(ms)}, true)`);
        return tx.execute(q) as Promise<{ rows: unknown[] }>;
      };
      // Helpers that take a DbOrTx (open items, lineSums) get the same timeout per statement.
      const wrapped = new Proxy(tx, {
        get: (t, prop, recv) => (prop === 'execute' ? execute : Reflect.get(t, prop, recv)),
      }) as Tx;
      const exec: RunExec = { left: () => deadline - Date.now(), execute, tx: wrapped };
      return body(exec, tx);
    });
  } catch (err) {
    if (aborted) throw new AppError(499, 'The request was cancelled.', 'REQUEST_CANCELLED');
    // 57014 query_canceled (statement_timeout or pg_cancel_backend).
    if (pgCode(err) === '57014') throw timeoutError();
    throw err;
  } finally {
    opts.signal?.removeEventListener('abort', onAbort);
  }
}
