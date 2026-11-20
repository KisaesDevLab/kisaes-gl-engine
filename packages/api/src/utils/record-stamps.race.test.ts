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
  let createRetry = 0;
  for (let round = 0; round < ROUNDS; round++) {
    // One shared record, read once; all five clients save it from that read
    // (different content each), and each also posts a new entry on the same
    // two accounts, all at once.
    const k = round % SHARED;
    const read = await stampOf(shared[k]!);
    const results = await Promise.all(Array.from({ length: CLIENTS }, async (_, c) => {
      const [save, made] = await Promise.all([
        e.call(who[c]!, `/api/v1/transactions/${shared[k]}`, {
          method: 'PUT', jwt: jwt[c], body: body(kind, `shared ${k} round ${round} by ${c}`, '1.00', read.stamp),
        }),
        e.call(who[c]!, '/api/v1/transactions', {
          method: 'POST', jwt: jwt[c], body: body(kind, `new ${round} by ${c}`, `${1 + ((round * 7 + c) % 9)}.00`),
        }),
      ]);
      return { c, save: save!, made: made! };
    }));
    for (const x of results) {
      // A 409 RETRY saved nothing (the client sends again): allowed, counted.
      if (x.made.status === 409 && x.made.json?.error?.code === 'RETRY') createRetry++;
      else if (x.made.status !== 201) failures.push(`create ${x.made.status} ${JSON.stringify(x.made.json)}`);
      if (x.save.status === 409 && x.save.json?.error?.code === 'STALE') stale++;
      else if (x.save.status === 409 && x.save.json?.error?.code === 'RETRY') retry++;
      else if (x.save.status !== 200) failures.push(`save ${x.save.status} ${JSON.stringify(x.save.json)}`);
    }
    const won = results.filter((x) => x.save.status === 200);
    accepted += won.length;
    if (won.length > 1) lost.push(`round ${round} record ${k}: ${won.length} saves accepted from read ${read.stamp}`);
    if (won.length === 1) {
      const now = await stampOf(shared[k]!);
      if (now.memo !== `shared ${k} round ${round} by ${won[0]!.c}`) lost.push(`round ${round} record ${k}: stored ${now.memo}`);
    }
  }
  console.log(`[race ${kind}] ${CLIENTS} clients x ${ROUNDS} rounds on one read each: ${accepted} accepted, ${stale} stale, `
    + `${retry} save retry, ${createRetry} create retry, ${lost.length} lost, ${failures.length} failures`);
  expect(lost, lost.slice(0, 5).join('\n')).toEqual([]);
  expect(failures, failures.slice(0, 5).join('\n')).toEqual([]);
  expect(accepted).toBeGreaterThan(ROUNDS / 2);
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
  /** `ticks` edits of `id`, one commit each, back to back; the stamp after each, in epoch milliseconds. */
  async function backToBack(id: string, ticks: number): Promise<number[]> {
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    return onConn(true, async (c) => {
      await c.query('CREATE TEMP TABLE stamps_seen (n int, s timestamptz)');
      await c.query(`DO $$ BEGIN
        FOR i IN 1..${ticks} LOOP
          UPDATE transactions SET memo = 'tick ' || i WHERE id = '${id}';
          INSERT INTO stamps_seen SELECT i, updated_at FROM transactions WHERE id = '${id}';
          COMMIT;
        END LOOP;
      END $$`);
      return (await c.query<{ ms: string }>(
        'SELECT (extract(epoch FROM s) * 1000)::numeric(20,3)::text AS ms FROM stamps_seen ORDER BY n')).rows.map((r) => Number(r.ms));
    });
  }

  async function newEntry(memo: string): Promise<string> {
    const r = await e.call(who[0]!, '/api/v1/transactions', { method: 'POST', jwt: jwt[0], body: body('journal_entry', memo, '1.00') });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    return r.json.transaction.id as string;
  }

  it('back-to-back commits each move the stamp forward by at least 1 ms', async () => {
    const id = await newEntry('ticks');
    const ms = await backToBack(id, 200);
    expect(ms).toHaveLength(200);
    for (let i = 1; i < ms.length; i++) expect(ms[i]! - ms[i - 1]!, `commit ${i + 1}`).toBeGreaterThanOrEqual(1);
    // The stamp the API returns is the stored one, to the millisecond.
    const got = await e.call(who[1]!, `/api/v1/transactions/${id}`, { jwt: jwt[1] });
    expect(got.status).toBe(200);
    expect(Date.parse(got.json.updatedAt ?? got.json.transaction?.updatedAt)).toBe(ms[ms.length - 1]);
  });

  it('commits within the stamp\'s millisecond (the clock behind it) move it exactly 1 ms each', async () => {
    const id = await newEntry('ahead');
    // A stamp an hour ahead of the clock (written with the gate off): every
    // commit below lands "in the same millisecond or earlier" than the stamp.
    await onConn(false, (c) => c.query(
      "UPDATE transactions SET updated_at = date_trunc('milliseconds', clock_timestamp()) + interval '1 hour' WHERE id = $1", [id]));
    const [start] = await e.query<{ ms: string }>('SELECT (extract(epoch FROM updated_at) * 1000)::numeric(20,3)::text AS ms FROM transactions WHERE id = $1', [id]);
    const ms = await backToBack(id, 50);
    expect(ms.map((m, i) => m - (i === 0 ? Number(start!.ms) : ms[i - 1]!))).toEqual(Array(50).fill(1));
  });

  it('a stored stamp with microseconds compares to the millisecond and moves forward', async () => {
    const t = { id: await newEntry('micro') };
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

// Routes whose middleware compared the stamp before the handler (U-291b
// precheck) now compare it again in the write: under the service's row lock,
// in the UPDATE itself, or in a new transaction that locks the record first.
describe('precheck routes: five saves from one read, one wins', () => {
  async function stampIn(table: string, id: string): Promise<string> {
    const [row] = await e.query<{ s: string }>(
      `SELECT to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS s FROM ${table} WHERE id = $1`, [id]);
    return row!.s;
  }

  async function raceRoute(table: string, id: string, runs: number,
    save: (c: number, stamp: string, run: number) => ReturnType<LanEngine['call']>) {
    const lost: string[] = [];
    const bad: string[] = [];
    let accepted = 0;
    for (let run = 0; run < runs; run++) {
      const stamp = await stampIn(table, id);
      const rs = await Promise.all(Array.from({ length: CLIENTS }, (_, c) => save(c, stamp, run)));
      const won = rs.filter((r) => r.status === 200).length;
      accepted += won;
      if (won > 1) lost.push(`run ${run}: ${won} saves accepted from ${stamp}`);
      for (const r of rs) {
        if (r.status !== 200 && !(r.status === 409 && ['STALE', 'RETRY'].includes(r.json?.error?.code))) bad.push(`${r.status} ${JSON.stringify(r.json)}`);
      }
    }
    console.log(`[precheck ${table}] ${CLIENTS} clients x ${runs} runs: ${accepted} accepted, ${lost.length} lost, ${bad.length} other`);
    expect(lost, lost.slice(0, 5).join('\n')).toEqual([]);
    expect(bad, bad.slice(0, 5).join('\n')).toEqual([]);
    expect(accepted).toBeGreaterThan(runs / 2);
  }

  it('price level (compared under the service\'s row lock)', async () => {
    const pl = await e.call(who[0]!, '/api/v1/price-levels', { method: 'POST', jwt: jwt[0], body: { name: 'Race Level', percent: '-5' } });
    expect(pl.status, JSON.stringify(pl.json)).toBe(201);
    const id = (pl.json.priceLevel ?? pl.json).id as string;
    await raceRoute('price_levels', id, 30, (c, stamp, run) => e.call(who[c]!, `/api/v1/price-levels/${id}`, {
      method: 'PUT', jwt: jwt[c], body: { name: `Race Level ${run} by ${c}`, expectedUpdatedAt: stamp },
    }));
  }, 120_000);

  it('JE template header (compare-and-set in the UPDATE) and lines (a transaction that locks the template first)', async () => {
    const t = await e.call(who[0]!, '/api/v1/je-templates', { method: 'POST', jwt: jwt[0], body: { name: 'Race Template' } });
    expect(t.status, JSON.stringify(t.json)).toBe(201);
    const id = t.json.template.id as string;
    await raceRoute('je_templates', id, 30, (c, stamp, run) => e.call(who[c]!, `/api/v1/je-templates/${id}`, {
      method: 'PUT', jwt: jwt[c], body: { memo: `memo ${run} by ${c}`, expectedUpdatedAt: stamp },
    }));
    await raceRoute('je_templates', id, 30, (c, stamp, run) => e.call(who[c]!, `/api/v1/je-templates/${id}/lines`, {
      method: 'PUT', jwt: jwt[c], body: { lines: [{ label: `line ${run} by ${c}`, normalSide: 'debit' }], expectedUpdatedAt: stamp },
    }));
    // One save's lines, never two.
    const [n] = await e.query<{ n: number }>('SELECT count(*)::int AS n FROM je_template_lines WHERE template_id = $1', [id]);
    expect(n!.n).toBe(1);
  }, 120_000);

  it('company settings (compared under the company row lock)', async () => {
    const [co] = await e.query<{ id: string }>('SELECT id FROM companies LIMIT 1');
    await raceRoute('companies', co!.id, 30, (c, stamp, run) => e.call(who[c]!, '/api/v1/company', {
      method: 'PUT', jwt: jwt[c], body: { phone: `555-0${c}${String(run).padStart(2, '0')}`, expectedUpdatedAt: stamp },
    }));
  }, 120_000);
});

describe('five workstations, one read stamp (U-291 race fix)', () => {
  it('journal entries: at most one save per read stamp (5 clients, 200 rounds)', async () => {
    await race('journal_entry');
  }, 600_000);

  it('expenses: at most one save per read stamp (5 clients, 200 rounds)', async () => {
    await race('expense');
  }, 600_000);
});
