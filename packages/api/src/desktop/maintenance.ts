// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

/**
 * Desktop maintenance mode (U-293, maintenance-v1).
 *
 * One session (the holder, a session chain) takes the books for itself, for
 * a restore, an import, an undo or a rollback:
 *   - start: the row is written, then in-flight writes drain (at most 30 s;
 *     on timeout the row is removed again and the caller gets 409
 *     MAINTENANCE_BUSY), then every other session ends, unless the hold
 *     was started with keepSessions (a routine hold: payroll, an import;
 *     maintenance-sessions-v1), when they stay and only wait;
 *   - while on: every request but the holder's gets 503 MAINTENANCE (probes,
 *     GET /desktop/info and the reset excepted); only the holder's user can
 *     sign in and only the holder's chain can refresh;
 *   - end: other sessions are ended (not for keepSessions) and the row
 *     removed in one transaction;
 *   - reset: the host app clears it after a file-level restore (a restored
 *     dump may carry a row with a holder that no longer exists) and at every
 *     host start (any hold then is left over from a crash).
 * The row lives in desktop_maintenance (migration 0288), so it survives an
 * engine restart; this module caches it (one engine process per database).
 *
 * A hold is void once its holder's session chain has no live session row (the
 * host app crashed and signed in again, the holder signed out, or the chain
 * expired): it is cleared on first sight, so it can never lock everyone out
 * (P33 review B1). Session trimming never ends the holder's chain, and a
 * switch-tenant that starts a new chain moves the hold with it.
 *
 * Desktop mode only. The server appliance never mounts any of it.
 */

import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { sql } from 'drizzle-orm';
import { db, type DbOrTx } from '../db/index.js';
import { env } from '../config/env.js';
import { AppError } from '../utils/errors.js';
import { auditLog } from '../middleware/audit.js';
import { desktopProfile, isDesktop } from './profile.js';
import { getWorkspaceTenantId } from './workspace.js';
import { routeMatcher } from './route-classes.js';

export interface MaintenanceHold {
  holderSession: string;
  holderUser: string;
  startedAt: string;
}

let cached: MaintenanceHold | null | undefined; // undefined: not loaded yet
/**
 * The holder chain of a hold started with keepSessions (a routine hold:
 * payroll, an import; ClientLedger PR-8 S6): its start and end leave the
 * other sessions alone. Kept in memory only: after an engine restart the
 * hold ends the other sessions as before (the safe side).
 */
let keepSessionsFor: string | null = null;
/** Book writes in flight (the drain waits for them); the request is kept to read its sid at drain time. */
const inFlight = new Set<Request>();
let drainMs = 30_000;

const WRITE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Writes that never change the books, so the drain does not wait for them
 * (P33 review S8): sign-in, the caller's own settings, AI and assistant calls
 * (a local model can take a minute), document reading, report runs and
 * previews. The two AI routes that do post (accepting a suggestion, importing
 * a read statement) are drained. Pinned by maintenance.test.ts.
 */
const DRAIN_EXEMPT = routeMatcher([
  'WRITE /api/v1/auth/**',
  'WRITE /api/v1/users/me/**',
  'WRITE /api/v1/chat/**',
  'WRITE /api/v1/ai/**',
  'POST /api/v1/document-reading/**',
  'POST /api/v1/bills/extract-from-attachment/*',
  'POST /api/v1/reports/**',
  'POST /api/v1/report-builder/run/**',
  'POST /api/v1/report-builder/draft',
  'POST /api/v1/report-builder/definitions/export',
  'POST /api/v1/report-builder/definitions/import/preview',
  'POST /api/v1/*/preview',
  'POST /api/v1/*/*/preview',
  'POST /api/v1/desktop/maintenance/**',
]);
const DRAIN_COUNTED = routeMatcher([
  'POST /api/v1/ai/categorize/accept',
  'POST /api/v1/ai/parse/statement/import',
]);

/** True when the drain waits for a write to (method, path) (exported for the test). */
export function drainCounts(method: string, path: string): boolean {
  if (!WRITE.has(method.toUpperCase())) return false;
  return DRAIN_COUNTED(method, path) || !DRAIN_EXEMPT(method, path);
}

/** The stored hold, as cached (no liveness check). */
async function storedHold(): Promise<MaintenanceHold | null> {
  if (cached !== undefined) return cached;
  const r = await db.execute(sql`SELECT holder_session, holder_user, started_at FROM desktop_maintenance WHERE id = 1`);
  const row = r.rows[0] as { holder_session: string; holder_user: string; started_at: Date | string } | undefined;
  cached = row
    ? { holderSession: row.holder_session, holderUser: row.holder_user, startedAt: new Date(row.started_at).toISOString() }
    : null;
  return cached;
}

/** True while the session chain has a live (unexpired) session row. */
async function chainIsLive(chainId: string): Promise<boolean> {
  const r = await db.execute(sql`SELECT 1 FROM sessions WHERE chain_id = ${chainId} AND expires_at > now() LIMIT 1`);
  return r.rows.length > 0;
}

/**
 * The current hold, or null. A hold whose holder chain has no live session
 * is void: it is cleared here (once; audited, and the feed epoch rotates so
 * every client reloads whatever the holder left half done).
 */
export async function currentHold(): Promise<MaintenanceHold | null> {
  const hold = await storedHold();
  if (!hold) return null;
  if (await chainIsLive(hold.holderSession)) return hold;
  const r = await db.execute(sql`DELETE FROM desktop_maintenance WHERE id = 1 AND holder_session = ${hold.holderSession} RETURNING id`);
  cached = undefined;
  keepSessionsFor = null;
  if (r.rows.length > 0) {
    await db.execute(sql`UPDATE change_feed_state SET epoch = gen_random_uuid() WHERE id = 1`);
    await auditMaintenance('maintenance_void', { reason: 'holder_session_ended' });
  }
  return storedHold();
}

/** The holder's session chain, if a hold is stored (session trimming keeps it). */
export async function holdChain(): Promise<string | null> {
  if (!isDesktop()) return null;
  return (await storedHold())?.holderSession ?? null;
}

/**
 * Moves a hold from one session chain to another in the caller's database
 * transaction (a switch-tenant that starts a new chain). Call
 * _forgetMaintenanceCache after the transaction commits.
 */
export async function followHoldInTx(tx: DbOrTx, fromChain: string | undefined, toChain: string): Promise<void> {
  if (!isDesktop() || !fromChain || fromChain === toChain) return;
  await tx.execute(sql`UPDATE desktop_maintenance SET holder_session = ${toChain} WHERE id = 1 AND holder_session = ${fromChain}`);
  cached = undefined;
  if (keepSessionsFor === fromChain) keepSessionsFor = toChain;
}

/** Forgets the cached hold (after a transaction that moved it; tests). */
export function forgetMaintenanceCache(): void {
  cached = undefined;
}
export const _forgetMaintenanceCache = forgetMaintenanceCache;

/** Test hook: the drain's wait (default 30 s). */
export function _setDrainMs(ms: number): void {
  drainMs = ms;
}

/** Test hook: a request in flight (classified as the gate does) until the returned function is called. */
export function _trackInFlight(req: Request): () => void {
  if (drainCounts(req.method, req.path)) inFlight.add(req);
  return () => inFlight.delete(req);
}

function unavailable(res: Response): void {
  res.status(503).json({
    error: { message: 'The books are being maintained on the host computer. Try again when it is done.', code: 'MAINTENANCE' },
  });
}

/** The session chain of a request's Bearer token, if it verifies. */
function bearerSid(req: Request): string | undefined {
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer ')) return undefined;
  try {
    const p = jwt.verify(h.slice(7), env.JWT_SECRET, { algorithms: ['HS256'] }) as { sid?: unknown };
    return typeof p.sid === 'string' ? p.sid : undefined;
  } catch {
    return undefined;
  }
}

const OPEN_DURING_MAINTENANCE = new Set([
  'GET /health', 'GET /ping', 'GET /api/health', 'GET /api/ping', 'GET /api/v1/health', 'GET /api/v1/ping',
  'GET /api/v1/desktop/info',
  'GET /api/v1/desktop/maintenance',
  'POST /api/v1/desktop/maintenance/reset',
  // Sign-in and refresh are let through; the services allow only the holder (assertMaintenanceAllows*).
  'POST /api/v1/auth/login',
  'POST /api/v1/auth/refresh',
  'POST /api/v1/auth/logout',
]);

/**
 * Global middleware (desktop mode, after the gate): counts in-flight writes
 * for the drain and refuses everyone but the holder while a hold exists.
 */
export function maintenanceGate() {
  return async function clMaintenanceGate(req: Request, res: Response, next: NextFunction): Promise<void> {
    const key = `${req.method} ${req.path.replace(/\/+$/, '') || '/'}`;
    if (!OPEN_DURING_MAINTENANCE.has(key)) {
      const hold = await currentHold();
      if (hold && bearerSid(req) !== hold.holderSession) {
        unavailable(res);
        return;
      }
    }
    if (drainCounts(req.method, req.path)) {
      inFlight.add(req);
      const finish = () => {
        inFlight.delete(req);
      };
      res.on('finish', finish);
      res.on('close', finish);
    }
    next();
  };
}

/** Login during a hold: only the holder's user (503 MAINTENANCE otherwise). */
export async function assertMaintenanceAllowsUser(userId: string): Promise<void> {
  if (!isDesktop()) return;
  const hold = await currentHold();
  if (hold && hold.holderUser !== userId) throw new AppError(503, 'The books are being maintained on the host computer. Try again when it is done.', 'MAINTENANCE');
}

/** Refresh during a hold: only the holder's chain (503 MAINTENANCE otherwise). */
export async function assertMaintenanceAllowsChain(chainId: string): Promise<void> {
  if (!isDesktop()) return;
  const hold = await currentHold();
  if (hold && hold.holderSession !== chainId) throw new AppError(503, 'The books are being maintained on the host computer. Try again when it is done.', 'MAINTENANCE');
}

async function auditMaintenance(event: string, after: Record<string, unknown>, userId?: string): Promise<void> {
  const tenantId = await getWorkspaceTenantId();
  if (tenantId) await auditLog(tenantId, 'update', 'desktop_maintenance', null, null, { event, ...after }, userId);
}

/**
 * Starts a hold for the caller's session (super admin, checked by the route).
 * With keepSessions (a routine hold: payroll, an import) the other sessions
 * stay signed in and only get 503 MAINTENANCE while it lasts; without it
 * (a restore: the books are replaced) they end at start and at end.
 */
export async function startMaintenance(
  holder: { sessionChainId: string | undefined; userId: string },
  opts: { keepSessions?: boolean } = {},
): Promise<MaintenanceHold> {
  if (!holder.sessionChainId) throw AppError.unauthorized('Sign in again.', 'SESSION_REVOKED');
  const existing = await currentHold();
  if (existing) {
    if (existing.holderSession === holder.sessionChainId) return existing;
    throw AppError.conflict('Maintenance is already on.', 'MAINTENANCE_HELD');
  }
  const ins = await db.execute(sql`INSERT INTO desktop_maintenance (id, holder_session, holder_user) VALUES (1, ${holder.sessionChainId}, ${holder.userId})
    ON CONFLICT (id) DO NOTHING RETURNING started_at`);
  if (ins.rows.length === 0) {
    cached = undefined;
    throw AppError.conflict('Maintenance is already on.', 'MAINTENANCE_HELD');
  }
  cached = { holderSession: holder.sessionChainId, holderUser: holder.userId, startedAt: new Date((ins.rows[0] as { started_at: string }).started_at).toISOString() };
  // Drain: wait for the other sessions' book writes in flight. The holder's own
  // requests (this one included) never block its start (P33 review S8).
  const others = () => [...inFlight].filter((r) => bearerSid(r) !== holder.sessionChainId).length;
  const deadline = Date.now() + drainMs;
  while (others() > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  if (others() > 0) {
    await db.execute(sql`DELETE FROM desktop_maintenance WHERE id = 1`);
    cached = null;
    throw AppError.conflict('Other changes are still being saved. Try again in a moment.', 'MAINTENANCE_BUSY');
  }
  let sessionsEnded = 0;
  if (opts.keepSessions) {
    keepSessionsFor = holder.sessionChainId;
  } else {
    keepSessionsFor = null;
    const ended = await db.execute(sql`DELETE FROM sessions WHERE chain_id <> ${holder.sessionChainId} RETURNING id`);
    sessionsEnded = ended.rows.length;
  }
  await auditMaintenance('maintenance_start', { sessionsEnded, keepSessions: !!opts.keepSessions }, holder.userId);
  return cached;
}

/**
 * Ends the hold (the holder only): other sessions end (not for a
 * keepSessions hold) and the row goes, in one transaction.
 */
export async function endMaintenance(holder: { sessionChainId: string | undefined; userId: string }): Promise<void> {
  const hold = await currentHold();
  if (!hold) return;
  if (hold.holderSession !== holder.sessionChainId) throw AppError.forbidden('Only the session that started maintenance can end it.', 'NOT_MAINTENANCE_HOLDER');
  const keep = keepSessionsFor === hold.holderSession;
  await db.transaction(async (tx) => {
    if (!keep) await tx.execute(sql`DELETE FROM sessions WHERE chain_id <> ${hold.holderSession}`);
    await tx.execute(sql`DELETE FROM desktop_maintenance WHERE id = 1`);
  });
  cached = null;
  keepSessionsFor = null;
  await auditMaintenance('maintenance_end', { keepSessions: keep }, holder.userId);
}

/** Clears any hold (the host app, after a file-level restore). */
export async function resetMaintenance(): Promise<boolean> {
  const r = await db.execute(sql`DELETE FROM desktop_maintenance RETURNING holder_session`);
  cached = null;
  keepSessionsFor = null;
  // A file-level restore moved the books under every client: they reload (changes-v1).
  await db.execute(sql`UPDATE change_feed_state SET epoch = gen_random_uuid() WHERE id = 1`);
  if (r.rows.length > 0) await auditMaintenance('maintenance_reset', {});
  return r.rows.length > 0;
}

/**
 * Route guard for restore, import, undo and rollback (Q-P33y): in LAN mode
 * the caller must hold maintenance, else 409 MAINTENANCE_REQUIRED. Desktop
 * without LAN and the server: no change.
 */
export function requireMaintenanceInLan() {
  return async function clRequireMaintenance(req: Request, _res: Response, next: NextFunction): Promise<void> {
    if (isDesktop() && desktopProfile().lan) {
      const hold = await currentHold();
      if (!hold || bearerSid(req) !== hold.holderSession) {
        throw AppError.conflict('Turn on maintenance mode first, so nobody else is changing the books.', 'MAINTENANCE_REQUIRED');
      }
    }
    next();
  };
}
