// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * OpenAPI metadata carried on middleware functions (U-04).
 *
 * The OpenAPI export (src/scripts/openapi-export.ts) reads this metadata
 * from each operation's middleware chain. At request time it does nothing:
 * the metadata is a non-enumerable property on the function object, and
 * `describe()` is a pass-through middleware.
 *
 * - `validate(schema)` attaches `{ body: schema }` automatically.
 * - `describe({...})` lets a route add a summary, tags, query/path
 *   parameter schemas, or a response schema, one route at a time:
 *
 *     router.get('/:id', describe({ summary: 'Get an account',
 *       params: z.object({ id: z.string().uuid() }) }), handler);
 */

import type { Request, Response, NextFunction } from 'express';
import type { ZodTypeAny } from 'zod';

export interface OpenApiMeta {
  summary?: string;
  description?: string;
  tags?: string[];
  /** JSON request body schema. */
  body?: ZodTypeAny;
  /** Object schema whose keys are query parameters. */
  query?: ZodTypeAny;
  /** Object schema whose keys are path parameters. */
  params?: ZodTypeAny;
  /** JSON schema of the 200 response. */
  response?: ZodTypeAny;
  deprecated?: boolean;
}

const META = Symbol.for('mybooks.openapi.meta');

type Fn = (...args: never[]) => unknown;

/** Attaches (merges) OpenAPI metadata onto a middleware function. */
export function attachOpenApiMeta<T extends Fn>(fn: T, meta: OpenApiMeta): T {
  const existing = (fn as unknown as Record<symbol, OpenApiMeta | undefined>)[META];
  Object.defineProperty(fn, META, {
    value: { ...existing, ...meta },
    enumerable: false,
    configurable: true,
    writable: false,
  });
  return fn;
}

/** Reads OpenAPI metadata from a middleware function, if any. */
export function getOpenApiMeta(fn: unknown): OpenApiMeta | undefined {
  if (typeof fn !== 'function') return undefined;
  return (fn as unknown as Record<symbol, OpenApiMeta | undefined>)[META];
}

/** Documentation-only middleware: passes every request straight through. */
export function describe(meta: OpenApiMeta) {
  return attachOpenApiMeta(
    function describeRoute(_req: Request, _res: Response, next: NextFunction) {
      next();
    },
    meta,
  );
}
