// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.
//
// Bulk Import batches (U-261, U-263; ClientLedger P31 E1): one-transaction
// commit in the background, the state machine, engine-start recovery,
// IMPORT_BUSY, the re-import refusals and the old one-session commit.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'express-async-errors';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { importSessions, importBatches, transactions, companies, accounts } from '../db/schema/index.js';
import { importsRouter } from './imports.routes.js';
import * as importsService from '../services/imports/imports.service.js';
import * as batchService from '../services/imports/import-batch.service.js';
import { Harness, type Co, key } from './receivables.test-support.js';
import {
  uploadSet, upload, glCsv, companySnapshot, cleanImports, batchRow, stamped, COA_CSV,
} from './imports-batch.test-support.js';

const h = new Harness();
let c: Co;

beforeEach(async () => {
  h.extraCleanup = [cleanImports];
  await h.start([['/api/v1/imports', importsRouter]]);
  c = await h.company();
});
afterEach(async () => {
  batchService.__batchTestHooks.afterSession = undefined;
  await h.stop();
});

const post = (p: string, body: unknown, k: string | null = key()) =>
  h.request('POST', `/api/v1/imports${p}`, c.token, body, k ? { 'Idempotency-Key': k } : {});
const get = (p: string) => h.request('GET', `/api/v1/imports${p}`, c.token);

async function createBatch(sessionIds: string[], options: Record<string, unknown> = {}, kind = 'conversion') {
  const r = await post('/batches', { sourceSystem: 'accounting_power', kind, sessionIds, options }, null);
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return r.json['batch'] as Record<string, any>;
}

/** Commit and wait for the background job. */
async function commit(batchId: string, k = key(), body: Record<string, unknown> = { backupRef: 'before-import-test.clb' }) {
  const r = await post(`/batches/${batchId}/commit`, body, k);
  if (r.status === 202) await batchService.__batchJobs.last;
  return r;
}

async function postedCount() {
  return (await db.select({ id: transactions.id }).from(transactions)
    .where(and(eq(transactions.tenantId, c.tenantId), eq(transactions.status, 'posted')))).length;
}

describe('batch commit (U-261)', () => {
  it('creates a draft batch, commits it in the background and stamps every created row', async () => {
    const s = await uploadSet(c);
    const b = await createBatch([s.gl, s.tb, s.vendors, s.coa], { fiscalYearStartMonth: 4 });
    expect(b['status']).toBe('draft');
    // Posting order, whatever order the ids came in.
    expect(b['sessions'].map((x: any) => x.kind)).toEqual(['coa', 'contacts', 'trial_balance', 'gl_transactions']);

    const r = await post(`/batches/${b['id']}/commit`, { backupRef: 'before-import-1.clb' });
    expect(r.status).toBe(202);
    expect(r.json).toEqual({ batchId: b['id'] });
    // Claimed in its own committed transaction: a poll right away sees it running.
    const running = await get(`/batches/${b['id']}`);
    expect(['committing', 'committed']).toContain(running.json['batch'].status);
    await batchService.__batchJobs.last;

    const done = await get(`/batches/${b['id']}`);
    expect(done.status).toBe(200);
    expect(done.json['batch'].status).toBe('committed');
    expect(done.json['progress']).toBeNull();
    expect(done.json['batch'].backupRef).toBe('before-import-1.clb');
    expect(done.json['batch'].companyWasEmpty).toBe(true);
    expect(done.json['batch'].sessions.every((x: any) => x.status === 'committed')).toBe(true);
    // 1 opening entry + 6 journal entries; 5 accounts, 2 vendors.
    expect(await stamped(c, b['id'])).toEqual({ accounts: 5, contacts: 2, transactions: 7, tags: 0 });
    const [co] = await db.select({ m: companies.fiscalYearStartMonth }).from(companies).where(eq(companies.id, c.companyId));
    expect(co!.m).toBe(4);
    expect((await batchRow(b['id'])).priorValues).toMatchObject({ fiscalYearStartMonth: 1 });
    const sess = await db.select().from(importSessions).where(eq(importSessions.batchId, b['id']));
    expect(sess.every((x) => x.activeCommit)).toBe(true);
  });

  it('a failing session posts nothing: the company is exactly as before, and a retry with a new key posts once', async () => {
    const s = await uploadSet(c);
    const before = await companySnapshot(c);
    const b = await createBatch([s.coa, s.vendors, s.tb, s.gl]);
    let fail = true;
    batchService.__batchTestHooks.afterSession = ({ sessionId }) => {
      if (fail && sessionId === s.gl) throw Object.assign(new Error('boom'), {});
    };
    const r = await commit(b['id']);
    expect(r.status).toBe(202);
    const failed = await get(`/batches/${b['id']}`);
    expect(failed.json['batch'].status).toBe('failed');
    expect(failed.json['error']).toMatchObject({ code: 'IMPORT_POST_FAILED', sessionId: s.gl });
    expect(await companySnapshot(c)).toEqual(before);
    expect(failed.json['batch'].sessions.every((x: any) => x.status === 'uploaded')).toBe(true);

    fail = false;
    const again = await commit(b['id']);
    expect(again.status).toBe(202);
    expect((await batchRow(b['id'])).status).toBe('committed');
    expect(await postedCount()).toBe(7);
  });

  it('a row error names the session and row; nothing is posted', async () => {
    const coa = await upload(c, 'coa.csv', COA_CSV, 'coa');
    // 9999 does not exist: a batch never posts to suspense (U-265); every unmapped key is listed.
    const gl = await upload(c, 'gl.csv', glCsv(2025, [1], '9999'), 'gl_transactions', { unmappedAccountsToSuspense: false });
    const before = await companySnapshot(c);
    const b = await createBatch([coa, gl]);
    await commit(b['id']);
    const out = await get(`/batches/${b['id']}`);
    expect(out.json['batch'].status).toBe('failed');
    expect(out.json['error']).toMatchObject({
      code: 'IMPORT_UNMAPPED_ACCOUNT', sessionId: gl, rowNumber: expect.any(Number),
      details: { unmappedAccountKeys: ['9999'], unmappedCount: 1 },
    });
    expect(await companySnapshot(c)).toEqual(before);
  });

  it('the same Idempotency-Key replays the 202 and runs nothing twice', async () => {
    const s = await uploadSet(c);
    const b = await createBatch([s.coa, s.vendors, s.tb, s.gl]);
    const k = key();
    expect((await commit(b['id'], k)).status).toBe(202);
    const replay = await post(`/batches/${b['id']}/commit`, { backupRef: 'before-import-test.clb' }, k);
    expect(replay.status).toBe(202);
    expect(replay.json).toEqual({ batchId: b['id'] });
    expect(await postedCount()).toBe(7);
    // A new key on a committed batch: 409.
    const twice = await post(`/batches/${b['id']}/commit`, {});
    expect(twice.status).toBe(409);
    expect(twice.json['error'].code).toBe('IMPORT_ALREADY_COMMITTED');
  });

  it('reference files are kept with the batch but never posted', async () => {
    const coa = await upload(c, 'coa.csv', COA_CSV, 'coa');
    const ref = await upload(c, 'tb-ref.csv', (await import('./imports-batch.test-support.js')).TB_CSV, 'trial_balance',
      { tbColumn: 'beginning', tbReportDate: '2025-03-31' }, 'reference');
    const b = await createBatch([coa, ref]);
    await commit(b['id']);
    const out = await get(`/batches/${b['id']}`);
    expect(out.json['batch'].status).toBe('committed');
    expect(out.json['batch'].sessions.find((x: any) => x.id === ref).role).toBe('reference');
    expect(await postedCount()).toBe(0);
  });

  it('lists batches newest first with a cursor', async () => {
    const ids: string[] = [];
    for (let y = 2020; y < 2023; y++) {
      const gl = await upload(c, `gl-${y}.csv`, glCsv(y, [1]), 'gl_transactions');
      ids.push((await createBatch([gl], {}, 'single'))['id']);
    }
    const p1 = await get('/batches?limit=2');
    expect(p1.json['batches'].map((b: any) => b.id)).toEqual([ids[2], ids[1]]);
    const p2 = await get(`/batches?limit=2&cursor=${encodeURIComponent(p1.json['nextCursor'])}`);
    expect(p2.json['batches'].map((b: any) => b.id)).toEqual([ids[0]]);
    expect(p2.json['nextCursor']).toBeNull();
  });
});

describe('batch refusals (U-261, U-263)', () => {
  it('a session can belong to one batch only', async () => {
    const coa = await upload(c, 'coa.csv', COA_CSV, 'coa');
    await createBatch([coa]);
    const r = await post('/batches', { sourceSystem: 'accounting_power', kind: 'single', sessionIds: [coa] }, null);
    expect(r.status).toBe(409);
    expect(r.json['error'].code).toBe('IMPORT_SESSION_IN_BATCH');
    // The old one-session commit refuses it too.
    await expect(importsService.commitSession(c.tenantId, c.companyId, c.userId, coa))
      .rejects.toMatchObject({ code: 'IMPORT_SESSION_IN_BATCH' });
  });

  it('journal files of one batch may not overlap', async () => {
    const a = await upload(c, 'gl-a.csv', glCsv(2025, [1, 2, 3]), 'gl_transactions');
    const b = await upload(c, 'gl-b.csv', glCsv(2025, [3, 4], '9401'), 'gl_transactions');
    // Same rows in March but different months overall: a different hash.
    await upload(c, 'coa.csv', COA_CSV, 'coa');
    const r = await post('/batches', { sourceSystem: 'accounting_power', kind: 'conversion', sessionIds: [a, b] }, null);
    expect(r.status).toBe(409);
    expect(r.json['error']).toMatchObject({ code: 'IMPORT_PERIOD_OVERLAP', details: { from: '2025-03-15', to: '2025-03-15' } });
  });

  it('committed data is refused at upload and at commit; overlap with a committed journal too', async () => {
    const s = await uploadSet(c);
    const b = await createBatch([s.coa, s.vendors, s.tb, s.gl]);
    await commit(b['id']);
    await expect(upload(c, 'coa-again.csv', COA_CSV, 'coa')).rejects.toMatchObject({
      code: 'IMPORT_ALREADY_COMMITTED', details: { batchId: b['id'], sessionId: s.coa, committedAt: expect.any(String) },
    });
    await expect(upload(c, 'gl-overlap.csv', glCsv(2025, [3, 4]), 'gl_transactions')).rejects.toMatchObject({
      code: 'IMPORT_PERIOD_OVERLAP', details: { batchId: b['id'], from: '2025-03-15', to: '2025-03-15' },
    });
    // A later year does not overlap.
    const later = await upload(c, 'gl-2026.csv', glCsv(2026, [1]), 'gl_transactions');
    expect(later).toBeTruthy();
  });

  it('a second commit while one runs is 409 IMPORT_BUSY (also the old commit), and engine-start recovery leaves a live job alone', async () => {
    const s = await uploadSet(c);
    const other = await upload(c, 'gl-2026.csv', glCsv(2026, [5]), 'gl_transactions');
    const legacy = await upload(c, 'gl-2027.csv', glCsv(2027, [5]), 'gl_transactions');
    const a = await createBatch([s.coa, s.vendors, s.tb, s.gl]);
    const b2 = await createBatch([other], {}, 'single');
    let reached!: () => void;
    const inside = new Promise<void>((r) => { reached = r; });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    batchService.__batchTestHooks.afterSession = async ({ sessionId }) => {
      if (sessionId === s.coa) { reached(); await gate; }
    };
    const r = await post(`/batches/${a['id']}/commit`, {});
    expect(r.status).toBe(202);
    const job = batchService.__batchJobs.last;
    await inside;
    const busy = await post(`/batches/${b2['id']}/commit`, {});
    expect(busy.status).toBe(409);
    expect(busy.json['error'].code).toBe('IMPORT_BUSY');
    await expect(importsService.commitSession(c.tenantId, c.companyId, c.userId, legacy)).rejects.toMatchObject({ code: 'IMPORT_BUSY' });
    const polled = await get(`/batches/${a['id']}`);
    expect(polled.json['batch'].status).toBe('committing');
    expect(polled.json['progress']).toMatchObject({ step: expect.any(String), total: 4 });
    expect(await batchService.recoverInterruptedBatches()).toBe(0);
    release();
    await job;
    expect((await batchRow(a['id'])).status).toBe('committed');
  });

  it('engine start settles a batch a crash left committing; a retry with a new key posts once', async () => {
    const s = await uploadSet(c);
    const b = await createBatch([s.coa, s.vendors, s.tb, s.gl]);
    // As if the process died right after the claim: committing, no job.
    await db.update(importBatches).set({ status: 'committing' }).where(eq(importBatches.id, b['id']));
    const stuck = await post(`/batches/${b['id']}/commit`, {});
    expect(stuck.status).toBe(409);
    expect(stuck.json['error'].code).toBe('IMPORT_BUSY');
    expect(await batchService.recoverInterruptedBatches()).toBeGreaterThanOrEqual(1);
    const after = await get(`/batches/${b['id']}`);
    expect(after.json['batch'].status).toBe('failed');
    expect(after.json['error'].code).toBe('IMPORT_INTERRUPTED');
    expect(await postedCount()).toBe(0);
    expect((await commit(b['id'])).status).toBe(202);
    expect((await batchRow(b['id'])).status).toBe('committed');
    expect(await postedCount()).toBe(7);
    // A batch left undoing goes back to committed.
    await db.update(importBatches).set({ status: 'undoing' }).where(eq(importBatches.id, b['id']));
    await batchService.recoverInterruptedBatches();
    expect((await batchRow(b['id'])).status).toBe('committed');
  });

  it('fiscal year and empty-company options are refused in a company with transactions', async () => {
    const first = await upload(c, 'gl-2024.csv', glCsv(2024, [1]), 'gl_transactions');
    const coa = await upload(c, 'coa.csv', COA_CSV, 'coa');
    const b0 = await createBatch([coa, first]);
    await commit(b0['id']);
    const gl = await upload(c, 'gl-2025.csv', glCsv(2025, [1]), 'gl_transactions');
    const r = await post('/batches', { sourceSystem: 'accounting_power', kind: 'conversion', sessionIds: [gl], options: { fiscalYearStartMonth: 7 } }, null);
    expect(r.status).toBe(409);
    expect(r.json['error'].code).toBe('IMPORT_FISCAL_YEAR_LOCKED');
    const b = await createBatch([gl], { requireEmptyCompany: true });
    const nonEmpty = await post(`/batches/${b['id']}/commit`, {});
    expect(nonEmpty.status).toBe(409);
    expect(nonEmpty.json['error'].code).toBe('IMPORT_COMPANY_NOT_EMPTY');
  });

  it('404 for another company\'s batch; 400 for a bad id', async () => {
    expect((await get('/batches/00000000-0000-4000-8000-000000000000')).status).toBe(404);
    expect((await get('/batches/not-a-uuid')).status).toBe(400);
  });
});

describe('old POST /imports/:id/commit (U-261)', () => {
  it('commits as a one-session batch and a failure posts nothing', async () => {
    await upload(c, 'coa.csv', COA_CSV, 'coa').then((id) => importsService.commitSession(c.tenantId, c.companyId, c.userId, id));
    const ok = await upload(c, 'gl.csv', glCsv(2025, [1, 2]), 'gl_transactions');
    const out = await post(`/${ok}/commit`, {}, null);
    expect(out.status).toBe(200);
    expect(out.json['result']).toMatchObject({ created: 4 });
    expect(out.json['session']).toMatchObject({ status: 'committed', batchId: expect.any(String) });
    const [b] = await db.select().from(importBatches).where(eq(importBatches.id, out.json['session'].batchId));
    expect(b).toMatchObject({ kind: 'single', status: 'committed' });

    // Second entry fails (unknown account, suspense off): the first is not kept either.
    const bad = glCsv(2026, [1]) + `"CD","02/15/2026","X1","Bad","9999","Nowhere",1.0000,0.0000,"","","u1"\n`
      + `"CD","02/15/2026","X1","Bad","9101","Batch Checking",0.0000,1.0000,"","","u1"\n`;
    const failing = await upload(c, 'gl-bad.csv', bad, 'gl_transactions', { unmappedAccountsToSuspense: false });
    const before = await postedCount();
    const refused = await post(`/${failing}/commit`, {}, null);
    expect(refused.status).toBe(409);
    expect(await postedCount()).toBe(before);
    const [sess] = await db.select().from(importSessions).where(eq(importSessions.id, failing));
    expect(sess!.status).toBe('uploaded');
  });

  it('a failure inside the posting leaves the session failed and nothing posted', async () => {
    await upload(c, 'coa.csv', COA_CSV, 'coa').then((id) => importsService.commitSession(c.tenantId, c.companyId, c.userId, id));
    const gl = await upload(c, 'gl.csv', glCsv(2025, [1, 2]), 'gl_transactions');
    batchService.__batchTestHooks.afterSession = () => { throw new Error('boom'); };
    const before = await postedCount();
    await expect(importsService.commitSession(c.tenantId, c.companyId, c.userId, gl)).rejects.toThrow('boom');
    expect(await postedCount()).toBe(before);
    const [sess] = await db.select().from(importSessions).where(eq(importSessions.id, gl));
    expect(sess).toMatchObject({ status: 'failed', activeCommit: false });
    const [b] = await db.select().from(importBatches).where(eq(importBatches.id, sess!.batchId!));
    expect(b).toMatchObject({ kind: 'single', status: 'failed' });
  });
});
