// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// listStatementJobs: server-side sort and the disposition filter the
// Statement Processing page sends (it used to filter the fetched page only).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { tenants, aiJobs, attachments } from '../db/schema/index.js';
import { listStatementJobs } from './ai-statement-parser.service.js';

let tenantId = '';

async function cleanDb() {
  if (!tenantId) return;
  await db.delete(aiJobs).where(eq(aiJobs.tenantId, tenantId));
  await db.delete(attachments).where(eq(attachments.tenantId, tenantId));
  await db.delete(tenants).where(eq(tenants.id, tenantId));
  tenantId = '';
}

beforeEach(async () => {
  await cleanDb();
  const [t] = await db.insert(tenants).values({ name: 'Stmt Jobs', slug: 'stmt-jobs-' + Date.now() }).returning();
  tenantId = t!.id;
  const att = async (fileName: string) => (await db.insert(attachments).values({
    tenantId, attachableType: 'bank_statement', attachableId: '00000000-0000-4000-8000-000000000000',
    fileName, filePath: `/x/${fileName}`, mimeType: 'application/pdf', fileSize: 10,
  }).returning())[0]!.id;
  const job = (inputId: string, status: string, importedAt: Date | null, txns: number, createdAt: Date) =>
    db.insert(aiJobs).values({
      tenantId, jobType: 'ocr_statement', inputId, status, importedAt,
      outputData: { transactions: Array.from({ length: txns }, (_, i) => ({ i })) } as never,
      createdAt,
    });
  await job(await att('b-imported.pdf'), 'complete', new Date('2026-09-01'), 5, new Date('2026-09-01T10:00:00Z'));
  await job(await att('a-pending.pdf'), 'complete', null, 12, new Date('2026-09-02T10:00:00Z'));
  await job(await att('c-failed.pdf'), 'failed', null, 0, new Date('2026-09-03T10:00:00Z'));
  await job(await att('d-processing.pdf'), 'processing', null, 0, new Date('2026-09-04T10:00:00Z'));
});
afterEach(async () => { await cleanDb(); });

const names = async (o: Parameters<typeof listStatementJobs>[1]) => (await listStatementJobs(tenantId, o)).jobs.map((j) => j.fileName);

describe('listStatementJobs — sort and disposition filter', () => {
  it('defaults to newest first and sorts by the whitelisted keys', async () => {
    expect(await names({})).toEqual(['d-processing.pdf', 'c-failed.pdf', 'a-pending.pdf', 'b-imported.pdf']);
    expect(await names({ sortBy: 'fileName', sortDir: 'asc' })).toEqual(['a-pending.pdf', 'b-imported.pdf', 'c-failed.pdf', 'd-processing.pdf']);
    expect(await names({ sortBy: 'transactionCount', sortDir: 'desc' })).toEqual(['a-pending.pdf', 'b-imported.pdf', 'd-processing.pdf', 'c-failed.pdf']);
    expect(await names({ sortBy: 'status', sortDir: 'asc' })).toEqual(['c-failed.pdf', 'b-imported.pdf', 'a-pending.pdf', 'd-processing.pdf']);
  });

  it('filters by disposition with imported winning over the raw status, and counts to match', async () => {
    expect(await names({ status: ['imported'] })).toEqual(['b-imported.pdf']);
    expect(await names({ status: ['pending', 'failed'] })).toEqual(['c-failed.pdf', 'a-pending.pdf']);
    expect((await listStatementJobs(tenantId, { status: ['processing'] })).total).toBe(1);
  });
});
