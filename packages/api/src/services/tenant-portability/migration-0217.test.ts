// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Migration 0217 (tenant_archive_imports): additive, reversible, and the
// rollback leaves nothing behind. The forward file is re-applied at the end
// so the rest of the suite sees the table.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { db } from '../../db/index.js';

const MIGRATIONS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'db', 'migrations');

async function run(file: string): Promise<void> {
  const text = readFileSync(path.join(MIGRATIONS, file), 'utf8');
  for (const stmt of text.split('--> statement-breakpoint')) {
    const body = stmt.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').trim();
    if (body) await db.execute(sql.raw(body));
  }
}

async function tableExists(): Promise<boolean> {
  const r = await db.execute(sql`SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'tenant_archive_imports'`);
  return r.rows.length === 1;
}

describe('migration 0217 tenant_archive_imports', () => {
  it('has the planned columns, cascades from tenants and carries no money column', async () => {
    expect(await tableExists()).toBe(true);
    const cols = (await db.execute(sql`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'tenant_archive_imports' ORDER BY ordinal_position
    `)).rows as Array<{ column_name: string; data_type: string; is_nullable: string }>;
    expect(cols.map((c) => c.column_name)).toEqual([
      'tenant_id', 'scratch', 'source_tenant_id', 'archive_id', 'archive_sha256',
      'fingerprint', 'created_user_ids', 'imported_by', 'imported_at',
    ]);
    expect(cols.filter((c) => c.data_type === 'numeric')).toEqual([]);
    const fk = (await db.execute(sql`
      SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conrelid = 'tenant_archive_imports'::regclass AND contype = 'f'
    `)).rows as Array<{ def: string }>;
    expect(fk.map((f) => f.def)).toEqual(['FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE']);
  });

  it('is forward-only additive (no policy marker needed) and rolls back cleanly', async () => {
    const fwd = readFileSync(path.join(MIGRATIONS, '0217_tenant_archive_imports.sql'), 'utf8');
    expect(fwd).not.toMatch(/migration-policy: non-additive-exception/);
    expect(fwd).not.toMatch(/drop\s+(table|column)/i);
    await run('0217_tenant_archive_imports.rollback.sql');
    try {
      expect(await tableExists()).toBe(false);
      const idx = await db.execute(sql`SELECT 1 FROM pg_indexes WHERE indexname = 'idx_tenant_archive_imports_scratch'`);
      expect(idx.rows.length).toBe(0);
    } finally {
      await run('0217_tenant_archive_imports.sql');
    }
    expect(await tableExists()).toBe(true);
    // Idempotent: applying the forward file twice is a no-op.
    await run('0217_tenant_archive_imports.sql');
    expect(await tableExists()).toBe(true);
  });
});
