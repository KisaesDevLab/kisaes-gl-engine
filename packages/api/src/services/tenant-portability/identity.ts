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
 * Only a super admin creates user rows (`createUsers`). For any other
 * caller unmatched archived users are skipped (warning
 * `USERS_NOT_CREATED:<n>`), their access rows are dropped, and the caller
 * is granted `owner` on the new tenant; matched users still get their
 * archived access rows. Archived `role`, `user_type` and access roles are
 * validated against the closed lists below before any insert (an archive
 * never mints a role the engine does not know).
 *
 * Scratch mode (E5b) is not available here: the caller refuses it first.
 */

import crypto from 'node:crypto';
import { TENANT_ACCESS_ROLES } from '@kis-books/shared';
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
  /** Whether unmatched archived users may be created (super admin callers only). */
  createUsers: boolean;
}

export interface IdentityResult {
  matched: string[];
  created: string[];
  /** Archived user ids (lower-cased) skipped because the caller may not create users. */
  skipped: string[];
  /** row_to_json of every matched user before the import (verified unchanged afterwards). */
  matchedRowsBefore: Record<string, string>;
  accessRows: number;
  callerAccessAdded: boolean;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Roles an archived user row or access row may carry (closed list; `users.role` and `user_tenant_access.role`). */
export const ARCHIVE_USER_ROLES: readonly string[] = TENANT_ACCESS_ROLES;
/** `users.user_type` values an archive may carry. */
export const ARCHIVE_USER_TYPES: readonly string[] = ['staff', 'client'];
const EMAIL_MAX = 255;
const DISPLAY_NAME_MAX = 255;
const PASSWORD_HASH_MAX = 255;

function isBoolOrNull(v: unknown): v is boolean | null | undefined {
  return v === null || v === undefined || typeof v === 'boolean';
}

/** Shape and vocabulary check of one archived user row; throws ARCHIVE_CORRUPT. */
export function validateArchivedUser(u: ArchivedUser): void {
  const bad = (what: string): never => {
    throw new ArchiveError('ARCHIVE_CORRUPT', `The archive is damaged (users projection: ${what}).`);
  };
  if (!UUID_RE.test(u.id)) bad('id');
  if (typeof u.email !== 'string' || u.email.trim().length === 0 || u.email.length > EMAIL_MAX || /[\u0000-\u001f\u007f]/.test(u.email)) bad('email');
  if (typeof u.password_hash !== 'string' || u.password_hash.length === 0 || u.password_hash.length > PASSWORD_HASH_MAX) bad('password_hash');
  if (u.display_name !== null && u.display_name !== undefined && (typeof u.display_name !== 'string' || u.display_name.length > DISPLAY_NAME_MAX)) bad('display_name');
  if (typeof u.role !== 'string' || !ARCHIVE_USER_ROLES.includes(u.role)) bad('role');
  if (typeof u.user_type !== 'string' || !ARCHIVE_USER_TYPES.includes(u.user_type)) bad('user_type');
  if (!isBoolOrNull(u.is_active)) bad('is_active');
}

/** Shape and vocabulary check of one archived access row; throws ARCHIVE_CORRUPT. */
export function validateArchivedAccess(a: ArchivedAccess): void {
  const bad = (what: string): never => {
    throw new ArchiveError('ARCHIVE_CORRUPT', `The archive is damaged (access rows: ${what}).`);
  };
  if (!UUID_RE.test(a.id)) bad('id');
  if (!UUID_RE.test(a.user_id)) bad('user_id');
  if (!UUID_RE.test(a.tenant_id)) bad('tenant_id');
  if (typeof a.role !== 'string' || !ARCHIVE_USER_ROLES.includes(a.role)) bad('role');
  if (!isBoolOrNull(a.is_active)) bad('is_active');
}

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
  const result: IdentityResult = { matched: [], created: [], skipped: [], matchedRowsBefore: {}, accessRows: 0, callerAccessAdded: false };
  // Validate every identity row before the first insert (fail closed).
  for (const u of input.users) validateArchivedUser(u);
  for (const a of input.access) validateArchivedAccess(a);
  const skippedUsers = new Set<string>();
  for (const u of input.users) {
    const email = normalizeEmail(u.email);
    const existing = (await client.query('SELECT id FROM users WHERE lower(email) = $1 ORDER BY created_at LIMIT 1', [email])).rows[0] as { id: string } | undefined;
    if (existing) {
      // Never modified; the archived id maps to the existing id (or stays when equal).
      if (existing.id.toLowerCase() !== u.id.toLowerCase()) idMap.set(u.id, existing.id);
      result.matched.push(existing.id);
      result.matchedRowsBefore[existing.id] = await userRowJson(client, existing.id);
      continue;
    }
    if (!input.createUsers) {
      // Only a super admin creates users; everyone else restores the books and grants themselves.
      skippedUsers.add(u.id.toLowerCase());
      result.skipped.push(u.id.toLowerCase());
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
    if (skippedUsers.has(a.user_id.toLowerCase())) continue; // user not created: no access row either
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

/**
 * Password hash placeholder (H4). An archive carries a user's bcrypt hash
 * only when the exporting caller is a super admin and the user is not one;
 * every other hash is replaced by this value, which no bcrypt comparison
 * ever matches, so a user created from it must have a password set again
 * before logging in. The owner is matched by email on import and is never
 * modified, so the owner's own password is unaffected.
 */
export const ARCHIVE_PASSWORD_PLACEHOLDER = '!archived:password-reset-required';

/**
 * The users projection SELECT list for the export, over alias `u`.
 * `includeHashesParam` is the SQL placeholder (e.g. `$2`) of a boolean:
 * true when the caller may export hashes (super admin).
 */
export function usersProjectionSql(includeHashesParam: string): string {
  return USERS_PROJECTION.map((c) => (
    c === 'password_hash'
      ? `CASE WHEN ${includeHashesParam}::boolean AND NOT u.is_super_admin THEN u.password_hash ELSE '${ARCHIVE_PASSWORD_PLACEHOLDER}' END AS "password_hash"`
      : `u."${c}"`
  )).join(', ');
}

/** The users projection columns, for a plain SELECT (verification). */
export const USERS_PROJECTION_SQL = USERS_PROJECTION.map((c) => `u."${c}"`).join(', ');
