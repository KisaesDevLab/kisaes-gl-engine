// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * Idempotency-Key on the posting and master-data routes (U-18,
 * idempotency-v1). Opt-in per route:
 *
 *   router.post('/', idempotent({ successStatus: 201, replay: reader }), ..., handler)
 *
 * Mounted after authentication, the company context and EVERY permission
 * check of the route (router-level requireResource and any route-level
 * check, such as the firm-only AJE rule on void or the template access
 * checks), so a replay still needs current permission. A replay never runs
 * the handler: a permission check left inside a handler or service would
 * not run for it, so covered routes keep theirs in middleware ahead of
 * idempotent(). Business rules that only the posting itself checks
 * (validation, closed period, balances) are not re-run on a replay.
 *
 * Without the header the middleware does nothing. With one:
 *
 *   1. the key is checked (16-64 of [A-Za-z0-9_-], else 400
 *      IDEMPOTENCY_KEY_INVALID) and the request hashed
 *      (utils/request-hash.ts);
 *   2. a live row of the same user and key is replayed (same hash) or
 *      refused with 422 IDEMPOTENCY_KEY_REUSED (another hash), before any
 *      validation, closed-period check or posting;
 *   3. otherwise the handler runs inside the idempotency context; the
 *      posting claims the key in its own database transaction
 *      (services/idempotency.service.ts);
 *   4. `res.json` is wrapped to settle the outcome: a 2xx marks the row
 *      'done' with the (redacted, capped) response; any other status looks
 *      the key up once more and replays a matching row that committed
 *      meanwhile instead of sending the error. Errors are not stored, with
 *      one exception: a route bug (a claim in a second database
 *      transaction or inside a savepoint, 500 IDEMPOTENCY_MULTI_TX /
 *      IDEMPOTENCY_SAVEPOINT) is stored as the request's outcome, since
 *      part of it may have committed; a retry replays that 500.
 *
 * Claims stop once the handler answers. A client that disconnects first
 * (a timeout) does not stop them: the handler runs on, its posting claims
 * the key, and the client's retry replays it (409 IDEMPOTENCY_IN_PROGRESS
 * while it still runs). Work a request starts in the background, outside
 * its own posting, runs under runWithoutIdempotency().
 *
 * A replay answers with the original status and body and the header
 * `Idempotent-Replayed: true`. A row without a stored body (the settle
 * failed, the body was over the cap) replays through the route's reader:
 * the record as it is now, in the route's response shape, with the route's
 * success status; when the reader fails (the record is gone) the replay is
 * 200 `{idempotency: {state: 'committed', entityType, entityId}}`.
 */

import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { attachOpenApiMeta } from './describe.js';
import { requestHash } from '../utils/request-hash.js';
import { log } from '../utils/logger.js';
import { runWithIdemContext, type IdemCtx, type IdemEntity } from '../services/idempotency-context.js';
import {
  IDEMPOTENCY_KEY_RE, findLive, keyInvalid, keyReused, keyPrefix, settleDone, settleRouteBug, routeBugError,
  __idempotencyDiagnostics, type IdempotencyRow,
} from '../services/idempotency.service.js';
import { AppError } from '../utils/errors.js';

export const IDEMPOTENT_REPLAYED_HEADER = 'Idempotent-Replayed';

export interface IdempotentOptions {
  /** The route's success status: 201 for a create, 200 otherwise. */
  successStatus: 200 | 201;
  /**
   * Reads the record for a replay without a stored body, in the route's
   * response shape. `entity` is what the request recorded (null when it
   * recorded nothing); routes on `/:id` may read `req.params` instead.
   */
  replay?: (req: Request, entity: IdemEntity | null) => Promise<unknown>;
}

/** 'POST /transactions/:id/void' from the router mount and the route path, without the /api/vN prefix. */
export function routeTemplate(req: Request): string {
  const routePath = (req.route as { path?: unknown } | undefined)?.path;
  const base = req.baseUrl.replace(/^\/api\/v\d+/, '');
  const path = typeof routePath === 'string' ? routePath : req.path;
  const full = `${base}${path === '/' ? '' : path}` || '/';
  return `${req.method.toUpperCase()} ${full}`.slice(0, 120);
}

function entityOf(row: Pick<IdempotencyRow, 'entityType' | 'entityId'>): IdemEntity | null {
  return row.entityType && row.entityId ? { type: row.entityType, id: row.entityId } : null;
}

/** The status and body a replay of `row` sends. */
async function replayOf(req: Request, row: IdempotencyRow, opts: IdempotentOptions): Promise<{ status: number; body: unknown }> {
  if (row.state === 'done' && row.responseStatus !== null && !row.responseTruncated && row.responseBody !== null) {
    return { status: row.responseStatus, body: row.responseBody };
  }
  const entity = entityOf(row);
  if (opts.replay) {
    try {
      return { status: row.successStatus, body: await opts.replay(req, entity) };
    } catch {
      // The record is gone (or unreadable): fall through to the minimal body.
    }
  }
  return {
    status: 200,
    body: { idempotency: { state: 'committed', entityType: entity?.type ?? null, entityId: entity?.id ?? null } },
  };
}

function isSuccess(status: number): boolean {
  return status >= 200 && status < 300;
}

export function idempotent(opts: IdempotentOptions) {
  const mw = async function idempotentRoute(req: Request, res: Response, next: NextFunction) {
    const key = req.get('Idempotency-Key');
    if (key === undefined) { next(); return; }
    if (!IDEMPOTENCY_KEY_RE.test(key)) throw keyInvalid();
    if (!req.userId || !req.tenantId) {
      // Every covered route is authenticated as a user; a key without one can't be scoped.
      throw AppError.badRequest('Idempotency-Key needs a signed-in user', 'IDEMPOTENCY_UNSUPPORTED');
    }

    const route = routeTemplate(req);
    const companyId = req.companyId ?? null;
    const hash = requestHash({
      method: req.method,
      route: route.slice(route.indexOf(' ') + 1),
      params: req.params as Record<string, unknown>,
      query: req.query as Record<string, unknown>,
      companyId,
      ifMatch: req.get('If-Match') ?? null,
      body: req.body,
    });

    const send = (status: number, body: unknown, replayed: boolean, json: (b: unknown) => Response) => {
      if (replayed) res.setHeader(IDEMPOTENT_REPLAYED_HEADER, 'true');
      res.status(status);
      json(body);
    };

    // Pre-check: replay or refuse before anything runs.
    const prev = await findLive(req.tenantId, req.userId, key);
    if (prev) {
      if (prev.requestSha256 !== hash) throw keyReused(prev, companyId);
      const r = await replayOf(req, prev, opts);
      log.debug({ component: 'idempotency', event: 'replayed', route, state: prev.state, key: keyPrefix(key) });
      send(r.status, r.body, true, (b) => res.json(b));
      return;
    }

    const ctx: IdemCtx = {
      tenantId: req.tenantId, companyId, userId: req.userId, key, requestHash: hash, route,
      successStatus: opts.successStatus, closed: false,
    };
    // Claims stop once the handler answers (settleJson below) or the
    // response finished (a route that answers without res.json). Not on
    // 'close': a client that disconnects (a timeout) leaves the handler
    // running, and its posting must still claim the key so the client's
    // retry replays it instead of posting a second time.
    res.once('finish', () => { ctx.closed = true; });
    const original = res.json.bind(res);
    let settling = false;
    res.json = function settleJson(body: unknown): Response {
      if (settling) return original(body);
      settling = true;
      ctx.closed = true;
      const status = res.statusCode;
      void (async () => {
        if (ctx.failed) {
          // A route bug (a claim in a second transaction or a savepoint):
          // part of the request may have committed. The error is stored, so
          // a retry with the key replays it: never a second posting, never
          // a success. A handler that swallowed the error and answered 2xx
          // gets the route bug's 500 instead.
          let outStatus = status;
          let outBody = body;
          if (isSuccess(status)) {
            const err = routeBugError(ctx.failed);
            outStatus = 500;
            outBody = { error: { message: err.message, code: err.code } };
          }
          await settleRouteBug(ctx, outStatus, outBody);
          send(outStatus, outBody, false, original);
          return;
        }
        if (isSuccess(status)) {
          if (ctx.rowId) {
            await settleDone(ctx, status, body);
          } else {
            // A 2xx with no claim is a route bug: the posting happened, so send it.
            log.error({ component: 'idempotency', event: 'idempotency_unclaimed', code: 'IDEMPOTENCY_UNCLAIMED', route });
            if (process.env['NODE_ENV'] === 'test') __idempotencyDiagnostics.unclaimed.push(route);
          }
          send(status, body, false, original);
          return;
        }
        // Refused: a matching row committed meanwhile (by this request
        // before a later failure, or by a concurrent first attempt) is
        // replayed instead of the error.
        const code = (body as { error?: { code?: unknown } } | null)?.error?.code;
        let row: IdempotencyRow | undefined;
        try {
          row = await findLive(ctx.tenantId, ctx.userId, ctx.key);
        } catch {
          row = undefined;
        }
        if (row && row.requestSha256 === ctx.requestHash) {
          const r = await replayOf(req, row, opts);
          log.debug({ component: 'idempotency', event: 'settled_replay', route, state: row.state, key: keyPrefix(key) });
          send(r.status, r.body, true, original);
          return;
        }
        if (status === 409 && code === 'IDEMPOTENCY_IN_PROGRESS') res.setHeader('Retry-After', '1');
        send(status, body, false, original);
      })().catch(() => {
        if (!res.headersSent) original(body);
      });
      return res;
    };

    runWithIdemContext(ctx, () => next());
  };
  return attachOpenApiMeta(mw, {
    headers: [{
      name: 'Idempotency-Key',
      required: false,
      description: 'idempotency-v1: 16-64 characters of [A-Za-z0-9_-] (a UUID). A retry with the same key and request replays the stored result (header Idempotent-Replayed: true); another request with the key is 422 IDEMPOTENCY_KEY_REUSED; a request still running with the key is 409 IDEMPOTENCY_IN_PROGRESS (Retry-After: 1). Kept 24 hours.',
      schema: z.string().regex(IDEMPOTENCY_KEY_RE),
    }],
    extensions: { 'x-idempotency': true },
  });
}
