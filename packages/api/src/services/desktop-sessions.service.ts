// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

/**
 * Desktop sign-ins (U-290, lan-sessions-v1): list and end the sessions of
 * this install, and record the host app's LAN events in the audit trail.
 * Desktop mode only (the routes live under /api/v1/desktop, host-only).
 *
 * A session is a chain (`sessions.chain_id`): the sign-in and every refresh
 * rotation after it. Ending it deletes its rows; in LAN mode the access
 * tokens carrying that chain (`sid`) stop working at their next request.
 */

import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { sessions } from '../db/schema/index.js';
import { auditLog } from '../middleware/audit.js';
import { getWorkspaceTenantId } from '../desktop/workspace.js';
import { AppError } from '../utils/errors.js';

export interface DesktopSession {
  /** The session chain id (the access token's `sid`). */
  id: string;
  userId: string;
  email: string;
  displayName: string | null;
  /** LAN device fingerprint; null for the host app. */
  deviceId: string | null;
  signedInAt: string;
  lastRefreshAt: string;
  expiresAt: string;
  /** The caller's own session. */
  current: boolean;
}

function iso(v: unknown): string {
  return (v instanceof Date ? v : new Date(String(v))).toISOString();
}

/** Every live session of the install, newest refresh first. */
export async function listSessions(callerSid: string | undefined): Promise<DesktopSession[]> {
  const rows = await db.execute(sql`
    SELECT s.chain_id, s.user_id, u.email, u.display_name, s.device_id,
           MIN(COALESCE(s.auth_time, s.created_at)) AS signed_in_at,
           MAX(s.created_at) AS last_refresh_at,
           MAX(s.expires_at) AS expires_at
      FROM sessions s
      JOIN users u ON u.id = s.user_id
     WHERE s.expires_at > NOW()
     GROUP BY s.chain_id, s.user_id, u.email, u.display_name, s.device_id
     ORDER BY MAX(s.created_at) DESC`);
  return (rows.rows as Array<Record<string, unknown>>).map((r) => ({
    id: String(r['chain_id']),
    userId: String(r['user_id']),
    email: String(r['email']),
    displayName: (r['display_name'] as string | null) ?? null,
    deviceId: (r['device_id'] as string | null) ?? null,
    signedInAt: iso(r['signed_in_at']),
    lastRefreshAt: iso(r['last_refresh_at']),
    expiresAt: iso(r['expires_at']),
    current: callerSid !== undefined && String(r['chain_id']) === callerSid,
  }));
}

/** Ends one session chain. 404 when no live row has it. */
export async function revokeSession(chainId: string, actor: { tenantId: string; userId: string }): Promise<number> {
  const gone = await db.delete(sessions).where(eq(sessions.chainId, chainId)).returning({ userId: sessions.userId });
  if (gone.length === 0) throw AppError.notFound('Session not found');
  await auditLog(actor.tenantId, 'delete', 'session', null, { sessionId: chainId, userId: gone[0]!.userId }, null, actor.userId);
  return gone.length;
}

/** Ends every session created from one LAN device (the device was removed). */
export async function revokeDeviceSessions(deviceId: string, actor: { tenantId: string; userId: string }): Promise<number> {
  const gone = await db.delete(sessions).where(and(eq(sessions.deviceId, deviceId))).returning({ id: sessions.id });
  await auditLog(actor.tenantId, 'delete', 'session', null, { deviceId, sessions: gone.length }, null, actor.userId);
  return gone.length;
}

export const LAN_AUDIT_EVENTS = [
  'lan_device_paired',
  'lan_device_removed',
  'lan_host_key_regenerated',
  'lan_host_mode_on',
  'lan_host_mode_off',
] as const;
export type LanAuditEvent = (typeof LAN_AUDIT_EVENTS)[number];

/**
 * One audit row for a LAN event of the host app (pairing, Remove,
 * Regenerate, host mode on and off), in the workspace (M7). No amounts,
 * names or memos: the event, the device fingerprint and a short label.
 */
export async function recordLanEvent(input: { event: LanAuditEvent; deviceId?: string; label?: string }): Promise<void> {
  const tenantId = await getWorkspaceTenantId();
  if (!tenantId) throw AppError.conflict('Set up this computer first.', 'NOT_INITIALIZED');
  await auditLog(tenantId, 'create', 'lan_event', null, null, {
    event: input.event,
    ...(input.deviceId ? { deviceId: input.deviceId } : {}),
    ...(input.label ? { label: input.label } : {}),
  });
}
