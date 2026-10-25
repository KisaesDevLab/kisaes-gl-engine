// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Request-scoped Idempotency-Key context (U-18, idempotency-v1), mirroring
// lock-context.ts. The idempotent() route middleware runs the handler inside
// this AsyncLocalStorage; the posting choke points (ledger.postTransaction,
// updateTransaction, voidTransactionInTx, deleteTransactionInTx and the few
// services that write without the ledger) call claimIdempotency(tx), which
// reads it. Paths that never enter the store (requests without the header,
// importers, schedulers, the recurring run, batch, MCP, api-v2) have no
// context, and every claim is a no-op for them.

import { AsyncLocalStorage } from 'node:async_hooks';
import type { Tx } from '../db/index.js';

export interface IdemEntity { type: string; id: string }

export interface IdemCtx {
  tenantId: string;
  /** NULL on the tenant-wide routes (contacts, items, tags). */
  companyId: string | null;
  userId: string;
  key: string;
  requestHash: string;
  /** 'POST /transactions/:id/void' */
  route: string;
  /** The route's success status (201 create, 200 otherwise). */
  successStatus: number;
  /** The database transaction that claimed the key (claims are re-entrant per tx). */
  claimTx?: Tx;
  /** id of the idempotency_keys row this request inserted. */
  rowId?: string;
  /** The primary record the request created or changed (first record wins). */
  entity?: IdemEntity;
  /** True once the response finished or the connection closed: no more claims. */
  closed: boolean;
}

const storage = new AsyncLocalStorage<IdemCtx>();

export function getIdemContext(): IdemCtx | undefined {
  return storage.getStore();
}

export function runWithIdemContext<T>(ctx: IdemCtx, fn: () => T): T {
  return storage.run(ctx, fn);
}

/**
 * Runs `fn` with no Idempotency-Key context, whatever the surrounding
 * request carried: for work a request starts that is not part of its own
 * posting (it must neither claim the key nor be refused as a second claim).
 */
export function runWithoutIdempotency<T>(fn: () => T): T {
  return storage.exit(fn);
}
