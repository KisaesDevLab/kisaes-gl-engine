// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

// Desktop change feed (U-294, changes-v1; T6, B4, S7).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { startLanEngine, DEVICE_A, type LanEngine } from '../desktop/lan.test-support.js';

let e: LanEngine;
let jwt = '';
let accA = '';
let accB = '';
const A = { device: DEVICE_A };

async function poll(cursor?: string) {
  const r = await e.call(A, `/api/v1/changes${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`, { jwt });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return r.json as { cursor: string; feedEpoch: string; reset: boolean; changes: Array<{ kind: string; id: string; op: string }> };
}

function jeBody(amount = '3.00') {
  return { txnType: 'journal_entry', txnDate: '2026-03-02', memo: 'feed', lines: [
    { accountId: accA, debit: amount, credit: '0' }, { accountId: accB, debit: '0', credit: amount }] };
}

beforeAll(async () => {
  e = await startLanEngine();
  jwt = await e.signIn(A);
  const r = await e.call(A, '/api/v1/accounts', { jwt });
  const list = (r.json.data ?? r.json.accounts ?? r.json) as Array<{ id: string; accountType: string }>;
  const exp = list.filter((a) => a.accountType === 'expense');
  accA = exp[0]!.id;
  accB = exp[1]!.id;
}, 300_000);

afterAll(async () => {
  await e?.close();
});

describe('change feed (U-294)', () => {
  it('starts with a reset, then reports changed records once; a posting does not report its accounts', async () => {
    const first = await poll();
    expect(first.reset).toBe(true);
    expect(first.changes).toEqual([]);
    const c = await e.call(A, '/api/v1/contacts', { method: 'POST', jwt, body: { contactType: 'vendor', displayName: 'Feed Vendor' } });
    const contactId = (c.json.contact ?? c.json).id as string;
    const t = await e.call(A, '/api/v1/transactions', { method: 'POST', jwt, body: jeBody() });
    const p = await poll(first.cursor);
    expect(p.reset).toBe(false);
    expect(p.changes).toEqual(expect.arrayContaining([
      { kind: 'contacts', id: contactId, op: 'upsert' },
      { kind: 'transactions', id: t.json.transaction.id, op: 'upsert' },
    ]));
    expect(p.changes.some((x) => x.kind === 'accounts')).toBe(false);
    expect((await poll(p.cursor)).changes).toEqual([]);
  });

  it('a transaction that commits late is not skipped (xid horizon)', async () => {
    const start = await poll();
    // Open a desktop connection and write without committing.
    const late = new pg.Client({ connectionString: e.dbUrl, options: '-c mybooks.desktop=on' });
    await late.connect();
    try {
      await late.query('BEGIN');
      const [acc] = (await late.query('SELECT id FROM accounts WHERE id = $1', [accA])).rows;
      await late.query("UPDATE accounts SET name = 'Late Rename' WHERE id = $1", [acc.id]);
      // Meanwhile another write commits and is read.
      const c = await e.call(A, '/api/v1/contacts', { method: 'POST', jwt, body: { contactType: 'vendor', displayName: 'Feed Early' } });
      const mid = await poll(start.cursor);
      expect(mid.changes.some((x) => x.kind === 'accounts')).toBe(false);
      // The horizon stays below the open transaction, so the early change is reported once the late one is too.
      await late.query('COMMIT');
      const after = await poll(mid.cursor);
      const all = [...mid.changes, ...after.changes];
      expect(all).toEqual(expect.arrayContaining([{ kind: 'accounts', id: accA, op: 'upsert' }]));
      expect(all.some((x) => x.id === (c.json.contact ?? c.json).id)).toBe(true);
    } finally {
      await late.end();
    }
  });

  it('renames racing postings to the same account: no deadlock (50 runs)', async () => {
    const stamp = async () => (await e.query<{ s: string }>(
      `SELECT to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS s FROM accounts WHERE id = $1`, [accA]))[0]!.s;
    for (let i = 0; i < 50; i++) {
      const [r1, r2] = await Promise.all([
        e.call(A, `/api/v1/accounts/${accA}`, { method: 'PUT', jwt, body: { name: `Feed Race ${i}`, expectedUpdatedAt: await stamp() } }),
        e.call(A, '/api/v1/transactions', { method: 'POST', jwt, body: jeBody() }),
      ]);
      expect(r1.status, JSON.stringify(r1.json)).toBeLessThan(500);
      expect(r2.status, JSON.stringify(r2.json)).toBe(201);
    }
  });

  it('a hidden account and its entries come as left; a reset or an import changes the epoch', async () => {
    const before = await poll();
    const sB = (await e.query<{ s: string }>(
      `SELECT to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS s FROM accounts WHERE id = $1`, [accB]))[0]!.s;
    const ren = await e.call(A, `/api/v1/accounts/${accB}`, { method: 'PUT', jwt, body: { name: 'Feed Hidden', expectedUpdatedAt: sB } });
    expect(ren.status, JSON.stringify(ren.json)).toBe(200);
    const t = await e.call(A, '/api/v1/transactions', { method: 'POST', jwt, body: jeBody() });
    const { readChanges } = await import('./change-feed.service.js');
    const page = await readChanges(e.company, before.cursor, [accB]);
    expect(page.changes).toEqual(expect.arrayContaining([
      { kind: 'accounts', id: accB, op: 'left' },
      { kind: 'transactions', id: t.json.transaction.id, op: 'left' },
    ]));
    const reset = await e.call('host', '/api/v1/desktop/maintenance/reset', { method: 'POST' });
    expect(reset.status).toBe(200);
    const after = await poll(page.cursor);
    expect(after.reset).toBe(true);
    expect(after.feedEpoch).not.toBe(page.feedEpoch);
  });

  it('for a viewer with hidden accounts a hard-deleted entry comes as left, never as delete (P33 review M5)', async () => {
    const t = await e.call(A, '/api/v1/transactions', { method: 'POST', jwt, body: jeBody('4.00') });
    expect(t.status, JSON.stringify(t.json)).toBe(201);
    const id = t.json.transaction.id as string;
    const before = await poll();
    // A hard delete (as an import undo does): the lines and the header go.
    const c = new pg.Client({ connectionString: e.dbUrl, options: '-c mybooks.desktop=on' });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query('DELETE FROM journal_lines WHERE transaction_id = $1', [id]);
      await c.query('DELETE FROM transactions WHERE id = $1', [id]);
      await c.query('COMMIT');
    } finally {
      await c.end();
    }
    const { readChanges } = await import('./change-feed.service.js');
    const hiddenView = await readChanges(e.company, before.cursor, [accB]);
    expect(hiddenView.changes).toContainEqual({ kind: 'transactions', id, op: 'left' });
    expect(hiddenView.changes.some((x) => x.op === 'delete')).toBe(false);
    // A viewer who sees everything gets the delete.
    expect((await readChanges(e.company, before.cursor, [])).changes).toContainEqual({ kind: 'transactions', id, op: 'delete' });
  });

  it('marking an account sensitive (or unmarking it) makes every client reload (P33 review M5)', async () => {
    for (const isSensitive of [true, false]) {
      const before = await poll();
      const s = (await e.query<{ s: string }>(
        `SELECT to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS s FROM accounts WHERE id = $1`, [accA]))[0]!.s;
      const r = await e.call(A, `/api/v1/accounts/${accA}/sensitive`, { method: 'PUT', jwt, body: { isSensitive, expectedUpdatedAt: s } });
      expect(r.status, JSON.stringify(r.json)).toBe(200);
      const after = await poll(before.cursor);
      expect(after.reset, `isSensitive=${isSensitive}`).toBe(true);
      expect(after.feedEpoch).not.toBe(before.feedEpoch);
    }
  });

  it('a malformed or foreign cursor resets', async () => {
    expect((await poll('nonsense')).reset).toBe(true);
    expect((await poll('abc.12')).reset).toBe(true);
  });
});
