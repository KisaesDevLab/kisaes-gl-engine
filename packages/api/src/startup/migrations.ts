// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

/**
 * Migration helpers used by both the auto-migrate boot path (when
 * MIGRATIONS_AUTO=true, the default) and the standalone `migrate.ts`
 * entrypoint that the appliance compose invokes as a one-shot
 * container.
 *
 * The `hasPendingMigrations` check uses count comparison between the
 * drizzle journal and the `drizzle.__drizzle_migrations` table. Counts
 * being equal does not guarantee the *content* matches (a manual edit
 * could leave the count right but hashes wrong), but for the boot-time
 * "should we refuse to start" decision count is good enough — drizzle's
 * own `migrate()` does the hash-level reconciliation when it runs.
 */

import { sql } from 'drizzle-orm';
import { migrate as drizzleMigrate } from 'drizzle-orm/node-postgres/migrator';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from '../db/index.js';

interface MigrationsJournal {
  entries: Array<{ idx: number; tag: string; when: number }>;
}

/**
 * Resolve the migrations folder relative to this source file so
 * `npm run migrate` works regardless of which directory the operator
 * invokes it from.
 */
function defaultMigrationsFolder(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', 'db', 'migrations');
}

function readJournal(folder: string): MigrationsJournal {
  const journalPath = resolve(folder, 'meta', '_journal.json');
  const raw = readFileSync(journalPath, 'utf8');
  return JSON.parse(raw) as MigrationsJournal;
}

export interface PendingMigrationStatus {
  pending: boolean;
  applied: number;
  total: number;
}

/**
 * Returns the journaled-vs-applied counts and whether there are
 * pending migrations. Catches the table-missing case (fresh DB) and
 * reports `applied: 0`.
 */
export async function checkPendingMigrations(
  folder: string = defaultMigrationsFolder(),
): Promise<PendingMigrationStatus> {
  const journal = readJournal(folder);
  const total = journal.entries.length;

  let applied = 0;
  try {
    const result = await db.execute(
      sql`SELECT count(*)::int AS n FROM "drizzle"."__drizzle_migrations"`,
    );
    const row = (result.rows[0] as { n?: number } | undefined) ?? {};
    applied = Number(row.n ?? 0);
  } catch {
    // Table or schema missing — fresh DB, nothing applied yet.
    applied = 0;
  }

  return { pending: applied < total, applied, total };
}

/**
 * Apply all pending migrations. Idempotent — drizzle skips migrations
 * already recorded in `drizzle.__drizzle_migrations`.
 */
export async function applyMigrations(
  folder: string = defaultMigrationsFolder(),
): Promise<void> {
  await drizzleMigrate(db, { migrationsFolder: folder });
}

/**
 * Default migrations folder. Exposed so callers (including tests) can
 * reach the resolved absolute path without re-deriving it.
 */
export const MIGRATIONS_FOLDER = defaultMigrationsFolder();
