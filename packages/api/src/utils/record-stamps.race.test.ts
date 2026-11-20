// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

// Record stamps under load (U-291 follow-up, ClientLedger P33 soak): five
// workstations save the same shared journal entries and expenses from one
// read stamp while every one of them also posts new entries on the same two
// accounts (the soak's mix). At most one save per read stamp is accepted;
// the others are 409 STALE (or 409 RETRY: nothing saved). Before the fix a
// deadlock retry inside the engine re-ran the save without its stamp check,
// so two saves from one read were both accepted (a lost update).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { startLanEngine, DEVICE_A, DEVICE_B, type LanEngine } from '../desktop/lan.test-support.js';

const CLIENTS = 5;
const SHARED = 3;
const ROUNDS = 200;
const DEVICES = [DEVICE_A, DEVICE_B, 'c3'.repeat(32), 'd4'.repeat(32), 'e5'.repeat(32)];

let e: LanEngine;
const who = DEVICES.map((device) => ({ device }));
const jwt: string[] = [];
let bank = '';
let supplies = '';

beforeAll(async () => {
  // Each sign-in (login, then switch into the company) keeps its own chain.
  e = await startLanEngine({ env: { MAX_SESSIONS_PER_USER: String(4 * CLIENTS) } });
  for (let c = 0; c < CLIENTS; c++) jwt.push(await e.signIn(who[c]!));
  const r = await e.call(who[0]!, '/api/v1/accounts', { jwt: jwt[0] });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  const list = (r.json.data ?? r.json.accounts ?? r.json) as Array<{ id: string; accountType: string; detailType?: string | null }>;
  bank = (list.find((a) => a.accountType === 'asset' && a.detailType === 'bank') ?? list.find((a) => a.accountType === 'asset'))!.id;
  supplies = list.find((a) => a.accountType === 'expense')!.id;
}, 300_000);

afterAll(async () => {
  await e?.close();
});

type Kind = 'journal_entry' | 'expense';

function body(kind: Kind, memo: string, amount: string, stamp?: string) {
  const s = stamp ? { expectedUpdatedAt: stamp } : {};
  return kind === 'journal_entry'
    ? { txnType: kind, txnDate: '2026-03-02', memo, ...s,
      lines: [{ accountId: supplies, debit: amount, credit: '0' }, { accountId: bank, debit: '0', credit: amount }] }
    : { txnType: kind, txnDate: '2026-03-02', memo, ...s, payFromAccountId: bank,
      lines: [{ expenseAccountId: supplies, amount }] };
}

async function stampOf(id: string): Promise<{ stamp: string; memo: string | null }> {
  const [row] = await e.query<{ s: string; memo: string | null }>(
    `SELECT to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS s, memo FROM transactions WHERE id = $1`, [id]);
  return { stamp: row!.s, memo: row!.memo };
}

async function race(kind: Kind) {
  const shared: string[] = [];
  for (let k = 0; k < SHARED; k++) {
    const r = await e.call(who[0]!, '/api/v1/transactions', { method: 'POST', jwt: jwt[0], body: body(kind, `shared ${k}`, '1.00') });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    shared.push(r.json.transaction.id);
  }
  const lost: string[] = [];
  const failures: string[] = [];
  let accepted = 0;
  let stale = 0;
  let retry = 0;
  for (let round = 0; round < ROUNDS; round++) {
    // Every shared record, read once; each client saves the record of its
    // turn from that read (different content per client), and posts a new
    // entry on the same two accounts, all at once.
    const reads = await Promise.all(shared.map((id) => stampOf(id)));
    const results = await Promise.all(Array.from({ length: CLIENTS }, async (_, c) => {
      const k = (round + c) % SHARED;
      const [save] = await Promise.all([
        e.call(who[c]!, `/api/v1/transactions/${shared[k]}`, {
          method: 'PUT', jwt: jwt[c], body: body(kind, `shared ${k} round ${round} by ${c}`, '1.00', reads[k]!.stamp),
        }),
        e.call(who[c]!, '/api/v1/transactions', {
          method: 'POST', jwt: jwt[c], body: body(kind, `new ${round} by ${c}`, `${1 + ((round * 7 + c) % 9)}.00`),
        }).then((r) => { if (r.status !== 201) failures.push(`create ${r.status} ${JSON.stringify(r.json)}`); }),
      ]);
      return { k, c, save: save! };
    }));
    for (let k = 0; k < SHARED; k++) {
      const mine = results.filter((x) => x.k === k);
      const won = mine.filter((x) => x.save.status === 200);
      accepted += won.length;
      for (const x of mine) {
        if (x.save.status === 409 && x.save.json?.error?.code === 'STALE') stale++;
        else if (x.save.status === 409 && x.save.json?.error?.code === 'RETRY') retry++;
        else if (x.save.status !== 200) failures.push(`save ${x.save.status} ${JSON.stringify(x.save.json)}`);
      }
      if (won.length > 1) lost.push(`round ${round} record ${k}: ${won.length} saves accepted from read ${reads[k]!.stamp}`);
      if (won.length === 1) {
        const now = await stampOf(shared[k]!);
        if (now.memo !== `shared ${k} round ${round} by ${won[0]!.c}`) lost.push(`round ${round} record ${k}: stored ${now.memo}`);
      }
    }
  }
  console.log(`[race ${kind}] ${CLIENTS} clients x ${ROUNDS} rounds: ${accepted} accepted, ${stale} stale, ${retry} retry, ${lost.length} lost, ${failures.length} failures`);
  expect(failures, failures.slice(0, 5).join('\n')).toEqual([]);
  expect(lost, lost.slice(0, 5).join('\n')).toEqual([]);
  expect(accepted).toBeGreaterThan(ROUNDS);
  // The books still balance: every account's balance is the sum of its lines.
  const off = await e.query<{ id: string }>(`
    SELECT a.id FROM accounts a
    LEFT JOIN (SELECT jl.account_id, SUM(jl.debit - jl.credit) AS net FROM journal_lines jl
      JOIN transactions t ON t.id = jl.transaction_id WHERE t.status = 'posted' GROUP BY jl.account_id) s ON s.account_id = a.id
    WHERE a.id IN ($1, $2) AND COALESCE(s.net, 0) <> a.balance`, [bank, supplies]);
  expect(off).toEqual([]);
}

/** A connection as the desktop engine opens them (stamp triggers on), or off (the server appliance, an archive import). */
async function onConn<T>(desktop: boolean, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: e.dbUrl, options: `-c mybooks.desktop=${desktop ? 'on' : 'off'}` });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

describe('stamps strictly increase', () => {
  it('back-to-back commits within the same millisecond each move the stamp by at least 1 ms', async () => {
    const r = await e.call(who[0]!, '/api/v1/transactions', { method: 'POST', jwt: jwt[0], body: body('journal_entry', 'ticks', '1.00') });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    const id = r.json.transaction.id as string;
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const ticks = 200;
    const rows = await onConn(true, async (c) => {
      await c.query('CREATE TEMP TABLE stamps_seen (n int, s timestamptz, at timestamptz)');
      // One commit per edit, microseconds apart: many land in the same millisecond.
      await c.query(`DO $$ BEGIN
        FOR i IN 1..${ticks} LOOP
          UPDATE transactions SET memo = 'tick ' || i WHERE id = '${id}';
          INSERT INTO stamps_seen SELECT i, updated_at, date_trunc('milliseconds', clock_timestamp()) FROM transactions WHERE id = '${id}';
          COMMIT;
        END LOOP;
      END $$`);
      return (await c.query<{ n: number; ms: string; at: string }>(
        `SELECT n, (extract(epoch FROM s) * 1000)::numeric(20,3)::text AS ms, (extract(epoch FROM at) * 1000)::numeric(20,3)::text AS at
         FROM stamps_seen ORDER BY n`)).rows;
    });
    expect(rows).toHaveLength(ticks);
    let pushed = 0;
    for (let i = 1; i < rows.length; i++) {
      const prev = Number(rows[i - 1]!.ms);
      const cur = Number(rows[i]!.ms);
      expect(cur - prev, `commit ${i + 1}`).toBeGreaterThanOrEqual(1);
      // The clock had not reached the next millisecond: the stamp was pushed to old + 1 ms.
      if (cur > Number(rows[i]!.at)) pushed++;
    }
    expect(pushed, 'some commits fell in an earlier stamp\'s millisecond').toBeGreaterThan(0);
    // And the stamp the API returns is the stored one, to the millisecond.
    const got = await e.call(who[1]!, `/api/v1/transactions/${id}`, { jwt: jwt[1] });
    expect(got.status).toBe(200);
    expect(new Date(got.json.updatedAt ?? got.json.transaction?.updatedAt).getTime()).toBe(Number(rows[ticks - 1]!.ms));
  });

  it('a stamp ahead of the clock still moves forward; a stored stamp with microseconds compares to the millisecond', async () => {
    const [ahead] = await onConn(true, async (c) => (await c.query<{ ok: boolean }>(
      `SELECT mybooks_stamp_next(t) = t + interval '1 millisecond' AS ok
       FROM (SELECT date_trunc('milliseconds', clock_timestamp()) + interval '1 hour' AS t) x`)).rows);
    expect(ahead!.ok).toBe(true);
    const t = (await e.call(who[0]!, '/api/v1/transactions', { method: 'POST', jwt: jwt[0], body: body('journal_entry', 'micro', '1.00') })).json.transaction as { id: string };
    // An archive import keeps the archive's stamps (gate off): microseconds.
    await onConn(false, (c) => c.query("UPDATE transactions SET updated_at = '2026-03-02T10:00:00.123456Z' WHERE id = $1", [t.id]));
    const ok = await e.call(who[0]!, `/api/v1/transactions/${t.id}`, {
      method: 'PUT', jwt: jwt[0], body: body('journal_entry', 'micro by 0', '2.00', '2026-03-02T10:00:00.123Z'),
    });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect(Date.parse(ok.json.transaction.updatedAt)).toBeGreaterThan(Date.parse('2026-03-02T10:00:00.123Z'));
    const again = await e.call(who[1]!, `/api/v1/transactions/${t.id}`, {
      method: 'PUT', jwt: jwt[1], body: body('journal_entry', 'micro by 1', '3.00', '2026-03-02T10:00:00.123Z'),
    });
    expect(again.status).toBe(409);
    expect(again.json.error.code).toBe('STALE');
  });
});

describe('five workstations, one read stamp (U-291 race fix)', () => {
  it('journal entries: at most one save per read stamp (5 clients, 200 rounds)', async () => {
    await race('journal_entry');
  }, 600_000);

  it('expenses: at most one save per read stamp (5 clients, 200 rounds)', async () => {
    await race('expense');
  }, 600_000);
});
