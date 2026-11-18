// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.
//
// Import review fixes (ClientLedger P31 combined review, U-273): the undo
// locks the master records the batch created (S5); a batch a job left
// 'committing' or 'undoing' is settled before the next commit or undo (S6);
// a spreadsheet documents batch keeps no parsed rows after its commit (S7);
// inventory asset accounts are the company's (M4); journal overlap is
// refused across source systems (M5); stored batch errors carry codes and
// rows, never names (M6); open-item amounts are exact text (M8).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'express-async-errors';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { accounts, companies, importBatches, importRows, importSessions, items, journalLines } from '../db/schema/index.js';
import { importsRouter } from './imports.routes.js';
import * as importsService from '../services/imports/imports.service.js';
import * as batchService from '../services/imports/import-batch.service.js';
import { loadCreatedSets } from '../services/imports/import-undo.service.js';
import * as ledger from '../services/ledger.service.js';
import { Harness, type Co, key } from './receivables.test-support.js';
import { uploadSet, upload, glCsv, cleanImports, batchRow, COA_CSV } from './imports-batch.test-support.js';

const h = new Harness();
let c: Co;

beforeEach(async () => {
  h.extraCleanup = [cleanImports];
  await h.start([['/api/v1/imports', importsRouter]]);
  c = await h.company();
});
afterEach(async () => { await h.stop(); });

const post = (p: string, body: unknown) => h.request('POST', `/api/v1/imports${p}`, c.token, body, { 'Idempotency-Key': key() });

async function createBatch(sessionIds: string[], kind = 'conversion', sourceSystem = 'accounting_power', options: Record<string, unknown> = {}) {
  const r = await h.request('POST', '/api/v1/imports/batches', c.token, { sourceSystem, kind, sessionIds, options });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return String(r.json['batch'].id);
}

async function run(p: string, body: Record<string, unknown> = {}) {
  const r = await post(p, body);
  if (r.status === 202) await batchService.__batchJobs.last;
  return r;
}

async function committedSet() {
  const s = await uploadSet(c);
  const id = await createBatch([s.coa, s.vendors, s.tb, s.gl]);
  const r = await run(`/batches/${id}/commit`, {});
  expect(r.status, JSON.stringify(r.json)).toBe(202);
  expect((await batchRow(id)).status).toBe('committed');
  return { id, s };
}

const rowCount = async (sessionId: string) => (await db.select().from(importRows).where(eq(importRows.sessionId, sessionId))).length;

describe('S5: the undo locks the master records the batch created', () => {
  it('with lock, the created accounts and contacts are locked FOR UPDATE until the undo transaction ends', async () => {
    const { id } = await committedSet();
    const [acct] = await db.select().from(accounts).where(and(eq(accounts.tenantId, c.tenantId), eq(accounts.importBatchId, id))).limit(1);
    await db.transaction(async (tx) => {
      const created = await loadCreatedSets(tx, c.tenantId, id, true);
      expect(created.accounts.length).toBeGreaterThan(0);
      expect(created.contacts.length).toBeGreaterThan(0);
      // Another connection can not take even a key-share lock (what a foreign key insert takes).
      await expect(db.execute(sql`SELECT id FROM accounts WHERE id = ${acct!.id} FOR KEY SHARE NOWAIT`))
        .rejects.toMatchObject({ cause: expect.objectContaining({ code: '55P03' }) });
      await expect(db.execute(sql`SELECT id FROM contacts WHERE id = ${created.contacts[0]!} FOR KEY SHARE NOWAIT`))
        .rejects.toMatchObject({ cause: expect.objectContaining({ code: '55P03' }) });
    });
    // Released with the transaction.
    await db.execute(sql`SELECT id FROM accounts WHERE id = ${acct!.id} FOR KEY SHARE NOWAIT`);
  });

  it('a posting that waited on an account the undo deleted fails and leaves no journal line', async () => {
    const { id } = await committedSet();
    const [made] = await db.insert(accounts).values({
      tenantId: c.tenantId, companyId: c.companyId, name: 'Undo Race', accountType: 'expense', importBatchId: id,
    }).returning();
    let posting: Promise<unknown> | null = null;
    await db.transaction(async (tx) => {
      await loadCreatedSets(tx, c.tenantId, id, true);
      await tx.execute(sql`DELETE FROM accounts WHERE id = ${made!.id}`);
      posting = ledger.postTransaction(c.tenantId, {
        txnType: 'journal_entry', txnDate: '2025-06-01', memo: 'race',
        lines: [{ accountId: made!.id, debit: '10', credit: '0' }, { accountId: c.roles['checking']!, debit: '0', credit: '10' }],
      }, c.userId, c.companyId);
      posting.catch(() => undefined);
      // Wait until the posting is blocked on the account row this transaction locked.
      for (let i = 0; i < 100; i++) {
        const w = await db.execute(sql`SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE 'update "accounts"%'`);
        if ((w.rows[0] as { n: number }).n > 0) break;
        await new Promise((r) => setTimeout(r, 50));
      }
    });
    await expect(posting).rejects.toMatchObject({ code: 'ACCOUNT_NOT_FOUND' });
    expect(await db.select().from(journalLines).where(eq(journalLines.accountId, made!.id))).toHaveLength(0);
  });
});

describe('S6: a stuck running batch is settled before the next commit or undo', () => {
  const age = (id: string, minutes: number) =>
    db.execute(sql`UPDATE import_batches SET updated_at = now() - make_interval(mins => ${minutes}) WHERE id = ${id}`);

  it('an old committing batch with no job is failed (IMPORT_INTERRUPTED) and the next commit runs; a fresh one still answers IMPORT_BUSY', async () => {
    const s = await uploadSet(c);
    const stuck = await createBatch([s.coa, s.vendors, s.tb, s.gl]);
    await db.update(importBatches).set({ status: 'committing' }).where(eq(importBatches.id, stuck));
    const coa = await upload(c, 'coa-x.csv', COA_CSV.replace(/9(\d)01/g, '8$101'), 'coa');
    const next = await createBatch([coa]);

    // Fresh: it may be another process between its claim and its job.
    const busy = await post(`/batches/${next}/commit`, {});
    expect([busy.status, busy.json['error'].code]).toEqual([409, 'IMPORT_BUSY']);

    await age(stuck, 10);
    const r = await run(`/batches/${next}/commit`, {});
    expect(r.status, JSON.stringify(r.json)).toBe(202);
    expect((await batchRow(next)).status).toBe('committed');
    const settled = await batchRow(stuck);
    expect(settled.status).toBe('failed');
    expect((settled.error as { code: string }).code).toBe('IMPORT_INTERRUPTED');
  });

  it('an old undoing batch is committed again, and its undo can then run', async () => {
    const { id } = await committedSet();
    await db.update(importBatches).set({ status: 'undoing' }).where(eq(importBatches.id, id));
    await age(id, 10);
    const r = await run(`/batches/${id}/undo`, {});
    expect(r.status, JSON.stringify(r.json)).toBe(202);
    expect((await batchRow(id)).status).toBe('undone');
  });
});

describe('S7: parsed rows of a spreadsheet documents batch go at commit', () => {
  it('kind transactions: no import_rows after the commit; the session still reads; undo still works', async () => {
    const [exp] = await db.select().from(accounts).where(eq(accounts.id, c.roles['expense']!));
    const [inc] = await db.select().from(accounts).where(eq(accounts.id, c.roles['income']!));
    const text = 'group_id,type,date,number,name,due_date,memo,line_account,line_item,line_description,line_amount,line_debit,line_credit,line_tag\r\n'
      + `JE-1,journal_entry,2026-09-30,ADJ-1,,,Reclass,${exp!.name},,,,25.00,,\r\n`
      + `JE-1,journal_entry,2026-09-30,ADJ-1,,,Reclass,${inc!.name},,,,,25.00,\r\n`;
    const out = await importsService.createSession({
      tenantId: c.tenantId, companyId: c.companyId, userId: c.userId,
      file: { originalname: 'transactions.csv', buffer: Buffer.from(text, 'utf8') },
      kind: 'transactions', sourceSystem: 'generic', options: {} as never, role: 'post',
    });
    expect(out.validationErrors).toEqual([]);
    const sid = out.session.id;
    expect(await rowCount(sid)).toBeGreaterThan(0);
    // As the desktop sends it: options {}.
    const id = await createBatch([sid], 'transactions', 'generic', {});
    const r = await run(`/batches/${id}/commit`, {});
    expect(r.status, JSON.stringify(r.json)).toBe(202);
    expect((await batchRow(id)).status).toBe('committed');
    expect(await rowCount(sid)).toBe(0);
    expect((await db.select().from(importSessions).where(eq(importSessions.id, sid)))[0]!.parsedRows).toBeNull();
    const g = await h.request('GET', `/api/v1/imports/${sid}`, c.token);
    expect(g.status, JSON.stringify(g.json)).toBe(200);
    expect(g.json['session'].status).toBe('committed');

    const u = await run(`/batches/${id}/undo`, {});
    expect(u.status, JSON.stringify(u.json)).toBe(202);
    expect((await batchRow(id)).status).toBe('undone');
  });

  it('a conversion batch keeps its parsed rows until verify or undo (the tie-out reads them)', async () => {
    const { s } = await committedSet();
    expect(await rowCount(s.tb)).toBeGreaterThan(0);
    expect(await rowCount(s.gl)).toBeGreaterThan(0);
  });
});

describe('M4: inventory asset accounts are the company\'s', () => {
  it('an inventory part of another company in the tenant does not make its asset account count', async () => {
    const [other] = await db.insert(companies).values({ tenantId: c.tenantId, businessName: 'Other Books', setupComplete: true }).returning();
    const [asset] = await db.insert(accounts).values({
      tenantId: c.tenantId, companyId: other!.id, name: 'Other Stock', accountType: 'asset', detailType: 'inventory',
    }).returning();
    await db.insert(items).values({
      tenantId: c.tenantId, companyId: other!.id, name: 'Other Widget', itemType: 'inventory_part',
      incomeAccountId: c.roles['income']!, expenseAccountId: c.roles['expense']!, cogsAccountId: c.roles['expense']!, assetAccountId: asset!.id,
    });
    expect(await importsService.inventoryAssetAccountIds(db, c.tenantId, c.companyId)).not.toContain(asset!.id);
    expect(await importsService.inventoryAssetAccountIds(db, c.tenantId, other!.id)).toContain(asset!.id);
  });
});

describe('M5: journal overlap is refused across source systems', () => {
  it('a Generic journal over months a committed Accounting Power journal holds is 409 IMPORT_PERIOD_OVERLAP', async () => {
    await committedSet();
    const text = 'Date,Account,Amount,Offset Account,Description\r\n2025-02-15,9101,10.00,9401,Late sale\r\n';
    await expect(importsService.createSession({
      tenantId: c.tenantId, companyId: c.companyId, userId: c.userId,
      file: { originalname: 'generic-gl.csv', buffer: Buffer.from(text, 'utf8') },
      kind: 'gl_transactions', sourceSystem: 'generic', options: {} as never, role: 'post',
    })).rejects.toMatchObject({ code: 'IMPORT_PERIOD_OVERLAP' });
    // Months the committed journal does not hold still import.
    const later = 'Date,Account,Amount,Offset Account,Description\r\n2025-08-15,9101,10.00,9401,Late sale\r\n';
    const ok = await importsService.createSession({
      tenantId: c.tenantId, companyId: c.companyId, userId: c.userId,
      file: { originalname: 'generic-gl-2.csv', buffer: Buffer.from(later, 'utf8') },
      kind: 'gl_transactions', sourceSystem: 'generic', options: {} as never, role: 'post',
    });
    expect(ok.session.id).toBeTruthy();
  });
});

describe('M6: stored batch errors carry codes and rows, never names', () => {
  it('an unmapped account fails the batch with a message that names nothing; the mapping list stays in details', async () => {
    const coa = await upload(c, 'coa.csv', COA_CSV, 'coa');
    const gl = await upload(c, 'gl.csv', glCsv(2025, [1], '9999'), 'gl_transactions');
    const id = await createBatch([coa, gl]);
    const r = await run(`/batches/${id}/commit`, {});
    expect(r.status).toBe(202);
    const b = await batchRow(id);
    expect(b.status).toBe('failed');
    const err = b.error as { code: string; message: string; rowNumber?: number; details?: Record<string, unknown> };
    expect(err.code).toBe('IMPORT_UNMAPPED_ACCOUNT');
    expect(err.message).toBe(batchService.storedErrorMessage(err.code, err.rowNumber));
    expect(err.message).not.toMatch(/9999|Nowhere/);
    expect(err.details?.['unmappedAccountKeys']).toEqual(['9999']);
    const stored = JSON.stringify(b.error);
    expect(stored).not.toContain('Nowhere');
  });

  it('storedErrorMessage says the code and the row only', () => {
    expect(batchService.storedErrorMessage('IMPORT_VALUATION_MISMATCH', 12)).toBe('The import stopped at row 12 (IMPORT_VALUATION_MISMATCH).');
    expect(batchService.storedErrorMessage('IMPORT_POST_FAILED')).toBe('The import stopped (IMPORT_POST_FAILED).');
  });
});

describe('M8: open-item amounts are exact text', () => {
  it('absolute value, at least 2 places, never rounded', () => {
    expect(importsService.openItemAmountText('-12.3')).toBe('12.30');
    expect(importsService.openItemAmountText('100')).toBe('100.00');
    expect(importsService.openItemAmountText('0.05')).toBe('0.05');
    expect(importsService.openItemAmountText('-1234567.89')).toBe('1234567.89');
    expect(importsService.openItemAmountText('1.005')).toBe('1.005');
  });
});
