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
import { attachOpenApiMeta } from '../middleware/describe.js';
import { assertNotStale } from '../utils/record-stamps.js';

export interface ExpectedStamp {
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
export function expectStamp(
  table: string,
  param: string | ((req: Request) => string | undefined) = 'id',
  opts: { precheck?: boolean } = {},
) {
  return attachOpenApiMeta(async function clExpectStamp(req: Request, _res: Response, next: NextFunction): Promise<void> {
    const expected = takeExpectedUpdatedAt(req);
    const id = typeof param === 'function' ? param(req) : req.params[param];
    if (expected === undefined || !id) {
      next();
      return;
    }
    // precheck: compare now, before the handler (services that also compare
    // in their own write, via takeExpectedStamp, close the remaining window).
    if (opts.precheck) await assertCurrentStamp(table, id, expected, 'This record', req.tenantId);
    const list = [...(storage.getStore() ?? []), { table, id, expected, consumed: false }];
    storage.run(list, next);
  }, {
    // The stamp field: `expectedUpdatedAt` in the JSON body (the query for a DELETE).
    extensions: { 'x-stamp': 'expectedUpdatedAt' },
  });
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
 * The request's expected stamps not yet compared (U-291 race fix). A database
 * transaction that runs again after a deadlock (transactionWithRetry) re-arms
 * the ones its rolled-back attempt compared, so the new attempt compares them
 * again under its own row lock: the attempt that compared was rolled back and
 * another save may have committed since.
 */
export function expectedStampsMark(): ReadonlySet<ExpectedStamp> {
  return new Set((storage.getStore() ?? []).filter((e) => !e.consumed));
}

/** Re-arms the stamps of `mark` compared since it was taken (see expectedStampsMark). */
export function rearmExpectedStamps(mark: ReadonlySet<ExpectedStamp>): void {
  for (const e of mark) e.consumed = false;
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
export async function assertCurrentStamp(
  table: string, id: string, expected: string, what = 'This record', tenantId?: string,
): Promise<void> {
  const { db } = await import('../db/index.js');
  const scope = tenantId ? sql` AND tenant_id = ${tenantId}` : sql``;
  const r = await db.execute(sql`SELECT updated_at FROM ${sql.identifier(table)} WHERE id = ${id}${scope}`);
  const row = r.rows[0] as { updated_at: Date | string | null } | undefined;
  if (!row) return;
  const stored = row.updated_at === null ? null : new Date(row.updated_at);
  assertNotStale({ updatedAt: stored }, expected, what);
}

/**
 * Per-item stamps for a bulk write (U-291, stale-all-v1): body `stamps`
 * {recordId: updatedAt as read}, taken out of the body. Every listed record
 * of `table` whose stored stamp differs is stale.
 * - `drop`: the stale ids are removed from the request (`drop(req, ids)`)
 *   and the JSON reply gains `stale: [{id, updatedAt}]`; the rest goes on.
 * - `refuse` (merges): any stale record refuses the whole call, 409 STALE
 *   {details.stale}.
 * No `stamps`: no check, as before.
 */
export function expectItemStamps(
  table: string,
  mode: 'drop' | 'refuse',
  drop?: (req: Request, staleIds: ReadonlySet<string>) => void,
) {
  return attachOpenApiMeta(async function clExpectItemStamps(req: Request, res: Response, next: NextFunction): Promise<void> {
    const body = req.body as Record<string, unknown> | undefined;
    const raw = body && typeof body === 'object' ? body['stamps'] : undefined;
    if (body && typeof body === 'object') delete body['stamps'];
    if (raw === undefined || raw === null) {
      next();
      return;
    }
    if (typeof raw !== 'object' || Array.isArray(raw)) {
      throw AppError.badRequest('stamps must map record ids to their updatedAt', 'VALIDATION_ERROR');
    }
    const entries = Object.entries(raw as Record<string, unknown>);
    if (entries.length > 1000 || entries.some(([k, v]) => !UUID.test(k) || typeof v !== 'string' || !ISO.test(v))) {
      throw AppError.badRequest('stamps must map record ids to their updatedAt', 'VALIDATION_ERROR');
    }
    const { db } = await import('../db/index.js');
    const ids = entries.map(([k]) => k);
    const r = await db.execute(sql`SELECT id, updated_at FROM ${sql.identifier(table)}
      WHERE tenant_id = ${req.tenantId} AND id = ANY(${`{${ids.join(',')}}`}::uuid[])`);
    const stored = new Map((r.rows as Array<{ id: string; updated_at: Date | string | null }>)
      .map((x) => [x.id, x.updated_at === null ? null : new Date(x.updated_at)]));
    const stale: Array<{ id: string; updatedAt: string | null }> = [];
    for (const [id, v] of entries) {
      if (!stored.has(id)) continue;
      const s = stored.get(id) ?? null;
      if (s === null || s.getTime() !== Date.parse(v as string)) stale.push({ id, updatedAt: s ? s.toISOString() : null });
    }
    if (stale.length > 0 && mode === 'refuse') {
      throw AppError.conflict('A record was changed by someone else since you opened it. Reload and try again.', 'STALE', { stale });
    }
    if (stale.length > 0 && drop) {
      drop(req, new Set(stale.map((s) => s.id)));
      const json = res.json.bind(res);
      res.json = ((payload: unknown) => json(res.statusCode < 400 && payload && typeof payload === 'object' && !Array.isArray(payload)
        ? { ...(payload as Record<string, unknown>), stale } : payload)) as typeof res.json;
    }
    next();
  }, { extensions: { 'x-stamp': 'stamps' } });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
