// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Request-scoped NEGATIVE_STOCK warnings (U-158, inventory-costing-v1),
// mirroring lock-context.ts and idempotency-context.ts. The costing walk
// runs at the bottom of every posting service (the ledger core's create,
// edit, void and delete); threading its warnings back through each
// service's return value would touch ~20 signatures. Instead each posting
// router runs its handlers inside this AsyncLocalStorage, the core notes
// the warnings here, and a successful JSON reply gets them appended to its
// `warnings` array (created when absent). Paths outside a request (the
// recurring run, importers, MCP) have no store; their postings still
// return `inventoryWarnings` from the core functions.

import { AsyncLocalStorage } from 'node:async_hooks';
import type { Request, Response, NextFunction } from 'express';

export interface NegativeStockWarning { code: 'NEGATIVE_STOCK'; itemId: string; date: string; onHand: string }

interface Ctx { res: Response; warnings: NegativeStockWarning[]; wrapped: boolean }

const storage = new AsyncLocalStorage<Ctx>();

/**
 * Notes warnings for the current request's reply. On the first note the
 * reply's res.json is wrapped, so the wrapper sits outside every wrapper a
 * route middleware installed earlier (the idempotency record stores the
 * reply with the warnings, and a replay returns them too).
 */
export function noteInventoryWarnings(warnings: readonly NegativeStockWarning[]): void {
  const ctx = storage.getStore();
  if (!ctx || warnings.length === 0) return;
  for (const w of warnings) {
    if (!ctx.warnings.some((x) => x.itemId === w.itemId && x.date === w.date && x.onHand === w.onHand)) ctx.warnings.push(w);
  }
  if (ctx.wrapped) return;
  ctx.wrapped = true;
  const inner = ctx.res.json.bind(ctx.res);
  ctx.res.json = function withInventoryWarnings(body: unknown): Response {
    if (ctx.res.statusCode < 300 && body && typeof body === 'object' && !Array.isArray(body)) {
      const b = body as Record<string, unknown>;
      const existing = b['warnings'];
      if (existing === undefined || Array.isArray(existing)) {
        return inner({ ...b, warnings: [...((existing as unknown[] | undefined) ?? []), ...ctx.warnings] });
      }
    }
    return inner(body);
  } as Response['json'];
}

/** Express middleware: the request's warning store (mount on every router that posts inventory documents). */
export function inventoryWarningsContext(_req: Request, res: Response, next: NextFunction): void {
  storage.run({ res, warnings: [], wrapped: false }, next);
}
