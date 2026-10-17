// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * Archive session settings and per-tenant advisory locks (U-05).
 *
 * Export, import, verification and the fingerprint all run with the same
 * session settings so `row_to_json` output is byte-stable across the two
 * sides: UTC timestamps, the postgres interval style, hex bytea and
 * shortest-roundtrip floats.
 */

import type pg from 'pg';
import { pool } from '../../db/index.js';

export const ARCHIVE_SESSION: ReadonlyArray<readonly [string, string]> = [
  ['TimeZone', 'UTC'],
  ['IntervalStyle', 'postgres'],
  ['bytea_output', 'hex'],
  ['extra_float_digits', '3'],
];

export type ArchiveClient = pg.PoolClient;

/** Apply ARCHIVE_SESSION. `local` uses SET LOCAL (inside a transaction). */
export async function applyArchiveSession(client: ArchiveClient, local = true): Promise<void> {
  for (const [name, value] of ARCHIVE_SESSION) {
    await client.query(`SET ${local ? 'LOCAL ' : ''}${name} = '${value}'`);
  }
}

/**
 * Fixed int4 namespace of the per-tenant advisory lock key; the second
 * half is hashtext(tenant_id::text). A hash collision only causes a
 * spurious wait, never a wrong result.
 */
export const TENANT_LOCK_NAMESPACE = 0x434c4152; // 'CLAR'

/** Session-level shared lock (export). Released by releaseSharedTenantLock or when the connection dies. */
export async function acquireSharedTenantLock(client: ArchiveClient, tenantId: string): Promise<void> {
  await client.query('SELECT pg_advisory_lock_shared($1, hashtext($2::text))', [TENANT_LOCK_NAMESPACE, tenantId]);
}

export async function releaseSharedTenantLock(client: ArchiveClient, tenantId: string): Promise<void> {
  await client.query('SELECT pg_advisory_unlock_shared($1, hashtext($2::text))', [TENANT_LOCK_NAMESPACE, tenantId]);
}

/** Transaction-level exclusive lock (import, delete). Honors lock_timeout. */
export async function xactLockTenantExclusive(client: ArchiveClient, tenantId: string): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock($1, hashtext($2::text))', [TENANT_LOCK_NAMESPACE, tenantId]);
}

/** Non-blocking probe: true when nobody holds the tenant's lock in any mode. */
export async function tryExclusiveTenantLock(client: ArchiveClient, tenantId: string): Promise<boolean> {
  const r = await client.query('SELECT pg_try_advisory_xact_lock($1, hashtext($2::text)) AS ok', [TENANT_LOCK_NAMESPACE, tenantId]);
  return Boolean((r.rows[0] as { ok: boolean }).ok);
}

/** Check out a dedicated connection from the engine pool and release it afterwards. */
export async function withArchiveConnection<T>(fn: (client: ArchiveClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let poisoned = false;
  try {
    return await fn(client);
  } catch (err) {
    poisoned = true;
    throw err;
  } finally {
    // A failed statement may leave the connection in a state the next
    // borrower should not inherit; the pool discards it when asked.
    client.release(poisoned ? new Error('archive connection discarded') : undefined);
  }
}
