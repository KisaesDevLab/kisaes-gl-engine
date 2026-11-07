// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// U-06: migration 0263 is additive, rolls back and re-applies cleanly
// (twice is a no-op); feed rows imported through a batch survive the
// rollback. A dedupe key is unique per connection. A batch left
// `scheduled` is picked up again on start (resumeScheduledPostProcessing).
// The forward files (0263, 0264) are applied again at the end so the rest of
// the suite sees the schema. Migration 0264 (post-processing progress and
// cancel requests) is additive, rolls back and re-applies.

import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../../db/index.js';
import {
  tenants, users, sessions, companies, accounts, auditLog, bankConnections, bankFeedItems, bankImportBatches,
  transactionClassificationState,
} from '../../db/schema/index.js';
import * as authService from '../auth.service.js';
import { resumeScheduledPostProcessing } from './import-batch.service.js';

const MIGRATIONS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'db', 'migrations');

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

let tenantId = '';
let userId = '';

afterAll(async () => {
  if (!(await tableExists('bank_import_batches'))) await run('0263_bank_import_batches.sql');
  await run('0264_bank_import_post_progress.sql');
  if (!tenantId) return;
  await db.delete(transactionClassificationState).where(eq(transactionClassificationState.tenantId, tenantId));
  await db.delete(bankFeedItems).where(eq(bankFeedItems.tenantId, tenantId));
  await db.delete(bankImportBatches).where(eq(bankImportBatches.tenantId, tenantId));
  await db.delete(bankConnections).where(eq(bankConnections.tenantId, tenantId));
  await db.delete(auditLog).where(eq(auditLog.tenantId, tenantId));
  await db.delete(accounts).where(eq(accounts.tenantId, tenantId));
  await db.delete(companies).where(eq(companies.tenantId, tenantId));
  await db.delete(sessions).where(eq(sessions.userId, userId));
  await db.delete(users).where(eq(users.tenantId, tenantId));
  await db.delete(tenants).where(eq(tenants.id, tenantId));
});

describe('migration 0263 bank import batches', () => {
  it('is additive, keeps imported rows on rollback, re-applies; twice is a no-op; dedupe keys unique per connection', async () => {
    const fwd = readFileSync(path.join(MIGRATIONS, '0263_bank_import_batches.sql'), 'utf8');
    expect(fwd).not.toMatch(/drop\s+(table|column|constraint)/i);
    expect(fwd).not.toMatch(/rename/i);

    const { user } = await authService.register({
      email: `bib-mig-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`,
      password: 'password123', displayName: 'Batch Migration', companyName: 'Batch Migration Co',
    });
    tenantId = user.tenantId;
    userId = user.id;
    const [a] = await db.select().from(accounts).where(and(eq(accounts.tenantId, tenantId), eq(accounts.accountType, 'asset')));
    const [conn] = await db.insert(bankConnections).values({ tenantId, accountId: a!.id, provider: 'manual' }).returning();
    const [batch] = await db.insert(bankImportBatches).values({
      tenantId, bankConnectionId: conn!.id, accountId: a!.id, format: 'csv', fileName: 'x.csv', sourceFileSha256: '0'.repeat(64),
      postProcessing: 'scheduled',
    }).returning();
    const item = {
      tenantId, bankConnectionId: conn!.id, feedDate: '2026-11-01', amount: '1.0000', description: 'X', originalDescription: 'X',
      importBatchId: batch!.id, dedupeKey: 'k'.repeat(64), rowKey: 'k'.repeat(64), dedupeVersion: 1, sourceLine: 2,
    };
    await db.insert(bankFeedItems).values(item);
    await expect(db.insert(bankFeedItems).values(item)).rejects.toThrow();

    // A scheduled batch is picked up on start and finishes.
    expect(await resumeScheduledPostProcessing()).toBeGreaterThanOrEqual(1);
    const [after] = await db.select().from(bankImportBatches).where(eq(bankImportBatches.id, batch!.id));
    expect(after!.postProcessing).toBe('done');

    await run('0263_bank_import_batches.rollback.sql');
    expect(await tableExists('bank_import_batches')).toBe(false);
    expect(await tableExists('bank_connection_identities')).toBe(false);
    expect(await tableExists('bank_link_keys')).toBe(false);
    const kept = await db.execute(sql`SELECT count(*)::int AS n FROM bank_feed_items WHERE tenant_id = ${tenantId}`);
    expect((kept.rows[0] as { n: number }).n).toBe(1);

    await run('0263_bank_import_batches.sql');
    await run('0263_bank_import_batches.sql');
    await run('0264_bank_import_post_progress.sql');
    expect(await tableExists('bank_import_batches')).toBe(true);
    expect(await tableExists('bank_link_keys')).toBe(true);
    const cols = await db.execute(sql`SELECT column_name, is_nullable FROM information_schema.columns
      WHERE (table_name = 'bank_import_batches' AND column_name = 'replaced_items')
         OR (table_name = 'bank_link_keys' AND column_name = 'key_encrypted') ORDER BY column_name`);
    // key_encrypted is nullable text: the tenant export re-encrypts it (SECRET_COLUMNS reencrypt).
    expect(cols.rows).toEqual([{ column_name: 'key_encrypted', is_nullable: 'YES' }, { column_name: 'replaced_items', is_nullable: 'YES' }]);
    const idx = await db.execute(sql`SELECT indexname FROM pg_indexes WHERE tablename = 'bank_feed_items' ORDER BY indexname`);
    expect((idx.rows as Array<{ indexname: string }>).map((r) => r.indexname))
      .toEqual(expect.arrayContaining(['uq_bfi_connection_dedupe_key', 'idx_bfi_connection_row_key', 'idx_bfi_import_batch']));
  });
});

describe('migration 0264 bank import post-processing progress', () => {
  const columns = async () => ((await db.execute(sql`SELECT column_name FROM information_schema.columns
    WHERE table_name = 'bank_import_batches' AND column_name IN ('total_rows', 'processed_rows', 'cancel_requested_at')
    ORDER BY column_name`)).rows as Array<{ column_name: string }>).map((r) => r.column_name);

  it('is additive, keeps the batches on rollback and re-applies; twice is a no-op', async () => {
    const fwd = readFileSync(path.join(MIGRATIONS, '0264_bank_import_post_progress.sql'), 'utf8');
    expect(fwd).not.toMatch(/drop\s+(table|column|constraint)/i);
    expect(fwd).not.toMatch(/rename/i);
    expect(await columns()).toEqual(['cancel_requested_at', 'processed_rows', 'total_rows']);

    const [a] = await db.select().from(accounts).where(and(eq(accounts.tenantId, tenantId), eq(accounts.accountType, 'asset')));
    const [conn] = await db.select().from(bankConnections).where(eq(bankConnections.tenantId, tenantId));
    const [batch] = await db.insert(bankImportBatches).values({
      tenantId, bankConnectionId: conn!.id, accountId: a!.id, format: 'csv', fileName: 'y.csv', sourceFileSha256: '1'.repeat(64),
      postProcessing: 'done', totalRows: 10, processedRows: 10, cancelRequestedAt: new Date(),
    }).returning();
    // Undone while preparing (reported cancelled), and one still preparing.
    const [cancelled] = await db.insert(bankImportBatches).values({
      tenantId, bankConnectionId: conn!.id, accountId: a!.id, format: 'csv', fileName: 'z.csv', sourceFileSha256: '2'.repeat(64),
      postProcessing: 'scheduled', totalRows: 10, processedRows: 3, undoneAt: new Date(),
    }).returning();
    const [preparing] = await db.insert(bankImportBatches).values({
      tenantId, bankConnectionId: conn!.id, accountId: a!.id, format: 'csv', fileName: 'w.csv', sourceFileSha256: '3'.repeat(64),
      postProcessing: 'scheduled', totalRows: 10, processedRows: 3, cancelRequestedAt: new Date(),
    }).returning();

    await run('0264_bank_import_post_progress.rollback.sql');
    expect(await columns()).toEqual([]);
    const back = await db.execute(sql`SELECT id, post_processing FROM bank_import_batches
      WHERE id IN (${batch!.id}, ${cancelled!.id}, ${preparing!.id})`);
    // The older engine restarts every `scheduled` batch: the undone one must not be.
    expect(Object.fromEntries((back.rows as Array<{ id: string; post_processing: string }>).map((r) => [r.id, r.post_processing])))
      .toEqual({ [batch!.id]: 'done', [cancelled!.id]: 'done', [preparing!.id]: 'scheduled' });
    await db.execute(sql`UPDATE bank_import_batches SET post_processing = 'done' WHERE id = ${preparing!.id}`);

    await run('0264_bank_import_post_progress.sql');
    await run('0264_bank_import_post_progress.sql');
    expect(await columns()).toEqual(['cancel_requested_at', 'processed_rows', 'total_rows']);
    const fresh = await db.execute(sql`SELECT processed_rows, total_rows, cancel_requested_at FROM bank_import_batches WHERE id = ${batch!.id}`);
    expect(fresh.rows).toEqual([{ processed_rows: 0, total_rows: null, cancel_requested_at: null }]);
  });
});
