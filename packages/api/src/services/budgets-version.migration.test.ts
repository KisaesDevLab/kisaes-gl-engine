// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.
//
// U-203: migration 0275 adds budgets.version (integer, default 1, >= 1). It
// is listed after 0274 and additive; existing rows read version 1; the
// rollback drops the column and keeps the budgets; applying the forward file
// twice changes nothing. The forward file is applied again at the end so the
// rest of the suite sees the schema.

import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { makeCompany, cleanTenant } from './templates/templates.test-helpers.js';

const MIGRATIONS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');

async function run(file: string): Promise<void> {
  const text = readFileSync(path.join(MIGRATIONS, file), 'utf8');
  for (const stmt of text.split('--> statement-breakpoint')) {
    const body = stmt.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').trim();
    if (body) await db.execute(sql.raw(body));
  }
}

async function hasColumn(): Promise<boolean> {
  const r = await db.execute(sql`SELECT count(*)::int AS n FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'budgets' AND column_name = 'version'`);
  return (r.rows[0] as { n: number }).n === 1;
}

const tenantIds: string[] = [];

afterAll(async () => {
  if (!(await hasColumn())) await run('0275_budgets_version.sql');
  for (const t of tenantIds) await db.execute(sql`DELETE FROM budgets WHERE tenant_id = ${t}`);
  while (tenantIds.length) await cleanTenant(tenantIds.pop()!);
});

describe('migration 0275 budgets.version', () => {
  it('is listed after 0274 and is additive', () => {
    const fwd = readFileSync(path.join(MIGRATIONS, '0275_budgets_version.sql'), 'utf8');
    expect(fwd).not.toMatch(/migration-policy/);
    expect(fwd).not.toMatch(/drop\s+(table|column)/i);
    expect(fwd).toMatch(/ADD COLUMN IF NOT EXISTS "version" integer DEFAULT 1 NOT NULL/);
    const journal = JSON.parse(readFileSync(path.join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as { entries: Array<{ idx: number; tag: string; when: number }> };
    const entry = journal.entries.find((e) => e.tag === '0275_budgets_version');
    expect(entry?.idx).toBe(275);
    expect(entry!.when).toBeGreaterThan(journal.entries.find((e) => e.idx === 274)!.when);
  });

  it('existing rows read 1; version >= 1; rollback keeps budgets; forward twice is a no-op', async () => {
    const co = await makeCompany('u203m', tenantIds);
    const id = crypto.randomUUID();
    await run('0275_budgets_version.rollback.sql');
    expect(await hasColumn()).toBe(false);
    // A budget saved before the column existed.
    await db.execute(sql`INSERT INTO budgets (id, tenant_id, name, fiscal_year) VALUES (${id}, ${co.tenantId}, 'Old', 2026)`);
    await run('0275_budgets_version.sql');
    await run('0275_budgets_version.sql');
    expect(await hasColumn()).toBe(true);
    const r = await db.execute(sql`SELECT version FROM budgets WHERE id = ${id}`);
    expect((r.rows[0] as { version: number }).version).toBe(1);
    await expect(db.execute(sql`UPDATE budgets SET version = 0 WHERE id = ${id}`)).rejects.toThrow();

    await run('0275_budgets_version.rollback.sql');
    const kept = await db.execute(sql`SELECT count(*)::int AS n FROM budgets WHERE id = ${id}`);
    expect((kept.rows[0] as { n: number }).n).toBe(1);
    await run('0275_budgets_version.sql');
    expect(await hasColumn()).toBe(true);
  });
});
