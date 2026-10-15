// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * What the engine's database role may do beyond owning its database. The
 * engine only needs to own its database (no migration creates extensions or
 * needs superuser), so desktop installs run as a NOSUPERUSER owner role.
 *
 * Dangerous (desktop preflight warns; CL_REQUIRE_NON_SUPERUSER=1 refuses
 * to start): the role is a superuser, is a member (directly or through
 * other roles) of a superuser role, or is a member of one of the roles
 * that reach the server's files and programs (pg_execute_server_program,
 * pg_read_server_files, pg_write_server_files). Any of them turns a SQL
 * injection into code execution or file access on the machine.
 *
 * Warned about only: CREATEROLE, REPLICATION, BYPASSRLS.
 *
 * Cached after the first successful read; /health (desktop) and
 * /api/v1/desktop/info report it.
 */

import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';

export const SERVER_FILE_ROLES = [
  'pg_execute_server_program',
  'pg_read_server_files',
  'pg_write_server_files',
] as const;

export interface DbRoleReport {
  /** rolsuper, or a member of a role that has it. */
  superuser: boolean;
  /**
   * Dangerous findings, in a fixed order: `superuser`,
   * `member_of_superuser`, then the server-file roles held.
   */
  dangerous: string[];
  /** Warn-only attributes: `createrole`, `replication`, `bypassrls`. */
  warnings: string[];
}

/**
 * One row for current_user. pg_has_role(..., 'MEMBER') follows memberships
 * transitively, whatever their INHERIT/SET options. A superuser is a member
 * of every role, so the server-file roles also show up for it.
 */
export const DB_ROLE_QUERY = `
  SELECT r.rolsuper, r.rolcreaterole, r.rolreplication, r.rolbypassrls,
    EXISTS (
      SELECT 1 FROM pg_roles s
      WHERE s.rolsuper AND s.oid <> r.oid AND pg_has_role(r.oid, s.oid, 'MEMBER')
    ) AS member_of_superuser,
    ARRAY(
      SELECT f.rolname::text FROM pg_roles f
      WHERE f.rolname IN ('pg_execute_server_program', 'pg_read_server_files', 'pg_write_server_files')
        AND pg_has_role(r.oid, f.oid, 'MEMBER')
      ORDER BY f.rolname
    ) AS server_file_roles
  FROM pg_roles r
  WHERE r.rolname = current_user
`;

export interface RoleRow {
  rolsuper: boolean;
  rolcreaterole: boolean;
  rolreplication: boolean;
  rolbypassrls: boolean;
  member_of_superuser: boolean;
  server_file_roles: string[] | null;
}

let cached: DbRoleReport | null = null;

/** Pure: the report for one pg_roles row (exported for tests). */
export function classifyDbRole(row: RoleRow): DbRoleReport {
  const dangerous: string[] = [];
  if (row.rolsuper) dangerous.push('superuser');
  if (row.member_of_superuser) dangerous.push('member_of_superuser');
  for (const r of SERVER_FILE_ROLES) {
    if (row.server_file_roles?.includes(r)) dangerous.push(r);
  }
  const warnings: string[] = [];
  if (row.rolcreaterole) warnings.push('createrole');
  if (row.rolreplication) warnings.push('replication');
  if (row.rolbypassrls) warnings.push('bypassrls');
  return { superuser: row.rolsuper || row.member_of_superuser, dangerous, warnings };
}

export async function readDbRole(): Promise<DbRoleReport> {
  if (cached !== null) return cached;
  const res = await db.execute(sql.raw(DB_ROLE_QUERY));
  const row = res.rows[0] as RoleRow | undefined;
  if (!row) throw new Error('current_user not found in pg_roles');
  cached = classifyDbRole(row);
  return cached;
}

/** Superuser or superuser member (kept for callers that need one flag). */
export async function readDbSuperuser(): Promise<boolean> {
  return (await readDbRole()).superuser;
}

/** Last known value without touching the database (null = never read). */
export function cachedDbSuperuser(): boolean | null {
  return cached ? cached.superuser : null;
}

/** Test hook. */
export function _resetDbRoleCacheForTests(): void {
  cached = null;
}
