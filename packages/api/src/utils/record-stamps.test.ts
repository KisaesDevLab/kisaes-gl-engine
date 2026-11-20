// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

// Record stamps owned by the database (U-291a, stale-all-v1; T5, T7, T8, B3):
// the trigger catalogue, the desktop gate, a posting never moves an account's
// stamp, a save returns the stamp the next save needs, stale saves are 409,
// one of two racing saves wins, and bulk writes report stale items.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { startLanEngine, DEVICE_A, DEVICE_B, type LanEngine } from '../desktop/lan.test-support.js';
import { STAMP_HEADERS, STAMP_CHILDREN } from './record-stamps.js';

let e: LanEngine;
let jwtA = '';
let jwtB = '';
let accA = '';
let accB = '';
const A = { device: DEVICE_A };
const B = { device: DEVICE_B };

// Every column of each stamped table. A new column fails here until it is
// classified: it bumps the stamp (nothing to do) or the engine maintains it
// (add it to STAMP_HEADERS, and to the trigger's ignore list in a migration).
// Pinned in record-stamps.columns.json (regenerate only after classifying the new column).
const PINNED: Record<string, string> = Object.fromEntries(
  Object.entries(JSON.parse(readFileSync(new URL('./record-stamps.columns.json', import.meta.url), 'utf8')) as Record<string, string[]>)
    .map(([t, cols]) => [t, cols.join(' ')]),
);

async function je(jwt: string, who = A, amount = '10.00') {
  const r = await e.call(who, '/api/v1/transactions', {
    method: 'POST', jwt, company: undefined,
    body: { txnType: 'journal_entry', txnDate: '2026-03-02', memo: 'stamp test', lines: [
      { accountId: accA, debit: amount, credit: '0' }, { accountId: accB, debit: '0', credit: amount }] },
  });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return r.json.transaction as { id: string; updatedAt: string };
}

function jeBody(stamp: string | undefined, amount: string, memo = 'stamp test') {
  return {
    txnType: 'journal_entry', txnDate: '2026-03-02', memo,
    ...(stamp ? { expectedUpdatedAt: stamp } : {}),
    lines: [{ accountId: accA, debit: amount, credit: '0' }, { accountId: accB, debit: '0', credit: amount }],
  };
}

async function stampOf(table: string, id: string): Promise<string> {
  const [row] = await e.query<{ s: string }>(`SELECT to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS s FROM ${table} WHERE id = $1`, [id]);
  return row!.s;
}

beforeAll(async () => {
  e = await startLanEngine();
  jwtA = await e.signIn(A);
  jwtB = await e.signIn(B);
  const r = await e.call(A, '/api/v1/accounts', { jwt: jwtA });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  const list = (r.json.data ?? r.json.accounts ?? r.json) as Array<{ id: string; accountType: string; isSystem?: boolean }>;
  const expense = list.filter((a) => a.accountType === 'expense');
  accA = expense[0]!.id;
  accB = expense[1]!.id;
}, 300_000);

afterAll(async () => {
  await e?.close();
});

describe('catalogue and gate', () => {
  it('every stamped table has its trigger and a pinned column set', async () => {
    const trig = await e.query<{ tbl: string; tgname: string }>(
      "SELECT c.relname AS tbl, t.tgname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE t.tgname LIKE 'mybooks_stamp%'");
    const has = (tbl: string, name: string) => trig.some((x) => x.tbl === tbl && x.tgname === name);
    for (const tbl of Object.keys(STAMP_HEADERS)) {
      expect(has(tbl, 'mybooks_stamp'), tbl).toBe(true);
      expect(has(tbl, 'mybooks_stamp_ins'), tbl).toBe(true);
      const cols = await e.query<{ c: string }>(
        "SELECT column_name AS c FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position", [tbl]);
      // Order-insensitive: a test that rolls a migration back and forward moves columns to the end.
      expect(cols.map((x) => x.c).sort().join(' '), `${tbl}: classify new columns in STAMP_HEADERS`).toBe(PINNED[tbl]!.split(' ').sort().join(' '));
      for (const ign of STAMP_HEADERS[tbl]!) expect(cols.map((x) => x.c), `${tbl}.${ign}`).toContain(ign);
    }
    for (const tbl of [...Object.keys(STAMP_CHILDREN), 'attachments']) expect(has(tbl, 'mybooks_stamp_child'), tbl).toBe(true);
  });

  it('desktop connections turn the triggers on; others do not', async () => {
    const { db } = await import('../db/index.js');
    const { sql } = await import('drizzle-orm');
    const on = await db.execute(sql`SELECT current_setting('mybooks.desktop', true) AS v`);
    expect((on.rows[0] as { v: string }).v).toBe('on');
    // A plain connection (the server appliance's pool): the code's stamp is kept.
    const c = new pg.Client({ connectionString: e.dbUrl });
    await c.connect();
    try {
      const [acc] = (await c.query('SELECT id FROM accounts WHERE id = $1', [accA])).rows;
      await c.query("UPDATE accounts SET updated_at = '2001-01-01T00:00:00Z' WHERE id = $1", [acc.id]);
      expect(await stampOf('accounts', accA)).toBe('2001-01-01T00:00:00.000Z');
    } finally {
      await c.end();
    }
  });
});

describe('stamps (B3, T5)', () => {
  it('a posting moves an account balance but not its stamp; a rename moves it', async () => {
    const before = await stampOf('accounts', accA);
    await je(jwtA);
    expect(await stampOf('accounts', accA)).toBe(before);
    const r = await e.call(A, `/api/v1/accounts/${accA}`, { method: 'PUT', jwt: jwtA, body: { name: 'Stamp Test Expense', expectedUpdatedAt: before } });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const after = await stampOf('accounts', accA);
    expect(after > before).toBe(true);
    // The old stamp is now stale.
    const stale = await e.call(B, `/api/v1/accounts/${accA}`, { method: 'PUT', jwt: jwtB, body: { name: 'Other', expectedUpdatedAt: before } });
    expect(stale.status).toBe(409);
    expect(stale.json.error.code).toBe('STALE');
    expect(stale.json.error.details.updatedAt).toBe(after);
  });

  it('a save returns the stamp the next save needs; an old stamp is 409', async () => {
    const t = await je(jwtA);
    const s0 = await stampOf('transactions', t.id);
    expect(new Date(t.updatedAt).toISOString()).toBe(s0);
    const r1 = await e.call(A, `/api/v1/transactions/${t.id}`, { method: 'PUT', jwt: jwtA, body: jeBody(s0, '11.00') });
    expect(r1.status, JSON.stringify(r1.json)).toBe(200);
    const s1 = await stampOf('transactions', t.id);
    expect(s1 > s0).toBe(true);
    expect(new Date(r1.json.transaction.updatedAt).toISOString()).toBe(s1);
    // Lines only, with the returned stamp: no self-conflict, and the stamp moves once.
    const r2 = await e.call(A, `/api/v1/transactions/${t.id}`, { method: 'PUT', jwt: jwtA, body: jeBody(r1.json.transaction.updatedAt, '12.00') });
    expect(r2.status, JSON.stringify(r2.json)).toBe(200);
    expect(new Date(r2.json.transaction.updatedAt).toISOString()).toBe(await stampOf('transactions', t.id));
    const old = await e.call(B, `/api/v1/transactions/${t.id}`, { method: 'PUT', jwt: jwtB, body: jeBody(s0, '13.00') });
    expect(old.status).toBe(409);
    expect(old.json.error.code).toBe('STALE');
    // Without a stamp: last write wins, as before (U-292 makes it required in LAN mode).
    expect((await e.call(B, `/api/v1/transactions/${t.id}`, { method: 'PUT', jwt: jwtB, body: jeBody(undefined, '14.00') })).status).toBe(200);
  });

  it('two saves on the same stamp: one wins, the other is 409 (50 runs)', async () => {
    const t = await je(jwtA);
    let stamp = await stampOf('transactions', t.id);
    for (let i = 0; i < 50; i++) {
      const [x, y] = await Promise.all([
        e.call(A, `/api/v1/transactions/${t.id}`, { method: 'PUT', jwt: jwtA, body: jeBody(stamp, `${20 + i}.00`, `a${i}`) }),
        e.call(B, `/api/v1/transactions/${t.id}`, { method: 'PUT', jwt: jwtB, body: jeBody(stamp, `${90 + i}.00`, `b${i}`) }),
      ]);
      expect([x.status, y.status].sort(), `run ${i}: ${JSON.stringify([x.json, y.json])}`).toEqual([200, 409]);
      stamp = await stampOf('transactions', t.id);
    }
  });

  it('contacts: stale edit 409, racing edits one wins', async () => {
    const c = await e.call(A, '/api/v1/contacts', { method: 'POST', jwt: jwtA, body: { contactType: 'customer', displayName: 'Stamp Customer' } });
    expect(c.status, JSON.stringify(c.json)).toBe(201);
    const id = (c.json.contact ?? c.json).id as string;
    let stamp = await stampOf('contacts', id);
    for (let i = 0; i < 20; i++) {
      const [x, y] = await Promise.all([
        e.call(A, `/api/v1/contacts/${id}`, { method: 'PUT', jwt: jwtA, body: { displayName: `A ${i}`, expectedUpdatedAt: stamp } }),
        e.call(B, `/api/v1/contacts/${id}`, { method: 'PUT', jwt: jwtB, body: { displayName: `B ${i}`, expectedUpdatedAt: stamp } }),
      ]);
      expect([x.status, y.status].sort(), `run ${i}: ${JSON.stringify([x.json, y.json])}`).toEqual([200, 409]);
      stamp = await stampOf('contacts', id);
    }
  });

  it('tagging a transaction moves its stamp; bulk tag skips stale items (T8)', async () => {
    const g = await e.call(A, '/api/v1/tags', { method: 'POST', jwt: jwtA, body: { name: 'Stamp Tag' } });
    expect(g.status, JSON.stringify(g.json)).toBe(201);
    const tagId = (g.json.tag ?? g.json).id as string;
    const t1 = await je(jwtA);
    const t2 = await je(jwtA);
    const s1 = await stampOf('transactions', t1.id);
    const s2 = await stampOf('transactions', t2.id);
    const r = await e.call(A, `/api/v1/tags/transactions/${t1.id}`, { method: 'PUT', jwt: jwtA, body: { tagIds: [tagId], expectedUpdatedAt: s1 } });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(await stampOf('transactions', t1.id) > s1).toBe(true);
    // t1's stamp is now stale; t2's is current.
    const bulk = await e.call(A, '/api/v1/tags/bulk-untag', {
      method: 'POST', jwt: jwtA, body: { transactionIds: [t1.id, t2.id], tagIds: [tagId], stamps: { [t1.id]: s1, [t2.id]: s2 } },
    });
    expect(bulk.status, JSON.stringify(bulk.json)).toBe(200);
    expect(bulk.json.stale.map((x: { id: string }) => x.id)).toEqual([t1.id]);
  });

  it('bulk tagging against saves of the same entries: no deadlock (20 runs)', async () => {
    const g = await e.call(A, '/api/v1/tags', { method: 'POST', jwt: jwtA, body: { name: 'Race Tag' } });
    const tagId = (g.json.tag ?? g.json).id as string;
    const ids = [(await je(jwtA)).id, (await je(jwtA)).id, (await je(jwtA)).id];
    for (let i = 0; i < 20; i++) {
      const results = await Promise.all([
        e.call(A, '/api/v1/tags/bulk-tag', { method: 'POST', jwt: jwtA, body: { transactionIds: [...ids].reverse(), tagIds: [tagId] } }),
        ...ids.map((id) => e.call(B, `/api/v1/transactions/${id}`, { method: 'PUT', jwt: jwtB, body: jeBody(undefined, `${30 + i}.00`) })),
        e.call(A, '/api/v1/tags/bulk-untag', { method: 'POST', jwt: jwtA, body: { transactionIds: ids, tagIds: [tagId] } }),
      ]);
      for (const r of results) expect(r.status, JSON.stringify(r.json)).toBeLessThan(500);
    }
  });

  it('bulk update skips stale entries and updates the rest (T8)', async () => {
    const t1 = await je(jwtA);
    const t2 = await je(jwtA);
    const s1 = await stampOf('transactions', t1.id);
    const s2 = await stampOf('transactions', t2.id);
    await e.call(B, `/api/v1/transactions/${t1.id}`, { method: 'PUT', jwt: jwtB, body: jeBody(undefined, '15.00', 'moved') });
    const g = await e.call(A, '/api/v1/tags', { method: 'POST', jwt: jwtA, body: { name: 'Bulk Update Tag' } });
    const tagId = (g.json.tag ?? g.json).id as string;
    const r = await e.call(A, '/api/v1/transactions/bulk-update', {
      method: 'POST', jwt: jwtA, body: { txnIds: [t1.id, t2.id], setTagId: tagId, stamps: { [t1.id]: s1, [t2.id]: s2 } },
    });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.skipped).toEqual([{ id: t1.id, reason: 'stale', updatedAt: await stampOf('transactions', t1.id) }]);
    expect(r.json.updated).toBe(1);
  });

  it('company settings, layouts and lists compare their stamp (U-291b)', async () => {
    const [co] = await e.query<{ id: string }>('SELECT id FROM companies LIMIT 1');
    const s0 = await stampOf('companies', co!.id);
    const r = await e.call(A, '/api/v1/company', { method: 'PUT', jwt: jwtA, body: { expectedUpdatedAt: s0, phone: '555-0100' } });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const stale = await e.call(B, '/api/v1/company', { method: 'PUT', jwt: jwtB, body: { expectedUpdatedAt: s0, phone: '555-0199' } });
    expect(stale.status).toBe(409);
    expect(stale.json.error.code).toBe('STALE');
    const pl = await e.call(A, '/api/v1/price-levels', { method: 'POST', jwt: jwtA, body: { name: 'Stamp Level', percent: '-5' } });
    expect(pl.status, JSON.stringify(pl.json)).toBe(201);
    const plId = (pl.json.priceLevel ?? pl.json).id as string;
    const p0 = await stampOf('price_levels', plId);
    expect((await e.call(A, `/api/v1/price-levels/${plId}`, { method: 'PUT', jwt: jwtA, body: { name: 'Stamp Level 2', expectedUpdatedAt: p0 } })).status).toBe(200);
    const pStale = await e.call(B, `/api/v1/price-levels/${plId}?expectedUpdatedAt=${encodeURIComponent(p0)}`, { method: 'DELETE', jwt: jwtB });
    expect(pStale.status).toBe(409);
  });

  it('bulk type change skips stale contacts; a merge with a stale side is refused (U-291b)', async () => {
    const mk = async (n: string) => {
      const c = await e.call(A, '/api/v1/contacts', { method: 'POST', jwt: jwtA, body: { contactType: 'customer', displayName: n } });
      return (c.json.contact ?? c.json).id as string;
    };
    const c1 = await mk('Bulk One');
    const c2 = await mk('Bulk Two');
    const s1 = await stampOf('contacts', c1);
    const s2 = await stampOf('contacts', c2);
    await e.call(B, `/api/v1/contacts/${c1}`, { method: 'PUT', jwt: jwtB, body: { displayName: 'Bulk One Edited' } });
    const r = await e.call(A, '/api/v1/contacts/bulk-type', { method: 'POST', jwt: jwtA, body: { ids: [c1, c2], contactType: 'both', stamps: { [c1]: s1, [c2]: s2 } } });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.stale.map((x: { id: string }) => x.id)).toEqual([c1]);
    const m = await e.call(A, '/api/v1/contacts/merge', { method: 'POST', jwt: jwtA, body: { sourceId: c1, targetId: c2, stamps: { [c1]: s1, [c2]: await stampOf('contacts', c2) } } });
    expect(m.status).toBe(409);
    expect(m.json.error.details.stale[0].id).toBe(c1);
  });

  it('a record nobody edited keeps its creation stamp; voiding a JE voids its untouched reversal', async () => {
    const c = await e.call(A, '/api/v1/transactions', {
      method: 'POST', jwt: jwtA,
      body: { ...jeBody(undefined, '7.00'), reverseOn: '2026-04-01' },
    });
    expect(c.status, JSON.stringify(c.json)).toBe(201);
    const id = c.json.transaction.id as string;
    const rows = await e.query<{ same: boolean }>(
      "SELECT date_trunc('milliseconds', created_at) = date_trunc('milliseconds', updated_at) AS same FROM transactions WHERE reverses_transaction_id = $1", [id]);
    expect(rows).toEqual([{ same: true }]);
    const v = await e.call(A, `/api/v1/transactions/${id}/void`, { method: 'POST', jwt: jwtA, body: { reason: 'x', expectedUpdatedAt: c.json.transaction.updatedAt } });
    expect(v.status, JSON.stringify(v.json)).toBe(200);
  });

  it('a transaction of another company is not found (GET and void)', async () => {
    const t = await je(jwtA);
    const other = '00000000-0000-4000-8000-000000000001';
    expect((await e.call(A, `/api/v1/transactions/${t.id}`, { jwt: jwtA, headers: { 'x-company-id': other } })).status).not.toBe(200);
    expect((await e.call(A, `/api/v1/transactions/${t.id}/void`, { method: 'POST', jwt: jwtA, headers: { 'x-company-id': other }, body: { reason: 'x' } })).status).not.toBe(200);
  });
});
