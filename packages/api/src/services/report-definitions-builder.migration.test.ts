// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.
//
// U-118 / U-119: migration 0276 widens report_definitions_kind_check to
// 'builder'. It is listed after 0275 and carries the policy marker (a
// constraint replacement); applying it twice changes nothing; its rollback
// refuses while any builder row exists (live or deleted) and otherwise
// narrows the check back to 'standard' without touching data. The forward
// file is applied again at the end so the rest of the suite sees the schema.

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

async function checkDef(): Promise<string> {
  const r = await db.execute(sql`SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = 'report_definitions_kind_check'`);
  return (r.rows[0] as { d: string }).d;
}

const tenantIds: string[] = [];

afterAll(async () => {
  await run('0276_report_definitions_builder.sql');
  while (tenantIds.length) await cleanTenant(tenantIds.pop()!);
});

describe('migration 0276 report definitions builder kind', () => {
  it('is listed after 0275 with the policy marker; widens only the kind check', () => {
    const fwd = readFileSync(path.join(MIGRATIONS, '0276_report_definitions_builder.sql'), 'utf8');
    expect(fwd.split('\n').slice(0, 10).join('\n')).toMatch(/-- migration-policy: non-additive-exception/);
    expect(fwd).not.toMatch(/drop\s+(table|column)/i);
    expect(fwd).toMatch(/CHECK \(kind IN \('standard', 'builder'\)\)/);
    const journal = JSON.parse(readFileSync(path.join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as { entries: Array<{ idx: number; tag: string; when: number }> };
    const entry = journal.entries.find((e) => e.tag === '0276_report_definitions_builder');
    expect(entry?.idx).toBe(276);
    expect(entry!.when).toBeGreaterThan(journal.entries.find((e) => e.idx === 275)!.when);
  });

  it('builder rows are accepted; the rollback refuses while one exists, then narrows the check; forward twice is a no-op', async () => {
    const co = await makeCompany('u119m', tenantIds);
    const ins = (name: string, kind: string, deleted = false) => db.execute(sql`
      INSERT INTO report_definitions (id, tenant_id, company_id, name, kind, definition_json, deleted_at)
      VALUES (${crypto.randomUUID()}, ${co.tenantId}, ${co.companyId}, ${name}, ${kind},
        ${JSON.stringify({ schemaVersion: 1, kind })}::jsonb, ${deleted ? sql`now()` : sql`NULL`})`);
    await run('0276_report_definitions_builder.sql');
    await run('0276_report_definitions_builder.sql');
    expect(await checkDef()).toMatch(/builder/);
    await ins('Standard', 'standard');
    await ins('Deleted builder', 'builder', true);
    await expect(ins('Other', 'other')).rejects.toThrow();

    // A deleted builder row is still a builder row: the rollback stops and nothing changes.
    await expect(run('0276_report_definitions_builder.rollback.sql')).rejects.toThrow(/0276/);
    expect(await checkDef()).toMatch(/builder/);

    await db.execute(sql`DELETE FROM report_definitions WHERE tenant_id = ${co.tenantId} AND kind = 'builder'`);
    await run('0276_report_definitions_builder.rollback.sql');
    expect(await checkDef()).not.toMatch(/builder/);
    await expect(ins('Builder', 'builder')).rejects.toThrow();
    const n = await db.execute(sql`SELECT count(*)::int AS n FROM report_definitions WHERE tenant_id = ${co.tenantId}`);
    expect((n.rows[0] as { n: number }).n).toBe(1);

    await run('0276_report_definitions_builder.sql');
    expect(await checkDef()).toMatch(/builder/);
    await ins('Builder', 'builder');
  });
});
