// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// U-94: migration 0235 widens document_drafts_kind_ck with 'statement'
// (document-drafts-statement-v1). The constraint takes the new kind and
// still refuses others; the rollback turns statement drafts into 'unknown'
// and narrows the constraint; applying the forward file twice changes
// nothing. The forward file is applied again at the end so the rest of the
// suite sees the schema.

import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { documentDrafts } from '../db/schema/index.js';
import { makeCompany, cleanTenant } from './templates/templates.test-helpers.js';

const MIGRATIONS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');

async function run(file: string): Promise<void> {
  const text = readFileSync(path.join(MIGRATIONS, file), 'utf8');
  for (const stmt of text.split('--> statement-breakpoint')) {
    const body = stmt.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').trim();
    if (body) await db.execute(sql.raw(body));
  }
}

async function constraintDef(): Promise<string> {
  const r = await db.execute(sql`SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint
    WHERE conname = 'document_drafts_kind_ck' AND conrelid = 'document_drafts'::regclass`);
  return String((r.rows[0] as { d: string } | undefined)?.d ?? '');
}

const tenantIds: string[] = [];
const draftIds: string[] = [];

async function insertDraft(tenantId: string, companyId: string, kind: string): Promise<string> {
  const [row] = await db.insert(documentDrafts).values({
    tenantId, companyId, contentSha256: crypto.randomBytes(32).toString('hex'), kind,
  } as never).returning();
  draftIds.push(row!.id);
  return row!.id;
}

afterAll(async () => {
  if (!(await constraintDef()).includes('statement')) await run('0235_document_drafts_statement_kind.sql');
  if (draftIds.length) await db.delete(documentDrafts).where(inArray(documentDrafts.id, draftIds));
  while (tenantIds.length) await cleanTenant(tenantIds.pop()!);
});

describe('migration 0235 document drafts statement kind', () => {
  it('is listed after 0234 and carries the policy marker (a strict widening)', () => {
    const fwd = readFileSync(path.join(MIGRATIONS, '0235_document_drafts_statement_kind.sql'), 'utf8');
    expect(fwd.split('\n').slice(0, 10).join('\n')).toContain('-- migration-policy: non-additive-exception');
    expect(fwd).not.toMatch(/drop\s+(table|column)/i);
    expect(fwd).toMatch(/'bill', 'card_charge', 'check', 'cash_expense', 'unknown', 'statement'/);
    const journal = JSON.parse(readFileSync(path.join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as { entries: Array<{ idx: number; tag: string; when: number }> };
    const entry = journal.entries.find((e) => e.tag === '0235_document_drafts_statement_kind');
    expect(entry?.idx).toBe(235);
    expect(entry!.when).toBeGreaterThan(journal.entries.find((e) => e.idx === 234)!.when);
  });

  it('the constraint takes statement and refuses other values; rollback relabels to unknown; forward twice is a no-op', async () => {
    const co = await makeCompany('u94', tenantIds);
    const stmt = await insertDraft(co.tenantId, co.companyId, 'statement');
    const bill = await insertDraft(co.tenantId, co.companyId, 'bill');
    await expect(insertDraft(co.tenantId, co.companyId, 'invoice')).rejects.toThrow();

    await run('0235_document_drafts_statement_kind.rollback.sql');
    expect(await constraintDef()).not.toContain('statement');
    const rows = await db.select().from(documentDrafts).where(inArray(documentDrafts.id, [stmt, bill]));
    expect(Object.fromEntries(rows.map((r) => [r.id, r.kind]))).toEqual({ [stmt]: 'unknown', [bill]: 'bill' });
    await expect(insertDraft(co.tenantId, co.companyId, 'statement')).rejects.toThrow();

    await run('0235_document_drafts_statement_kind.sql');
    await run('0235_document_drafts_statement_kind.sql');
    expect(await constraintDef()).toContain('statement');
    const again = await insertDraft(co.tenantId, co.companyId, 'statement');
    const [row] = await db.select().from(documentDrafts).where(eq(documentDrafts.id, again));
    expect(row!.kind).toBe('statement');
  });
});
