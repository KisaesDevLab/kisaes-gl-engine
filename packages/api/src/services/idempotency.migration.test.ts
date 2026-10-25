// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// E19 (U-18): migration 0229 rolls back and re-applies cleanly (twice is a
// no-op), the table is excluded from tenant archives, and deleting the
// tenant, company or user removes its rows. The forward file is applied
// again at the end so the rest of the suite sees the schema.

import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { companies, idempotencyKeys } from '../db/schema/index.js';
import { EXCLUDED_TENANT_ARCHIVE_TABLES, buildPortabilityPlan } from './tenant-portability/plan.js';
import { makeCompany, cleanTenant } from './templates/templates.test-helpers.js';

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

const tenantIds: string[] = [];

afterAll(async () => {
  if (!(await tableExists('idempotency_keys'))) await run('0229_idempotency_keys.sql');
  while (tenantIds.length) await cleanTenant(tenantIds.pop()!);
});

function row(tenantId: string, userId: string, companyId: string | null, key: string) {
  return {
    tenantId, userId, companyId, idempotencyKey: key, route: 'POST /transactions',
    requestSha256: 'a'.repeat(64), state: 'committed', successStatus: 201,
  };
}

describe('migration 0229 idempotency_keys', () => {
  it('is additive, rolls back and re-applies; applying twice changes nothing', async () => {
    const fwd = readFileSync(path.join(MIGRATIONS, '0229_idempotency_keys.sql'), 'utf8');
    expect(fwd).not.toMatch(/drop\s+(table|column|constraint)/i);
    expect(fwd).not.toMatch(/rename/i);
    expect(await tableExists('idempotency_keys')).toBe(true);
    await run('0229_idempotency_keys.rollback.sql');
    expect(await tableExists('idempotency_keys')).toBe(false);
    await run('0229_idempotency_keys.sql');
    await run('0229_idempotency_keys.sql');
    expect(await tableExists('idempotency_keys')).toBe(true);
    const idx = await db.execute(sql`SELECT indexname FROM pg_indexes WHERE tablename = 'idempotency_keys' ORDER BY indexname`);
    expect((idx.rows as Array<{ indexname: string }>).map((r) => r.indexname))
      .toEqual(['idempotency_keys_pkey', 'idx_idempotency_keys_created', 'uq_idempotency_keys_key']);
  });

  it('the state is committed or done only, and a key is unique per tenant and user', async () => {
    const c = await makeCompany('idem-mig', tenantIds);
    await db.insert(idempotencyKeys).values(row(c.tenantId, c.userId, c.companyId, 'k'.repeat(16)));
    await expect(db.insert(idempotencyKeys).values(row(c.tenantId, c.userId, c.companyB, 'k'.repeat(16)))).rejects.toThrow();
    await expect(db.insert(idempotencyKeys).values({ ...row(c.tenantId, c.userId, null, 'm'.repeat(16)), state: 'in_progress' })).rejects.toThrow();
    // company_id is NULL on tenant-wide routes (contacts, items, tags).
    await db.insert(idempotencyKeys).values(row(c.tenantId, c.userId, null, 'n'.repeat(16)));
  });

  it('is excluded from tenant archives as job bookkeeping', async () => {
    expect(EXCLUDED_TENANT_ARCHIVE_TABLES['idempotency_keys']).toMatchObject({ category: 'job-bookkeeping', scope: 'tenant' });
    const plan = await buildPortabilityPlan();
    expect(plan.bucketOf.get('idempotency_keys')).toBe('excluded');
    expect(plan.byName.has('idempotency_keys')).toBe(false);
    // Tenant-scoped: the tenant delete (E5b) removes its rows too.
    expect(plan.scoped).toContain('idempotency_keys');
  });

  it('deleting the company or the tenant removes its rows', async () => {
    const c = await makeCompany('idem-del', tenantIds);
    await db.insert(idempotencyKeys).values(row(c.tenantId, c.userId, c.companyB, 'b'.repeat(16)));
    await db.insert(idempotencyKeys).values(row(c.tenantId, c.userId, c.companyId, 'a'.repeat(16)));
    await db.delete(companies).where(eq(companies.id, c.companyB));
    expect(await db.select().from(idempotencyKeys).where(eq(idempotencyKeys.tenantId, c.tenantId))).toHaveLength(1);
    await cleanTenant(tenantIds.pop()!);
    expect(await db.select().from(idempotencyKeys).where(eq(idempotencyKeys.tenantId, c.tenantId))).toHaveLength(0);
  });
});
