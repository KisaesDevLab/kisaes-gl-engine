// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

// Bulk and merge stamps are compared under the write's row locks (P33 review
// S4), and the permission check runs before any stamp compare (M6).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { startLanEngine, DEVICE_A, type LanEngine } from '../desktop/lan.test-support.js';

let e: LanEngine;
let jwt = '';
const A = { device: DEVICE_A };

beforeAll(async () => {
  e = await startLanEngine();
  jwt = await e.signIn(A);
}, 300_000);

afterAll(async () => {
  await e?.close();
});

/** Another writer: a desktop connection (stamp triggers on) holding an open transaction. */
async function openWriter(): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: e.dbUrl });
  await c.connect();
  await c.query("SET mybooks.desktop = 'on'");
  await c.query('BEGIN');
  return c;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function accountsOf(type: string): Promise<Array<{ id: string; name: string; updatedAt: string }>> {
  const r = await e.call(A, '/api/v1/accounts', { jwt });
  const list = (r.json.data ?? r.json.accounts ?? r.json) as Array<{ id: string; name: string; accountType: string; updatedAt: string }>;
  return list.filter((a) => a.accountType === type);
}

describe('bulk stamps under the lock (P33 review S4)', () => {
  it('PUT /accounts/bulk: an edit that commits while the bulk waits is skipped, not overwritten', async () => {
    const [acct] = await accountsOf('expense');
    const w = await openWriter();
    try {
      await w.query("UPDATE accounts SET name = 'Edited meanwhile' WHERE id = $1", [acct!.id]);
      const bulk = e.call(A, '/api/v1/accounts/bulk', {
        method: 'PUT', jwt, body: { updates: [{ id: acct!.id, name: 'Bulk rename' }], stamps: { [acct!.id]: acct!.updatedAt } },
      });
      await sleep(400);
      await w.query('COMMIT');
      const r = await bulk;
      expect(r.status, JSON.stringify(r.json)).toBe(200);
      expect(r.json.updated).toBe(0);
      expect(r.json.stale?.map((s: { id: string }) => s.id)).toEqual([acct!.id]);
    } finally {
      await w.end();
    }
    const name = await e.query<{ name: string }>('SELECT name FROM accounts WHERE id = $1', [acct!.id]);
    expect(name[0]!.name).toBe('Edited meanwhile');
  });

  it('POST /contacts/merge: an edit of the duplicate that commits while the merge waits refuses the merge', async () => {
    const mk = async (displayName: string) => {
      const r = await e.call(A, '/api/v1/contacts', { method: 'POST', jwt, body: { displayName, contactType: 'vendor' } });
      expect(r.status, JSON.stringify(r.json)).toBe(201);
      return r.json.contact as { id: string; updatedAt: string };
    };
    const src = await mk('Merge source');
    const dst = await mk('Merge target');
    const w = await openWriter();
    let r: Awaited<ReturnType<LanEngine['call']>>;
    try {
      await w.query("UPDATE contacts SET email = 'new@example.test' WHERE id = $1", [src.id]);
      const merge = e.call(A, '/api/v1/contacts/merge', {
        method: 'POST', jwt, body: { sourceId: src.id, targetId: dst.id, stamps: { [src.id]: src.updatedAt, [dst.id]: dst.updatedAt } },
      });
      await sleep(400);
      await w.query('COMMIT');
      r = await merge;
    } finally {
      await w.end();
    }
    expect(r.status, JSON.stringify(r.json)).toBe(409);
    expect(r.json.error.code).toBe('STALE');
    expect(r.json.error.details.stale.map((s: { id: string }) => s.id)).toEqual([src.id]);
    const live = await e.query<{ is_active: boolean }>('SELECT is_active FROM contacts WHERE id = $1', [src.id]);
    expect(live[0]!.is_active).toBe(true);
  });

  it('POST /duplicates/merge: a stale kept entry refuses the merge and the other entry stays posted', async () => {
    const [a, b] = await accountsOf('expense');
    const je = async () => {
      const r = await e.call(A, '/api/v1/transactions', { method: 'POST', jwt, body: {
        txnType: 'journal_entry', txnDate: '2026-03-02', memo: 'dup',
        lines: [{ accountId: a!.id, debit: '5.00', credit: '0' }, { accountId: b!.id, debit: '0', credit: '5.00' }],
      } });
      expect(r.status, JSON.stringify(r.json)).toBe(201);
      return r.json.transaction as { id: string; updatedAt: string };
    };
    const keep = await je();
    const extra = await je();
    const r = await e.call(A, '/api/v1/duplicates/merge', {
      method: 'POST', jwt, body: { keepId: keep.id, voidId: extra.id, stamps: { [keep.id]: '2020-01-01T00:00:00.000Z', [extra.id]: extra.updatedAt } },
    });
    expect(r.status, JSON.stringify(r.json)).toBe(409);
    expect(r.json.error.details.stale.map((s: { id: string }) => s.id)).toEqual([keep.id]);
    const st = await e.query<{ status: string }>('SELECT status FROM transactions WHERE id = $1', [extra.id]);
    expect(st[0]!.status).toBe('posted');
    // A stale voided entry refuses too.
    const r2 = await e.call(A, '/api/v1/duplicates/merge', {
      method: 'POST', jwt, body: { keepId: keep.id, voidId: extra.id, stamps: { [keep.id]: keep.updatedAt, [extra.id]: '2020-01-01T00:00:00.000Z' } },
    });
    expect(r2.status, JSON.stringify(r2.json)).toBe(409);
    expect(r2.json.error.details.stale.map((s: { id: string }) => s.id)).toEqual([extra.id]);
    // Current stamps merge.
    const ok = await e.call(A, '/api/v1/duplicates/merge', {
      method: 'POST', jwt, body: { keepId: keep.id, voidId: extra.id, stamps: { [keep.id]: keep.updatedAt, [extra.id]: extra.updatedAt } },
    });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
  });
});

describe('stamp settings do not build up on a pooled connection (P33 review M7)', () => {
  it('a desktop pool connection is replaced after DESKTOP_POOL_MAX_USES uses', async () => {
    const { pool, DESKTOP_POOL_MAX_USES } = await import('../db/index.js');
    const pids = new Set<number>();
    for (let i = 0; i <= DESKTOP_POOL_MAX_USES; i++) {
      const c = await pool.connect();
      try {
        // The stamp triggers' kind of setting: one name per record touched.
        const r = await c.query(`SELECT pg_backend_pid() AS pid, set_config('mybooks.s_m7_' || $1::text, 'done', false)`, [String(i)]);
        pids.add(Number(r.rows[0].pid));
      } finally {
        c.release();
      }
    }
    expect(pids.size).toBeGreaterThan(1);
  });
});

describe('permission before the stamp (P33 review M6)', () => {
  it('a user who may not change company settings gets 403, not 409 STALE with the stored stamp', async () => {
    const host = await e.signIn('host');
    const cred = { email: 'clerk@example.test', password: 'a long clerk password' };
    const mk = await e.call('host', '/api/v1/admin/users/create', {
      method: 'POST', jwt: host, body: { ...cred, displayName: 'Clerk', tenantId: e.company, role: 'readonly' },
    });
    expect(mk.status, JSON.stringify(mk.json)).toBeLessThan(300);
    const t = await e.login(A, cred);
    const sw = await e.call(A, '/api/v1/auth/switch-tenant', { method: 'POST', jwt: t.accessToken, body: { tenantId: e.company } });
    expect(sw.status, JSON.stringify(sw.json)).toBe(200);
    const clerk = sw.json.tokens.accessToken as string;
    for (const [m, p] of [['PUT', '/api/v1/company'], ['PUT', '/api/v1/company/settings']] as const) {
      const r = await e.call(A, p, { method: m, jwt: clerk, body: { expectedUpdatedAt: '2020-01-01T00:00:00.000Z' } });
      expect(r.status, `${m} ${p} ${JSON.stringify(r.json)}`).toBe(403);
      expect(JSON.stringify(r.json)).not.toContain('updatedAt');
    }
  });
});
