// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * Idempotency-Key records (U-18, idempotency-v1).
 *
 * One idempotency_keys row per (tenant, user, key), written INSIDE the
 * posting's own database transaction by claimIdempotency(tx), guarded by a
 * transaction-scoped advisory lock on the key:
 *
 *   - the lock is held by another session  -> 409 IDEMPOTENCY_IN_PROGRESS;
 *   - a row with the same request hash      -> 409 as well (the middleware's
 *     settlement turns it into a replay of that row);
 *   - a row with another request hash       -> 422 IDEMPOTENCY_KEY_REUSED;
 *   - otherwise the row is inserted as 'committed'.
 *
 * The row commits or rolls back with the journal lines, balances and audit
 * rows; a crash or a refusal leaves nothing, and Postgres releases the lock
 * when the transaction ends or the connection dies, so there is no
 * persisted "in progress" state and no takeover timer. After the commit the
 * middleware updates the row to 'done' with the response (settleDone).
 *
 * Rows expire after IDEMPOTENCY_TTL_HOURS; lookups ignore expired rows, a
 * claim replaces an expired row with the same key, and sweepExpired()
 * deletes them hourly.
 */

import { and, eq, sql } from 'drizzle-orm';
import { db, type DbOrTx, type Tx } from '../db/index.js';
import { idempotencyKeys } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import { log } from '../utils/logger.js';
import { isSecretKey } from '../utils/secret-keys.js';
import { getIdemContext, type IdemCtx } from './idempotency-context.js';

export const IDEMPOTENCY_TTL_HOURS = 24;
/** Stored response bodies larger than this (serialized) are not kept; a replay reads the record instead. */
export const IDEMPOTENCY_RESPONSE_CAP_BYTES = 512 * 1024;
/** Sweep batch size. */
const SWEEP_BATCH = 5000;

/** 16-64 characters of [A-Za-z0-9_-] (a UUID is 36). */
export const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_-]{16,64}$/;

export type IdempotencyRow = typeof idempotencyKeys.$inferSelect;

/** Test hooks: only honoured when NODE_ENV is 'test'. */
export const __idempotencyTestHooks: {
  /** Inside the posting transaction, right after the key row was inserted. */
  afterClaim?: (info: { route: string; key: string }) => void | Promise<void>;
  /** Replaces the 'done' UPDATE after the commit (throw to simulate a failed settle). */
  settle?: (info: { rowId: string }) => void | Promise<void>;
  /** Overrides IDEMPOTENCY_RESPONSE_CAP_BYTES. */
  capBytes?: number;
} = {};

/** Route bugs seen under NODE_ENV=test (a 2xx with no claim); the coverage test asserts it stays empty. */
export const __idempotencyDiagnostics: { unclaimed: string[] } = { unclaimed: [] };

const isTest = () => process.env['NODE_ENV'] === 'test';

function testHook<K extends keyof typeof __idempotencyTestHooks>(name: K): (typeof __idempotencyTestHooks)[K] | undefined {
  return isTest() ? __idempotencyTestHooks[name] : undefined;
}

/** First 8 characters of a key, the most any log line carries. */
export function keyPrefix(key: string): string {
  return key.slice(0, 8);
}

// ── Errors ───────────────────────────────────────────────────────────

export function keyInvalid(): AppError {
  return AppError.badRequest('Idempotency-Key must be 16 to 64 characters of letters, digits, - or _', 'IDEMPOTENCY_KEY_INVALID');
}

export function keyReused(row: Pick<IdempotencyRow, 'entityType' | 'entityId'>): AppError {
  return AppError.unprocessableEntity(
    'This Idempotency-Key was already used for a different request.',
    'IDEMPOTENCY_KEY_REUSED',
    { entityType: row.entityType ?? null, entityId: row.entityId ?? null },
  );
}

export function inProgress(): AppError {
  return AppError.conflict('A request with this Idempotency-Key is still being processed; retry shortly.', 'IDEMPOTENCY_IN_PROGRESS');
}

// ── Lookup ───────────────────────────────────────────────────────────

const notExpired = sql`${idempotencyKeys.createdAt} > now() - make_interval(hours => ${IDEMPOTENCY_TTL_HOURS})`;

/** The live (not expired) row of a key, if any. */
export async function findLive(tenantId: string, userId: string, key: string, executor: DbOrTx = db): Promise<IdempotencyRow | undefined> {
  const [row] = await executor.select().from(idempotencyKeys).where(and(
    eq(idempotencyKeys.tenantId, tenantId),
    eq(idempotencyKeys.userId, userId),
    eq(idempotencyKeys.idempotencyKey, key),
    notExpired,
  )).limit(1);
  return row;
}

// ── Claim (inside the posting transaction) ───────────────────────────

/** Savepoint depth of a drizzle transaction (0 for the outer transaction). */
function savepointDepth(tx: Tx): number {
  return (tx as unknown as { nestedIndex?: number }).nestedIndex ?? 0;
}

function routeBug(ctx: IdemCtx, code: 'IDEMPOTENCY_MULTI_TX' | 'IDEMPOTENCY_SAVEPOINT', message: string): void {
  if (isTest()) throw new AppError(500, message, code);
  log.warn({ component: 'idempotency', event: code.toLowerCase(), route: ctx.route, key: keyPrefix(ctx.key) });
}

/**
 * Claims the request's Idempotency-Key on `tx` (see the header). A no-op
 * without a context (no header, jobs, batch, importers), once the response
 * is done, and for a second claim on the same `tx` (one request may post
 * several transactions in one database transaction).
 */
export async function claimIdempotency(tx: Tx): Promise<void> {
  const ctx = getIdemContext();
  if (!ctx || ctx.closed) return;
  if (ctx.claimTx === tx) return;
  if (ctx.claimTx) {
    routeBug(ctx, 'IDEMPOTENCY_MULTI_TX', `Route ${ctx.route} claimed its Idempotency-Key in a second database transaction`);
    return;
  }
  if (savepointDepth(tx) > 0) {
    routeBug(ctx, 'IDEMPOTENCY_SAVEPOINT', `Route ${ctx.route} claimed its Idempotency-Key inside a savepoint`);
    return;
  }

  const lockKey = `idem:${ctx.tenantId}:${ctx.userId}:${ctx.key}`;
  const [lock] = (await tx.execute(sql`SELECT pg_try_advisory_xact_lock(hashtextextended(${lockKey}, 0)) AS ok`)).rows as Array<{ ok: boolean }>;
  if (!lock?.ok) throw inProgress();

  const [prev] = await tx.select({
    id: idempotencyKeys.id,
    requestSha256: idempotencyKeys.requestSha256,
    entityType: idempotencyKeys.entityType,
    entityId: idempotencyKeys.entityId,
    expired: sql<boolean>`NOT (${notExpired})`,
  }).from(idempotencyKeys).where(and(
    eq(idempotencyKeys.tenantId, ctx.tenantId),
    eq(idempotencyKeys.userId, ctx.userId),
    eq(idempotencyKeys.idempotencyKey, ctx.key),
  )).limit(1);
  if (prev) {
    if (prev.expired) {
      await tx.delete(idempotencyKeys).where(and(eq(idempotencyKeys.tenantId, ctx.tenantId), eq(idempotencyKeys.id, prev.id)));
    } else if (prev.requestSha256 === ctx.requestHash) {
      // Committed by another request since this one's pre-check: settlement replays it.
      throw inProgress();
    } else {
      throw keyReused(prev);
    }
  }

  const [row] = await tx.insert(idempotencyKeys).values({
    tenantId: ctx.tenantId,
    companyId: ctx.companyId,
    userId: ctx.userId,
    idempotencyKey: ctx.key,
    route: ctx.route,
    requestSha256: ctx.requestHash,
    state: 'committed',
    successStatus: ctx.successStatus,
  }).returning({ id: idempotencyKeys.id });
  ctx.claimTx = tx;
  ctx.rowId = row!.id;
  log.debug({ component: 'idempotency', event: 'claimed', route: ctx.route, key: keyPrefix(ctx.key) });

  const afterClaim = testHook('afterClaim');
  if (afterClaim) await afterClaim({ route: ctx.route, key: ctx.key });
}

/**
 * Stamps the request's primary record on its key row, on the claiming
 * `tx` (first record wins). A no-op without a claim on `tx`.
 */
export async function recordIdempotentEntity(tx: Tx, type: string, id: string): Promise<void> {
  const ctx = getIdemContext();
  if (!ctx || ctx.closed || ctx.claimTx !== tx || !ctx.rowId || ctx.entity) return;
  ctx.entity = { type, id };
  await tx.update(idempotencyKeys).set({ entityType: type, entityId: id })
    .where(and(eq(idempotencyKeys.tenantId, ctx.tenantId), eq(idempotencyKeys.id, ctx.rowId)));
}

/** claimIdempotency(tx) + recordIdempotentEntity(tx, type, id), for services that write without the ledger. */
export async function claimAndRecord(tx: Tx, type: string, id: string): Promise<void> {
  await claimIdempotency(tx);
  await recordIdempotentEntity(tx, type, id);
}

// ── Settlement (after the commit) ────────────────────────────────────

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return Object.prototype.toString.call(v) === '[object Object]';
}

/**
 * A response body without the value of any secret-looking key
 * (SECRET_KEY_RE), at every depth. A key whose value is null or absent
 * holds no secret and is kept, so a replay of a record without one (an
 * invoice's `publicToken: null`) is the same body the client first got.
 */
export function redactResponse(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => redactResponse(v));
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (isSecretKey(k)) {
      if (v === null) out[k] = null;
      continue;
    }
    out[k] = redactResponse(v);
  }
  return out;
}

/** The stored form of a success body: secret values removed, serialized once. */
export function storedResponse(body: unknown): { text: string | null; truncated: boolean } {
  let text: string;
  try {
    text = JSON.stringify(redactResponse(body) ?? null);
  } catch {
    return { text: null, truncated: true };
  }
  const cap = testHook('capBytes') ?? IDEMPOTENCY_RESPONSE_CAP_BYTES;
  if (Buffer.byteLength(text, 'utf8') > cap) return { text: null, truncated: true };
  return { text, truncated: false };
}

/**
 * Marks the request's row 'done' with its success response. Runs on the
 * pool after the posting committed. A failure leaves the row 'committed',
 * which still replays (through the route's reader), so it is logged only.
 */
export async function settleDone(ctx: IdemCtx, status: number, body: unknown): Promise<void> {
  if (!ctx.rowId) return;
  try {
    const hook = testHook('settle');
    if (hook) {
      await hook({ rowId: ctx.rowId });
    }
    const { text, truncated } = storedResponse(body);
    await db.update(idempotencyKeys).set({
      state: 'done',
      responseStatus: status,
      responseBody: text === null ? null : sql`${text}::jsonb`,
      responseTruncated: truncated,
      completedAt: new Date(),
    }).where(and(eq(idempotencyKeys.tenantId, ctx.tenantId), eq(idempotencyKeys.id, ctx.rowId)));
  } catch (err) {
    log.warn({
      component: 'idempotency', event: 'settle_failed', route: ctx.route, key: keyPrefix(ctx.key),
      error: err instanceof Error ? err.name : 'unknown',
    });
  }
}

// ── TTL purge ────────────────────────────────────────────────────────

/**
 * Deletes expired rows in batches of SWEEP_BATCH (hourly, every install).
 * Skipped while a tenant export or import job runs in this process.
 */
export async function sweepExpired(): Promise<number> {
  const { activeJobResources } = await import('./tenant-portability/jobs.js');
  if (activeJobResources().size > 0) return 0;
  let removed = 0;
  for (;;) {
    const r = await db.execute(sql`
      DELETE FROM idempotency_keys WHERE id IN (
        SELECT id FROM idempotency_keys
        WHERE created_at <= now() - make_interval(hours => ${IDEMPOTENCY_TTL_HOURS})
        LIMIT ${SWEEP_BATCH}
      )
    `);
    const n = r.rowCount ?? 0;
    removed += n;
    if (n < SWEEP_BATCH) return removed;
  }
}
