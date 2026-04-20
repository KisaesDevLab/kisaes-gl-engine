// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.
//
// Global test setup — runs once before the suite boots. We apply
// Drizzle migrations against the test database so adding a new
// migration (e.g., 0060_default_tag_sources) never leaves a stale test
// schema quietly returning Postgres 42703 "column does not exist" for
// every service test. Opt out with `SKIP_TEST_MIGRATIONS=1` when you
// know your test DB is already on head.

import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export default async function setup(): Promise<void> {
  if (process.env['SKIP_TEST_MIGRATIONS']) return;

  const databaseUrl =
    process.env['DATABASE_URL'] ||
    'postgresql://kisbooks:kisbooks@localhost:5434/kisbooks_test';

  // Resolve against the api package root so the same config works
  // whether vitest was invoked from the repo root or inside the
  // package. Skip silently when the folder doesn't exist — keeps
  // non-DB unit tests runnable on a minimal dev checkout.
  const candidates = [
    resolve(process.cwd(), 'packages/api/src/db/migrations'),
    resolve(process.cwd(), 'src/db/migrations'),
  ];
  const migrationsFolder = candidates.find((p) => existsSync(p));
  if (!migrationsFolder) return;

  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const db = drizzle(pool);
    await migrate(db, { migrationsFolder });
  } catch (err) {
    // Surface the actual reason so `column … does not exist` failures
    // are obviously migration-related rather than test-logic bugs.
    console.error('[test-global-setup] migration failed:', err);
    throw err;
  } finally {
    await pool.end();
  }
}
