// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.
//
// U-118: migration 0274 adds report_definitions and report_definition_groups
// (new, empty tables). It is listed after 0273 and additive; kind is limited
// by the named CHECK report_definitions_kind_check (0276 widens it to
// 'builder'); live names are unique per company, case-insensitive; the
// rollback drops both tables; applying the forward file twice changes
// nothing. The forward files (0274, then 0276) are applied again at the end
// so the rest of the suite sees the schema.

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

async function hasTables(): Promise<boolean> {
  const r = await db.execute(sql`SELECT count(*)::int AS n FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name IN ('report_definitions', 'report_definition_groups')`);
  return (r.rows[0] as { n: number }).n === 2;
}

const tenantIds: string[] = [];

afterAll(async () => {
  if (!(await hasTables())) await run('0274_report_definitions.sql');
  await run('0276_report_definitions_builder.sql');
  while (tenantIds.length) await cleanTenant(tenantIds.pop()!);
});

describe('migration 0274 report definitions', () => {
  it('is listed after 0273 and is additive', () => {
    const fwd = readFileSync(path.join(MIGRATIONS, '0274_report_definitions.sql'), 'utf8');
    expect(fwd).not.toMatch(/migration-policy/);
    expect(fwd).not.toMatch(/drop\s+(table|column)/i);
    expect(fwd).toMatch(/CONSTRAINT "report_definitions_kind_check" CHECK \("kind" IN \('standard'\)\)/);
    const journal = JSON.parse(readFileSync(path.join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as { entries: Array<{ idx: number; tag: string; when: number }> };
    const entry = journal.entries.find((e) => e.tag === '0274_report_definitions');
    expect(entry?.idx).toBe(274);
    expect(entry!.when).toBeGreaterThan(journal.entries.find((e) => e.idx === 273)!.when);
  });

  it('kind check, live-name uniqueness; rollback drops the tables; forward twice is a no-op', async () => {
    const co = await makeCompany('u118m', tenantIds);
    const ins = (name: string, kind = 'standard', deleted = false) => db.execute(sql`
      INSERT INTO report_definitions (id, tenant_id, company_id, name, kind, definition_json, deleted_at)
      VALUES (${crypto.randomUUID()}, ${co.tenantId}, ${co.companyId}, ${name}, ${kind},
        ${JSON.stringify({ schemaVersion: 1, kind, reportKey: 'pl', options: {} })}::jsonb, ${deleted ? sql`now()` : sql`NULL`})`);
    await ins('Monthly', 'standard', true);
    await ins('Monthly');
    await expect(ins('MONTHLY')).rejects.toThrow();
    await expect(ins('Other one', 'other')).rejects.toThrow();
    await ins('Monthly', 'standard', false).catch(() => undefined);
    const n = await db.execute(sql`SELECT count(*)::int AS n FROM report_definitions WHERE tenant_id = ${co.tenantId}`);
    expect((n.rows[0] as { n: number }).n).toBe(2);
    await db.execute(sql`DELETE FROM report_definitions WHERE tenant_id = ${co.tenantId}`);

    await run('0274_report_definitions.rollback.sql');
    expect(await hasTables()).toBe(false);
    await run('0274_report_definitions.sql');
    await run('0274_report_definitions.sql');
    expect(await hasTables()).toBe(true);
    await run('0276_report_definitions_builder.sql');
  });
});
