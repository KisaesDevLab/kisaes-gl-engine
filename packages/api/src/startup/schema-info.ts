// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * Applied schema version for /health: the number of applied drizzle
 * migrations and the journal tag of the newest one. Read from the
 * database once and cached (only a successful read is cached, so a probe
 * during a database outage retries next time).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { MIGRATIONS_FOLDER } from './migrations.js';

export interface SchemaInfo {
  /** Count of applied migrations. */
  version: number;
  /** Journal tag of the most recently applied migration, e.g. "0215_x". */
  tag: string | null;
}

let cached: SchemaInfo | null = null;

interface Journal {
  entries: Array<{ idx: number; tag: string; when: number }>;
}

export async function readSchemaInfo(folder: string = MIGRATIONS_FOLDER): Promise<SchemaInfo> {
  if (cached) return cached;
  const res = await db.execute(
    sql`SELECT count(*)::int AS n, max(created_at)::text AS last FROM "drizzle"."__drizzle_migrations"`,
  );
  const row = (res.rows[0] as { n?: number; last?: string | null } | undefined) ?? {};
  const version = Number(row.n ?? 0);
  let tag: string | null = null;
  try {
    const journal = JSON.parse(readFileSync(resolve(folder, 'meta', '_journal.json'), 'utf8')) as Journal;
    // drizzle stores the journal entry's `when` as created_at.
    tag = journal.entries.find((e) => String(e.when) === row.last)?.tag ?? null;
  } catch {
    tag = null;
  }
  cached = { version, tag };
  return cached;
}

/** Test hook. */
export function _resetSchemaInfoCacheForTests(): void {
  cached = null;
}
