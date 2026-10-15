// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * Whether the engine's database role is a PostgreSQL superuser. The engine
 * only needs to own its database (no migration creates extensions or
 * needs superuser), so desktop installs run as a NOSUPERUSER owner role.
 * Desktop preflight warns when the role is a superuser and refuses to
 * start under CL_REQUIRE_NON_SUPERUSER=1. Cached after the first
 * successful read; /health and /api/v1/desktop/info report it.
 */

import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';

let cached: boolean | null = null;

export async function readDbSuperuser(): Promise<boolean> {
  if (cached !== null) return cached;
  const res = await db.execute(
    sql`SELECT rolsuper FROM pg_roles WHERE rolname = current_user`,
  );
  const row = (res.rows[0] as { rolsuper?: boolean } | undefined) ?? {};
  cached = row.rolsuper === true;
  return cached;
}

/** Last known value without touching the database (null = never read). */
export function cachedDbSuperuser(): boolean | null {
  return cached;
}

/** Test hook. */
export function _resetDbRoleCacheForTests(): void {
  cached = null;
}
