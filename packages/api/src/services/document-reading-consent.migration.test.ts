// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// U-92d: migration 0234 adds the two document reading switches, off, to
// every company (a P17 receipt_ocr consenter included), keeps a choice
// already made when applied twice, and rolls back cleanly. The forward file
// is applied again at the end so the rest of the suite sees the schema.

import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { companies } from '../db/schema/index.js';
import { makeCompany, cleanTenant } from './templates/templates.test-helpers.js';

const MIGRATIONS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');

async function run(file: string): Promise<void> {
  const text = readFileSync(path.join(MIGRATIONS, file), 'utf8');
  for (const stmt of text.split('--> statement-breakpoint')) {
    const body = stmt.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').trim();
    if (body) await db.execute(sql.raw(body));
  }
}

async function columnDefault(): Promise<string> {
  const r = await db.execute(sql`SELECT column_default AS d FROM information_schema.columns
    WHERE table_name = 'companies' AND column_name = 'ai_enabled_tasks'`);
  return String((r.rows[0] as { d: string }).d);
}

async function tasks(id: string): Promise<Record<string, boolean>> {
  const row = await db.query.companies.findFirst({ where: eq(companies.id, id) });
  return row!.aiEnabledTasks as Record<string, boolean>;
}

const OLD = { categorization: true, receipt_ocr: true, statement_parsing: false, document_classification: true };
const tenantIds: string[] = [];

afterAll(async () => {
  if (!(await columnDefault()).includes('document_text_cloud')) await run('0234_document_reading_consent.sql');
  while (tenantIds.length) await cleanTenant(tenantIds.pop()!);
});

describe('migration 0234 document reading consent', () => {
  it('is additive and listed after 0233', () => {
    const fwd = readFileSync(path.join(MIGRATIONS, '0234_document_reading_consent.sql'), 'utf8');
    expect(fwd).not.toMatch(/drop\s+(table|column|constraint)/i);
    expect(fwd).not.toMatch(/rename/i);
    const journal = JSON.parse(readFileSync(path.join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as { entries: Array<{ idx: number; tag: string; when: number }> };
    const entry = journal.entries.find((e) => e.tag === '0234_document_reading_consent');
    expect(entry?.idx).toBe(234);
    expect(entry!.when).toBeGreaterThan(journal.entries.find((e) => e.idx === 233)!.when);
  });

  it('a P17 receipt_ocr consenter gets both switches off; rollback removes them; applying twice keeps a choice', async () => {
    const a = await makeCompany('u92d-a', tenantIds);
    const b = await makeCompany('u92d-b', tenantIds);

    // The state before 0234: the four-key JSON with receipt_ocr on.
    await run('0234_document_reading_consent.rollback.sql');
    expect(await columnDefault()).not.toContain('document_text_cloud');
    await db.update(companies).set({ aiEnabled: true, aiEnabledTasks: OLD }).where(eq(companies.id, a.companyId));
    await db.update(companies).set({ aiEnabledTasks: OLD }).where(eq(companies.id, b.companyId));
    expect(await tasks(a.companyId)).toEqual(OLD);

    await run('0234_document_reading_consent.sql');
    expect(await tasks(a.companyId)).toEqual({ ...OLD, document_text_cloud: false, document_images_cloud: false });
    expect(await columnDefault()).toContain('"document_images_cloud": false');

    // A choice made after the upgrade survives a second application.
    await db.update(companies).set({ aiEnabledTasks: { ...OLD, document_text_cloud: true, document_images_cloud: false } })
      .where(eq(companies.id, b.companyId));
    await run('0234_document_reading_consent.sql');
    expect((await tasks(b.companyId))['document_text_cloud']).toBe(true);

    // Rollback strips both keys from every company and restores the old default.
    await run('0234_document_reading_consent.rollback.sql');
    expect(await tasks(a.companyId)).toEqual(OLD);
    expect(await tasks(b.companyId)).toEqual(OLD);
    expect(await columnDefault()).not.toContain('document_text_cloud');

    await run('0234_document_reading_consent.sql');
    expect(await tasks(b.companyId)).toEqual({ ...OLD, document_text_cloud: false, document_images_cloud: false });
  });

  it('a company created after the migration starts with both switches off', async () => {
    const c = await makeCompany('u92d-c', tenantIds);
    const t = await tasks(c.companyId);
    expect(t['document_text_cloud']).toBe(false);
    expect(t['document_images_cloud']).toBe(false);
  });
});
