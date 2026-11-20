// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

/**
 * Request-scoped expected record stamp (U-291, stale-all-v1).
 *
 * A stale-checked route takes `expectedUpdatedAt` (the record's updatedAt as
 * the caller read it): in the JSON body, or in the query for a DELETE. The
 * `expectStamp()` middleware takes it out of the request and runs the
 * handler with it, keyed by table and record id. The first service code that
 * locks that record (FOR UPDATE) consumes it and compares (409 STALE): once,
 * so a later lock of the same record in the same request (after this
 * request's own write moved its stamp) does not compare again.
 *
 * Absent: no check, as before (U-292 makes it required in LAN mode).
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { NextFunction, Request, Response } from 'express';
import { sql, type AnyColumn, type SQL } from 'drizzle-orm';
import { AppError } from '../utils/errors.js';
import { assertNotStale } from '../utils/record-stamps.js';

interface ExpectedStamp {
  table: string;
  id: string;
  expected: string;
  consumed: boolean;
}

const storage = new AsyncLocalStorage<ExpectedStamp[]>();

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;

/** Takes `expectedUpdatedAt` out of the body (or, for DELETE, the query). 400 when malformed. */
export function takeExpectedUpdatedAt(req: Request): string | undefined {
  const body = req.body as Record<string, unknown> | undefined;
  let raw: unknown;
  if (body && typeof body === 'object' && 'expectedUpdatedAt' in body) {
    raw = body['expectedUpdatedAt'];
    delete body['expectedUpdatedAt'];
  } else if (typeof req.query['expectedUpdatedAt'] === 'string') {
    raw = req.query['expectedUpdatedAt'];
  }
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string' || !ISO.test(raw) || Number.isNaN(Date.parse(raw))) {
    throw AppError.badRequest('expectedUpdatedAt must be the record\'s updatedAt as an ISO 8601 date-time', 'VALIDATION_ERROR');
  }
  return raw;
}

/**
 * Middleware for a stale-checked route on `table` whose record id is the
 * path parameter `param`. Leaves the request unchanged when no stamp came.
 */
export function expectStamp(table: string, param = 'id') {
  return function clExpectStamp(req: Request, _res: Response, next: NextFunction): void {
    const expected = takeExpectedUpdatedAt(req);
    const id = req.params[param];
    if (expected === undefined || !id) {
      next();
      return;
    }
    const list = [...(storage.getStore() ?? []), { table, id, expected, consumed: false }];
    storage.run(list, next);
  };
}

/** Runs `fn` with an expected stamp (service callers and tests). */
export function runWithExpectedStamp<T>(table: string, id: string, expected: string | undefined, fn: () => Promise<T>): Promise<T> {
  if (expected === undefined) return fn();
  return storage.run([...(storage.getStore() ?? []), { table, id, expected, consumed: false }], fn);
}

/**
 * Compares the request's expected stamp for (table, id), once, against the
 * row the caller just locked. No expected stamp: no check.
 */
export function checkExpectedStamp(table: string, id: string, row: { updatedAt: Date | null }, what?: string): void {
  const entry = storage.getStore()?.find((e) => e.table === table && e.id === id && !e.consumed);
  if (!entry) return;
  entry.consumed = true;
  assertNotStale(row, entry.expected, what);
}

/**
 * Takes the request's expected stamp for (table, id), once, for code that
 * compares in its own statement (see staleCondition). Undefined: no check.
 */
export function takeExpectedStamp(table: string, id: string): string | undefined {
  const entry = storage.getStore()?.find((e) => e.table === table && e.id === id && !e.consumed);
  if (!entry) return undefined;
  entry.consumed = true;
  return entry.expected;
}

/**
 * WHERE condition for an atomic compare-and-set on `column` (updated_at):
 * the UPDATE or DELETE matches only while the stored stamp, to the
 * millisecond, still equals `expected`. Undefined when nothing is expected.
 */
export function staleCondition(column: AnyColumn, expected: string | undefined): SQL | undefined {
  if (expected === undefined) return undefined;
  return sql`date_trunc('milliseconds', ${column}) = ${new Date(expected).toISOString()}::timestamptz`;
}

/** The 409 STALE for a record whose stamp no longer matched. */
export function staleConflict(updatedAt: Date | null | undefined, what = 'This record'): AppError {
  return AppError.conflict(
    `${what} was changed by someone else since you opened it. Reload it and make your change again.`,
    'STALE',
    { updatedAt: updatedAt ? updatedAt.toISOString() : null },
  );
}

/**
 * Compares the stored stamp of (table, id) with `expected` before a write
 * (409 STALE). The write itself carries staleCondition(), so a writer that
 * slipped in between still makes it match nothing (the caller maps an empty
 * result to staleConflict). A missing row is left to the caller (404).
 */
export async function assertCurrentStamp(table: string, id: string, expected: string, what = 'This record'): Promise<void> {
  const { db } = await import('../db/index.js');
  const r = await db.execute(sql`SELECT updated_at FROM ${sql.identifier(table)} WHERE id = ${id}`);
  const row = r.rows[0] as { updated_at: Date | string | null } | undefined;
  if (!row) return;
  const stored = row.updated_at === null ? null : new Date(row.updated_at);
  assertNotStale({ updatedAt: stored }, expected, what);
}
