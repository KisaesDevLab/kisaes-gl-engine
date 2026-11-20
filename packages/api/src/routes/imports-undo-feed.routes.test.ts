// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.
//
// Bulk Import undo with the desktop triggers on (U-294 follow-up): rows only
// triggers write (the change feed, the ledger version counters) are
// bookkeeping, never activity. They neither block an undo nor count as a
// pointer left behind; the undo's own deletes add feed rows, as they should.
// Real blockers (a later posting, a live payment) still block. The file turns
// the triggers on for its own connections (PGOPTIONS, read by pg at connect),
// whatever the suite runs with, and checks that they are on.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import 'express-async-errors';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { transactions, accounts } from '../db/schema/index.js';
import { importsRouter } from './imports.routes.js';
import { paymentsRouter } from './payments.routes.js';
import * as batchService from '../services/imports/import-batch.service.js';
import { loadCreatedSets, findPointers, sweepColumns, TRIGGER_WRITTEN_TABLES } from '../services/imports/import-undo.service.js';
import * as ledger from '../services/ledger.service.js';
import { Harness, type Co, key } from './receivables.test-support.js';
import { uploadSet, companySnapshot, cleanImports, batchRow } from './imports-batch.test-support.js';

const priorPgOptions = process.env['PGOPTIONS'];
beforeAll(() => {
  // Before the first query of this file: the pool's connections are made lazily and read PGOPTIONS then.
  process.env['PGOPTIONS'] = '-c mybooks.desktop=on';
});
afterAll(() => {
  if (priorPgOptions === undefined) delete process.env['PGOPTIONS'];
  else process.env['PGOPTIONS'] = priorPgOptions;
});

const h = new Harness();
let c: Co;

beforeEach(async () => {
  h.extraCleanup = [cleanImports];
  await h.start([['/api/v1/imports', importsRouter], ['/api/v1/payments', paymentsRouter]]);
  c = await h.company();
});
afterEach(async () => { await h.stop(); });

const post = (p: string, body: unknown) =>
  h.request('POST', `/api/v1/imports${p}`, c.token, body, { 'Idempotency-Key': key() });

async function run(p: string, body: Record<string, unknown> = {}) {
  const r = await post(p, body);
  if (r.status === 202) await batchService.__batchJobs.last;
  return r;
}

async function committedSet() {
  const s = await uploadSet(c);
  const r0 = await h.request('POST', '/api/v1/imports/batches', c.token, {
    sourceSystem: 'accounting_power', kind: 'conversion', sessionIds: [s.coa, s.vendors, s.tb, s.gl], options: {},
  });
  expect(r0.status, JSON.stringify(r0.json)).toBe(201);
  const id = String(r0.json['batch'].id);
  const r = await run(`/batches/${id}/commit`, { backupRef: 'before-import.clb' });
  expect(r.status, JSON.stringify(r.json)).toBe(202);
  expect((await batchRow(id)).status).toBe('committed');
  return id;
}

async function feedOps(ids: string[]): Promise<Array<{ entity_id: string; op: string }>> {
  if (ids.length === 0) return [];
  return (await db.execute(sql`SELECT entity_id::text AS entity_id, op FROM change_feed
    WHERE entity_id = ANY(${`{${ids.join(',')}}`}::uuid[])`)).rows as Array<{ entity_id: string; op: string }>;
}

function noTriggerKinds(blockers: Array<{ kind: string }>) {
  for (const b of blockers) expect(TRIGGER_WRITTEN_TABLES.has(b.kind.split('.')[0]!), b.kind).toBe(false);
}

describe('import undo with the desktop triggers on (U-294 follow-up)', () => {
  it('the triggers are on for this file', async () => {
    const r = await db.execute(sql`SELECT current_setting('mybooks.desktop', true) AS v`);
    expect((r.rows[0] as { v: string | null }).v).toBe('on');
  });

  it('change-feed rows naming the batch records do not block the undo; the undo deletes everything and feeds the deletes', async () => {
    const before = await companySnapshot(c);
    const id = await committedSet();
    const created = await db.transaction((tx) => loadCreatedSets(tx, c.tenantId, id));
    const ids = [...created.txns, ...created.accounts, ...created.contacts];
    expect(created.txns.length).toBeGreaterThan(0);
    // The commit fed every created header record.
    const fed = await feedOps(ids);
    expect(new Set(fed.filter((x) => x.op === 'upsert').map((x) => x.entity_id))).toEqual(new Set(ids));

    const r = await run(`/batches/${id}/undo`, { backupRef: 'before-undo.clb' });
    expect(r.status, JSON.stringify(r.json)).toBe(202);
    const after = await batchRow(id);
    expect(after.status, JSON.stringify(after.error)).toBe('undone');
    expect(await companySnapshot(c)).toEqual(before);
    expect(await db.select().from(transactions).where(eq(transactions.importBatchId, id))).toHaveLength(0);
    // Its own deletes are fed (one delete per record), and the feed is not a pointer left behind.
    const deleted = new Set((await feedOps(ids)).filter((x) => x.op === 'delete').map((x) => x.entity_id));
    expect(deleted).toEqual(new Set(ids));
    const left = await db.transaction((tx) => findPointers(tx, c.tenantId, [...ids, ...created.lines]));
    expect(left).toEqual([]);
  });

  it('a later posting on an imported account still blocks, and no trigger-written row is listed', async () => {
    const id = await committedSet();
    const [cash] = await db.select().from(accounts).where(and(eq(accounts.tenantId, c.tenantId), eq(accounts.accountNumber, '9101')));
    await ledger.postTransaction(c.tenantId, {
      txnType: 'journal_entry', txnDate: '2025-06-01', memo: 'later',
      lines: [{ accountId: cash!.id, debit: '10', credit: '0' }, { accountId: c.roles['expense']!, debit: '0', credit: '10' }],
    }, c.userId, c.companyId);
    const r = await post(`/batches/${id}/undo`, {});
    expect(r.status).toBe(409);
    expect(r.json['error'].code).toBe('IMPORT_UNDO_BLOCKED');
    const blockers = r.json['error'].details.blockers as Array<{ kind: string; reason: string; target: string }>;
    expect(blockers).toContainEqual(expect.objectContaining({ kind: 'journal_lines.account_id', reason: 'used_by_other_transaction', target: cash!.id }));
    noTriggerKinds(blockers);
    expect((await batchRow(id)).status).toBe('committed');
  });

  it('a live payment on an imported invoice still blocks (payment_applied), and no trigger-written row is listed', async () => {
    const id = await committedSet();
    const inv = await h.invoice(c, { date: '2025-03-20', total: '250.00' });
    await db.update(transactions).set({ importBatchId: id }).where(eq(transactions.id, inv));
    await db.execute(sql`UPDATE import_batches SET prior_values = jsonb_set(prior_values, '{stamps,linesCreatedMax}',
      to_jsonb((SELECT MAX(created_at)::text FROM journal_lines WHERE transaction_id = ${inv}))) WHERE id = ${id}`);
    const pay = await h.request('POST', '/api/v1/payments/receive', c.token, {
      customerId: c.customer, date: '2026-11-10', amount: '100.00', depositTo: c.roles['checking'], applications: [{ invoiceId: inv, amount: '100.00' }],
    }, { 'Idempotency-Key': key() });
    expect([200, 201], JSON.stringify(pay.json)).toContain(pay.status);
    const r = await post(`/batches/${id}/undo`, {});
    expect(r.status).toBe(409);
    const blockers = r.json['error'].details.blockers as Array<{ kind: string; reason: string; target?: string }>;
    expect(blockers).toContainEqual(expect.objectContaining({ reason: 'payment_applied', target: inv }));
    noTriggerKinds(blockers);
  });

  it('every table a trigger function writes is classified, and the sweep reads none of them', async () => {
    const fns = (await db.execute(sql`SELECT DISTINCT p.proname, p.prosrc FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
      WHERE NOT t.tgisinternal`)).rows as Array<{ proname: string; prosrc: string }>;
    const targets = new Set<string>();
    for (const f of fns) for (const m of f.prosrc.matchAll(/\binsert\s+into\s+([a-z_][a-z0-9_]*)/gi)) targets.add(m[1]!.toLowerCase());
    expect(targets.size).toBeGreaterThan(0);
    // A new table a trigger inserts into: list it in TRIGGER_WRITTEN_TABLES (bookkeeping) or classify it as activity here.
    for (const t of targets) expect(TRIGGER_WRITTEN_TABLES.has(t), `trigger-written table ${t}`).toBe(true);
    const swept = new Set((await sweepColumns(db)).map((x) => x.table));
    for (const t of TRIGGER_WRITTEN_TABLES) expect(swept.has(t), t).toBe(false);
  });
});
