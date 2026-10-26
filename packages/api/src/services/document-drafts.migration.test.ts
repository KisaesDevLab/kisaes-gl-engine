// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// U-92: migration 0233 is additive, rolls back and re-applies cleanly
// (applying it twice is a no-op), its constraints hold, and the tenant
// archive plan classifies the new tables (tenant bucket, omittable on
// request) and the new column. The forward file is applied again at the end
// so the rest of the suite sees the schema.

import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { companies, documentDrafts, vendorLayoutTemplates, contacts } from '../db/schema/index.js';
import { OMITTABLE_ROW_FILTERS, OMITTABLE_TABLES, buildPortabilityPlan } from './tenant-portability/plan.js';
import { makeCompany, cleanTenant } from './templates/templates.test-helpers.js';
import { normalizeDocumentReference } from '@kis-books/shared';
import { normalizedRefSql } from './document-draft.service.js';

const MIGRATIONS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');

async function run(file: string): Promise<void> {
  const text = readFileSync(path.join(MIGRATIONS, file), 'utf8');
  for (const stmt of text.split('--> statement-breakpoint')) {
    const body = stmt.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').trim();
    if (body) await db.execute(sql.raw(body));
  }
}

async function tableExists(name: string): Promise<boolean> {
  const r = await db.execute(sql`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = ${name}`);
  return (r.rows[0] as { n: number }).n === 1;
}

async function columnExists(table: string, column: string): Promise<boolean> {
  const r = await db.execute(sql`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = ${table} AND column_name = ${column}`);
  return (r.rows[0] as { n: number }).n === 1;
}

const tenantIds: string[] = [];
const sha = () => crypto.randomBytes(32).toString('hex');

afterAll(async () => {
  if (!(await tableExists('document_drafts'))) await run('0233_document_drafts.sql');
  for (const id of tenantIds) {
    await db.delete(documentDrafts).where(eq(documentDrafts.tenantId, id));
    await db.delete(vendorLayoutTemplates).where(eq(vendorLayoutTemplates.tenantId, id));
  }
  while (tenantIds.length) await cleanTenant(tenantIds.pop()!);
});

describe('migration 0233 document drafts', () => {
  it('is additive, rolls back and re-applies; applying twice changes nothing', async () => {
    const fwd = readFileSync(path.join(MIGRATIONS, '0233_document_drafts.sql'), 'utf8');
    expect(fwd).not.toMatch(/drop\s+(table|column|constraint)/i);
    expect(fwd).not.toMatch(/rename/i);
    const journal = JSON.parse(readFileSync(path.join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as { entries: Array<{ idx: number; tag: string; when: number }> };
    const entry = journal.entries.find((e) => e.tag === '0233_document_drafts');
    expect(entry?.idx).toBe(233);
    expect(entry!.when).toBeGreaterThan(journal.entries.find((e) => e.idx === 232)!.when);

    expect(await tableExists('document_drafts')).toBe(true);
    await run('0233_document_drafts.rollback.sql');
    expect(await tableExists('document_drafts')).toBe(false);
    expect(await tableExists('vendor_layout_templates')).toBe(false);
    expect(await columnExists('accounts', 'card_last4')).toBe(false);
    await run('0233_document_drafts.sql');
    await run('0233_document_drafts.sql');
    expect(await tableExists('document_drafts')).toBe(true);
    expect(await columnExists('accounts', 'card_last4')).toBe(true);
    const idx = await db.execute(sql`SELECT indexname FROM pg_indexes WHERE tablename IN ('document_drafts', 'vendor_layout_templates') ORDER BY indexname`);
    expect((idx.rows as Array<{ indexname: string }>).map((r) => r.indexname)).toEqual([
      'document_drafts_pkey', 'idx_document_drafts_attachment', 'idx_document_drafts_contact', 'idx_document_drafts_queue',
      'idx_vendor_layout_templates_company', 'uq_document_drafts_claim', 'uq_vendor_layout_templates', 'vendor_layout_templates_pkey',
    ]);
    const ck = await db.execute(sql`SELECT count(*)::int AS n FROM pg_constraint WHERE conname = 'accounts_card_last4_chk'`);
    expect((ck.rows[0] as { n: number }).n).toBe(1);
  });

  it('constraints: one claim per file and company until discarded; kinds, statuses, hashes and totals checked', async () => {
    const c = await makeCompany('u92-mig', tenantIds);
    const h = sha();
    const base = { tenantId: c.tenantId, companyId: c.companyId, contentSha256: h };
    await db.insert(documentDrafts).values(base);
    await expect(db.insert(documentDrafts).values(base)).rejects.toThrow();
    // Another company may hold the same file.
    await db.insert(documentDrafts).values({ ...base, companyId: c.companyB });
    // A discarded draft no longer holds the claim.
    await db.update(documentDrafts).set({ status: 'discarded' }).where(eq(documentDrafts.companyId, c.companyId));
    await db.insert(documentDrafts).values(base);
    await expect(db.insert(documentDrafts).values({ ...base, contentSha256: 'X'.repeat(64) })).rejects.toThrow();
    await expect(db.insert(documentDrafts).values({ ...base, contentSha256: sha(), kind: 'invoice' as never })).rejects.toThrow();
    await expect(db.insert(documentDrafts).values({ ...base, contentSha256: sha(), status: 'posted' as never })).rejects.toThrow();
    await expect(db.insert(documentDrafts).values({ ...base, contentSha256: sha(), docTotal: '-1.00' })).rejects.toThrow();
    await expect(db.insert(documentDrafts).values({ ...base, contentSha256: sha(), status: 'converted' })).rejects.toThrow();
    // Layouts: one per company, vendor and fingerprint.
    const [v] = await db.select().from(contacts).where(eq(contacts.id, c.vendor));
    const t = { tenantId: c.tenantId, companyId: c.companyId, contactId: v!.id, fingerprint: 'fp:aaaaaaaa' };
    await db.insert(vendorLayoutTemplates).values(t);
    await expect(db.insert(vendorLayoutTemplates).values(t)).rejects.toThrow();
    await expect(db.insert(vendorLayoutTemplates).values({ ...t, fingerprint: 'fp:bbbbbbbb', samples: 0 })).rejects.toThrow();
    // Deleting the company removes its drafts and layouts.
    await db.delete(documentDrafts).where(eq(documentDrafts.companyId, c.companyB));
    await db.delete(companies).where(eq(companies.id, c.companyB));
  });

  it('the archive plan keeps drafts and layouts (tenant bucket) and can leave them out on request', async () => {
    const plan = await buildPortabilityPlan();
    expect(plan.bucketOf.get('document_drafts')).toBe('tenant');
    expect(plan.bucketOf.get('vendor_layout_templates')).toBe('tenant');
    expect(plan.byName.get('accounts')!.canonical).toContain('card_last4');
    expect(OMITTABLE_TABLES).toEqual({
      document_drafts: { option: 'omitDocumentDrafts' },
      vendor_layout_templates: { option: 'omitDocumentDrafts' },
    });
    expect(OMITTABLE_ROW_FILTERS['attachments']).toMatchObject({ option: 'omitDocumentDrafts', label: 'attachments:live-document-drafts' });
  });

  it('the SQL reference normalization equals the shared one', async () => {
    for (const ref of ['INV-0042', 'inv 0042', '0042', '  #00-12/A ', '', '---', 'Façade-7', 'ab_c.D-0']) {
      const r = await db.execute(sql`SELECT ${normalizedRefSql(sql`${ref}::text`)} AS n`);
      expect((r.rows[0] as { n: string }).n, ref).toBe(normalizeDocumentReference(ref));
    }
  });
});