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
 *     MAINTENANCE_BUSY), then every other session ends;
 *   - while on: every request but the holder's gets 503 MAINTENANCE (probes,
 *     GET /desktop/info and the reset excepted); only the holder's user can
 *     sign in and only the holder's chain can refresh;
 *   - end: other sessions are ended and the row removed in one transaction;
 *   - reset: the host app clears it after a file-level restore (a restored
 *     dump may carry a row with a holder that no longer exists).
 * The row lives in desktop_maintenance (migration 0288), so it survives an
 * engine restart; this module caches it (one engine process per database).
 *
 * Desktop mode only. The server appliance never mounts any of it.
 */

import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { env } from '../config/env.js';
import { AppError } from '../utils/errors.js';
import { auditLog } from '../middleware/audit.js';
import { desktopProfile, isDesktop } from './profile.js';
import { getWorkspaceTenantId } from './workspace.js';

export interface MaintenanceHold {
  holderSession: string;
  holderUser: string;
  startedAt: string;
}

let cached: MaintenanceHold | null | undefined; // undefined: not loaded yet
let inFlightWrites = 0;
const DRAIN_MS = 30_000;

const WRITE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** The current hold (loaded from the database once per process). */
export async function currentHold(): Promise<MaintenanceHold | null> {
  if (cached !== undefined) return cached;
  const r = await db.execute(sql`SELECT holder_session, holder_user, started_at FROM desktop_maintenance WHERE id = 1`);
  const row = r.rows[0] as { holder_session: string; holder_user: string; started_at: Date | string } | undefined;
  cached = row
    ? { holderSession: row.holder_session, holderUser: row.holder_user, startedAt: new Date(row.started_at).toISOString() }
    : null;
  return cached;
}

/** Test hook: forget the cached hold. */
export function _forgetMaintenanceCache(): void {
  cached = undefined;
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
    if (WRITE.has(req.method)) {
      inFlightWrites += 1;
      let done = false;
      const finish = () => {
        if (!done) {
          done = true;
          inFlightWrites -= 1;
        }
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

/** Starts a hold for the caller's session (super admin, checked by the route). */
export async function startMaintenance(holder: { sessionChainId: string | undefined; userId: string }): Promise<MaintenanceHold> {
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
  // Drain: wait for the other writes in flight (this request is one of them).
  const deadline = Date.now() + DRAIN_MS;
  while (inFlightWrites > 1 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  if (inFlightWrites > 1) {
    await db.execute(sql`DELETE FROM desktop_maintenance WHERE id = 1`);
    cached = null;
    throw AppError.conflict('Other changes are still being saved. Try again in a moment.', 'MAINTENANCE_BUSY');
  }
  const ended = await db.execute(sql`DELETE FROM sessions WHERE chain_id <> ${holder.sessionChainId} RETURNING id`);
  await auditMaintenance('maintenance_start', { sessionsEnded: ended.rows.length }, holder.userId);
  return cached;
}

/** Ends the hold (the holder only): other sessions end and the row goes, in one transaction. */
export async function endMaintenance(holder: { sessionChainId: string | undefined; userId: string }): Promise<void> {
  const hold = await currentHold();
  if (!hold) return;
  if (hold.holderSession !== holder.sessionChainId) throw AppError.forbidden('Only the session that started maintenance can end it.', 'NOT_MAINTENANCE_HOLDER');
  await db.transaction(async (tx) => {
    await tx.execute(sql`DELETE FROM sessions WHERE chain_id <> ${hold.holderSession}`);
    await tx.execute(sql`DELETE FROM desktop_maintenance WHERE id = 1`);
  });
  cached = null;
  await auditMaintenance('maintenance_end', {}, holder.userId);
}

/** Clears any hold (the host app, after a file-level restore). */
export async function resetMaintenance(): Promise<boolean> {
  const r = await db.execute(sql`DELETE FROM desktop_maintenance RETURNING holder_session`);
  cached = null;
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
