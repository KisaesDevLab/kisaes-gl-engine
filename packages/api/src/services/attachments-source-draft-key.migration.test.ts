// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.
//
// U-183: migration 0270 adds attachments.source_draft_key (nullable, no
// backfill). It is listed after 0269; the rollback drops only the column
// (rows and links stay); applying the forward file twice changes nothing.
// The forward file is applied again at the end so the rest of the suite
// sees the schema.

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
  const r = await db.execute(sql`SELECT 1 FROM information_schema.columns
    WHERE table_name = 'attachments' AND column_name = 'source_draft_key'`);
  return r.rows.length > 0;
}

const tenantIds: string[] = [];

afterAll(async () => {
  if (!(await hasColumn())) await run('0270_attachments_source_draft_key.sql');
  while (tenantIds.length) await cleanTenant(tenantIds.pop()!);
});

describe('migration 0270 attachments.source_draft_key', () => {
  it('is listed after 0269 and is additive', () => {
    const fwd = readFileSync(path.join(MIGRATIONS, '0270_attachments_source_draft_key.sql'), 'utf8');
    expect(fwd).not.toMatch(/migration-policy/);
    expect(fwd).not.toMatch(/drop\s+(table|column)/i);
    expect(fwd).toMatch(/ADD COLUMN IF NOT EXISTS source_draft_key uuid/);
    const journal = JSON.parse(readFileSync(path.join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as { entries: Array<{ idx: number; tag: string; when: number }> };
    const entry = journal.entries.find((e) => e.tag === '0270_attachments_source_draft_key');
    expect(entry?.idx).toBe(270);
    expect(entry!.when).toBeGreaterThan(journal.entries.find((e) => e.idx === 269)!.when);
  });

  it('the column is nullable; rollback keeps the rows; forward twice is a no-op', async () => {
    const co = await makeCompany('u183', tenantIds);
    const id = crypto.randomUUID();
    const key = crypto.randomUUID();
    const target = crypto.randomUUID();
    await db.execute(sql`INSERT INTO attachments (id, tenant_id, company_id, file_name, file_path, attachable_type, attachable_id, source_draft_key)
      VALUES (${id}, ${co.tenantId}, ${co.companyId}, 'a.pdf', '/uploads/a.pdf', 'expense', ${target}, ${key})`);
    const plain = crypto.randomUUID();
    await db.execute(sql`INSERT INTO attachments (id, tenant_id, file_name, file_path, attachable_type, attachable_id)
      VALUES (${plain}, ${co.tenantId}, 'b.pdf', '/uploads/b.pdf', 'draft', ${key})`);
    const k = await db.execute(sql`SELECT source_draft_key FROM attachments WHERE id = ${plain}`);
    expect((k.rows[0] as { source_draft_key: string | null }).source_draft_key).toBeNull();

    await run('0270_attachments_source_draft_key.rollback.sql');
    expect(await hasColumn()).toBe(false);
    const kept = await db.execute(sql`SELECT attachable_type, attachable_id FROM attachments WHERE id = ${id}`);
    expect(kept.rows[0]).toEqual({ attachable_type: 'expense', attachable_id: target });

    await run('0270_attachments_source_draft_key.sql');
    await run('0270_attachments_source_draft_key.sql');
    expect(await hasColumn()).toBe(true);
    await db.execute(sql`DELETE FROM attachments WHERE id IN (${id}, ${plain})`);
  });
});
