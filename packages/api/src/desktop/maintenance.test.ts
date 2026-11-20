// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

// Maintenance mode (U-293, maintenance-v1; T10, S4).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startLanEngine, DEVICE_A, type LanEngine } from './lan.test-support.js';

let e: LanEngine;
const A = { device: DEVICE_A };

beforeAll(async () => {
  e = await startLanEngine();
}, 300_000);

afterAll(async () => {
  await e?.close();
});

describe('maintenance (U-293)', () => {
  it('holds the books for one session; others get 503; end and reset', async () => {
    const host = await e.signIn('host');
    const ws = await e.signIn(A);
    expect((await e.call(A, '/api/v1/accounts', { jwt: ws })).status).toBe(200);

    // Restore and import need a hold in LAN mode.
    const req = await e.call('host', '/api/v1/tenant-archives/import', { method: 'POST', jwt: host, body: { passphrase: 'x'.repeat(16) } });
    expect(req.status).toBe(409);
    expect(req.json.error.code).toBe('MAINTENANCE_REQUIRED');

    const start = await e.call('host', '/api/v1/desktop/maintenance', { method: 'POST', jwt: host });
    expect(start.status, JSON.stringify(start.json)).toBe(200);
    expect(start.json.active, JSON.stringify(start.json)).toBe(true);

    // The workstation session is gone and anything it sends is 503 MAINTENANCE.
    const blocked = await e.call(A, '/api/v1/accounts', { jwt: ws });
    expect(blocked.status).toBe(503);
    expect(blocked.json.error.code).toBe('MAINTENANCE');
    expect((await e.query('SELECT 1 FROM sessions WHERE device_id = $1', [DEVICE_A])).length).toBe(0);
    // Probes and engine info still answer.
    expect((await e.call(A, '/api/v1/desktop/info')).status).toBe(200);

    // The holder works; the guarded import now passes the guard (and fails on its own validation).
    expect((await e.call('host', '/api/v1/accounts', { jwt: host })).status).toBe(200);
    const guarded = await e.call('host', '/api/v1/tenant-archives/import', { method: 'POST', jwt: host, body: { passphrase: 'x'.repeat(16) } });
    expect(guarded.json.error?.code).not.toBe('MAINTENANCE_REQUIRED');

    // Survives a restart: the hold is read from the database again.
    const { _forgetMaintenanceCache } = await import('./maintenance.js');
    _forgetMaintenanceCache();
    expect((await e.call('host', '/api/v1/desktop/maintenance')).json.active).toBe(true);

    const end = await e.call('host', '/api/v1/desktop/maintenance', { method: 'DELETE', jwt: host });
    expect(end.status, JSON.stringify(end.json)).toBe(200);
    expect((await e.call('host', '/api/v1/desktop/maintenance')).json.active).toBe(false);
    const ws2 = await e.signIn(A);
    expect((await e.call(A, '/api/v1/accounts', { jwt: ws2 })).status).toBe(200);

    // Reset (after a file-level restore): the launch token alone clears a stale hold.
    await e.query("INSERT INTO desktop_maintenance (id, holder_session, holder_user) VALUES (1, gen_random_uuid(), gen_random_uuid())");
    _forgetMaintenanceCache();
    expect((await e.call(A, '/api/v1/accounts', { jwt: ws2 })).status).toBe(503);
    const reset = await e.call('host', '/api/v1/desktop/maintenance/reset', { method: 'POST' });
    expect(reset.json).toEqual({ cleared: true });
    // ws2 was not revoked by a hold it never saw start: it works again.
    expect((await e.call(A, '/api/v1/accounts', { jwt: ws2 })).status).toBe(200);
  });

  it('start, end and reset are host-only', async () => {
    const ws = await e.signIn(A);
    for (const [m, p] of [['POST', '/api/v1/desktop/maintenance'], ['DELETE', '/api/v1/desktop/maintenance'],
      ['POST', '/api/v1/desktop/maintenance/reset']] as const) {
      const r = await e.call(A, p, { method: m, jwt: ws });
      expect(r.status, `${m} ${p}`).toBe(403);
      expect(r.json.error.code).toBe('HOST_ONLY');
    }
  });

  it('a write in flight finishes before the hold starts (drain)', async () => {
    const host = await e.signIn('host');
    const ws = await e.signIn(A);
    const accounts = (await e.call(A, '/api/v1/accounts', { jwt: ws })).json;
    const list = (accounts.data ?? accounts.accounts ?? accounts) as Array<{ id: string; accountType: string }>;
    const exp = list.filter((a) => a.accountType === 'expense');
    // Fire a burst of writes and start maintenance in the middle of it.
    const writes = Array.from({ length: 10 }, (_, i) => e.call(A, '/api/v1/transactions', {
      method: 'POST', jwt: ws,
      body: { txnType: 'journal_entry', txnDate: '2026-03-02', memo: `drain ${i}`, lines: [
        { accountId: exp[0]!.id, debit: '1.00', credit: '0' }, { accountId: exp[1]!.id, debit: '0', credit: '1.00' }] },
    }));
    const start = e.call('host', '/api/v1/desktop/maintenance', { method: 'POST', jwt: host });
    const results = await Promise.all(writes);
    const s = await start;
    expect(s.status, JSON.stringify(s.json)).toBe(200);
    // Every write either completed (201) or was refused by the hold (503); none half-done.
    for (const r of results) expect([201, 503]).toContain(r.status);
    const posted = await e.query<{ n: string }>("SELECT COUNT(*) AS n FROM transactions WHERE memo LIKE 'drain %'");
    expect(Number(posted[0]!.n)).toBe(results.filter((r) => r.status === 201).length);
    await e.call('host', '/api/v1/desktop/maintenance', { method: 'DELETE', jwt: host });
  });
});
