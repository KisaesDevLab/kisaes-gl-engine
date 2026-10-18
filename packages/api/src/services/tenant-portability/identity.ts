// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * Identity rules of a tenant-archive import (U-05, owner decision 3).
 *
 * Users are matched by normalized email. A matched user is never modified
 * and the archived id maps to the existing id. An unmatched user is created
 * with the archived id (or a fresh one when that id belongs to a different
 * email), homed in the destination workspace (desktop) or the new tenant
 * (server), never a super admin, TFA off, lockout cleared; on desktop it
 * also gets a `readonly` workspace access row. Archived access rows are
 * inserted with mapped ids, and the importing caller gets an `owner` row
 * unless the archive already gives them access.
 *
 * Scratch mode (E5b) is not available here: the caller refuses it first.
 */

import crypto from 'node:crypto';
import { USERS_PROJECTION } from './format.js';
import type { IdMap } from './remap.js';
import type { ArchiveClient } from './session.js';
import { ArchiveError } from './errors.js';

export interface ArchivedUser {
  id: string;
  email: string;
  password_hash: string;
  display_name: string | null;
  role: string;
  user_type: string;
  is_active: boolean | null;
  display_preferences: unknown;
  created_at: string | null;
  updated_at: string | null;
}

export interface ArchivedAccess {
  id: string;
  user_id: string;
  tenant_id: string;
  role: string;
  is_active: boolean | null;
  created_at: string | null;
  last_accessed_at: string | null;
}

export interface IdentityInput {
  idMap: IdMap;
  newTenantId: string;
  /** Destination workspace (desktop) or null (server: users are homed in the new tenant). */
  workspaceTenantId: string | null;
  users: ArchivedUser[];
  access: ArchivedAccess[];
  callerUserId: string;
}

export interface IdentityResult {
  matched: string[];
  created: string[];
  /** row_to_json of every matched user before the import (verified unchanged afterwards). */
  matchedRowsBefore: Record<string, string>;
  accessRows: number;
  callerAccessAdded: boolean;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Parses an identity NDJSON line (identity rows hold no money, so JSON.parse is fine). */
export function parseIdentityLine<T>(line: string, required: readonly string[]): T {
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    throw new ArchiveError('ARCHIVE_CORRUPT', 'The archive is damaged (identity row).');
  }
  if (typeof obj !== 'object' || obj === null) throw new ArchiveError('ARCHIVE_CORRUPT', 'The archive is damaged (identity row).');
  for (const k of required) {
    if (!(k in (obj as Record<string, unknown>))) throw new ArchiveError('ARCHIVE_CORRUPT', `The archive is damaged (identity row lacks ${k}).`);
  }
  return obj as T;
}

export async function userRowJson(client: ArchiveClient, userId: string): Promise<string> {
  const r = await client.query('SELECT row_to_json(u)::text AS j FROM users u WHERE u.id = $1', [userId]);
  return (r.rows[0] as { j: string } | undefined)?.j ?? '';
}

/** Runs the identity step inside the import transaction. */
export async function applyIdentity(client: ArchiveClient, input: IdentityInput): Promise<IdentityResult> {
  const { idMap, newTenantId, workspaceTenantId } = input;
  const result: IdentityResult = { matched: [], created: [], matchedRowsBefore: {}, accessRows: 0, callerAccessAdded: false };
  for (const u of input.users) {
    if (!UUID_RE.test(u.id) || typeof u.email !== 'string' || typeof u.password_hash !== 'string') {
      throw new ArchiveError('ARCHIVE_CORRUPT', 'The archive is damaged (users projection).');
    }
    const email = normalizeEmail(u.email);
    const existing = (await client.query('SELECT id FROM users WHERE lower(email) = $1 ORDER BY created_at LIMIT 1', [email])).rows[0] as { id: string } | undefined;
    if (existing) {
      // Never modified; the archived id maps to the existing id (or stays when equal).
      if (existing.id.toLowerCase() !== u.id.toLowerCase()) idMap.set(u.id, existing.id);
      result.matched.push(existing.id);
      result.matchedRowsBefore[existing.id] = await userRowJson(client, existing.id);
      continue;
    }
    // Unmatched: the archived id, unless it belongs to a different email.
    const taken = (await client.query('SELECT 1 FROM users WHERE id = $1', [u.id])).rows.length > 0;
    const newId = taken ? idMap.fresh(u.id) : u.id.toLowerCase();
    const homeTenant = workspaceTenantId ?? newTenantId;
    await client.query(
      `INSERT INTO users (id, tenant_id, email, password_hash, display_name, role, user_type, is_active, display_preferences,
                          created_at, updated_at, is_super_admin, tfa_enabled, tfa_methods, tfa_preferred_method, tfa_phone,
                          tfa_phone_verified, tfa_totp_secret_encrypted, tfa_totp_verified, tfa_recovery_codes_encrypted,
                          tfa_recovery_codes_remaining, tfa_failed_attempts, tfa_locked_until, preferred_login_method,
                          magic_link_enabled, login_failed_attempts, login_locked_until, tfa_totp_last_step)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, COALESCE($10::timestamptz, now()), COALESCE($11::timestamptz, now()),
               false, false, '', NULL, NULL, false, NULL, false, NULL, 0, 0, NULL, 'password', false, 0, NULL, NULL)`,
      [
        newId, homeTenant, email, u.password_hash, u.display_name, u.role, u.user_type,
        u.is_active ?? true, JSON.stringify(u.display_preferences ?? { fontScale: 1, theme: 'system' }),
        u.created_at, u.updated_at,
      ],
    );
    if (workspaceTenantId) {
      await client.query(
        `INSERT INTO user_tenant_access (user_id, tenant_id, role, is_active) VALUES ($1, $2, 'readonly', true)
         ON CONFLICT (user_id, tenant_id) DO NOTHING`,
        [newId, workspaceTenantId],
      );
    }
    result.created.push(newId);
  }

  // Access rows of the company, with mapped ids.
  let callerHasAccess = false;
  for (const a of input.access) {
    const userId = idMap.get(a.user_id) ?? a.user_id.toLowerCase();
    const known = (await client.query('SELECT 1 FROM users WHERE id = $1', [userId])).rows.length > 0;
    if (!known) continue; // an access row whose user was not in the users projection (never exported): skip
    const r = await client.query(
      `INSERT INTO user_tenant_access (id, user_id, tenant_id, role, is_active, created_at, last_accessed_at)
       VALUES ($1, $2, $3, $4, $5, COALESCE($6::timestamptz, now()), $7::timestamptz)
       ON CONFLICT (user_id, tenant_id) DO NOTHING`,
      [idMap.get(a.id) ?? crypto.randomUUID(), userId, newTenantId, a.role, a.is_active ?? true, a.created_at, a.last_accessed_at],
    );
    result.accessRows += r.rowCount ?? 0;
    if (userId === input.callerUserId.toLowerCase() && (a.is_active ?? true)) callerHasAccess = true;
  }
  if (!callerHasAccess) {
    await client.query(
      `INSERT INTO user_tenant_access (user_id, tenant_id, role, is_active) VALUES ($1, $2, 'owner', true)
       ON CONFLICT (user_id, tenant_id) DO UPDATE SET is_active = true, role = 'owner'`,
      [input.callerUserId, newTenantId],
    );
    result.callerAccessAdded = true;
  }
  return result;
}

/** The users projection columns, for the export SELECT. */
export const USERS_PROJECTION_SQL = USERS_PROJECTION.map((c) => `u."${c}"`).join(', ');
