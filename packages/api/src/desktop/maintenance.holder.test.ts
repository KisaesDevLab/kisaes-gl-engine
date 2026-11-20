// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

// Maintenance holder (P33 review B1 and S8): a hold whose holder session is
// gone is void; trimming never ends the holder; a new chain takes the hold
// with it; reset works without a hold; the drain waits only for other
// sessions' book writes.
//
// Sign-in is limited to 10 per account per 15 minutes, so new session chains
// come from switch-tenant without a refresh token (each starts a chain).

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import type { Request } from 'express';
import jwt from 'jsonwebtoken';
import { startLanEngine, DEVICE_A, OWNER, type LanEngine } from './lan.test-support.js';

let e: LanEngine;
let base: string;
const A = { device: DEVICE_A };
const CAP = 20;

beforeAll(async () => {
  e = await startLanEngine({ env: { MAX_SESSIONS_PER_USER: String(CAP) } });
  base = await e.signIn('host');
}, 300_000);

afterEach(async () => {
  await e.call('host', '/api/v1/desktop/maintenance/reset', { method: 'POST' });
  const m = await import('./maintenance.js');
  m._setDrainMs(30_000);
});

afterAll(async () => {
  await e?.close();
});

const sidOf = (token: string): string => (jwt.decode(token) as { sid: string }).sid;

/** A new session chain for the host's owner (switch-tenant without a refresh token). */
async function newChain(from: string): Promise<string> {
  const sw = await e.call('host', '/api/v1/auth/switch-tenant', { method: 'POST', jwt: from, body: { tenantId: e.company } });
  expect(sw.status, JSON.stringify(sw.json)).toBe(200);
  return sw.json.tokens.accessToken as string;
}

async function start(holder: string): Promise<void> {
  const s = await e.call('host', '/api/v1/desktop/maintenance', { method: 'POST', jwt: holder });
  expect(s.status, JSON.stringify(s.json)).toBe(200);
}

// Starting a hold ends every other session, so `base` is always the session
// that survived the last test.
describe('maintenance holder (P33 review B1)', () => {
  it('a hold whose holder session no longer exists is void: the next session works and can start its own', async () => {
    await start(base);
    // The host app dies while it holds the books; its session is gone (the
    // sessions table is cleared), then the owner signs in again.
    await e.query('DELETE FROM sessions WHERE chain_id = $1', [sidOf(base)]);
    const { _forgetMaintenanceCache } = await import('./maintenance.js');
    _forgetMaintenanceCache();
    base = await e.signIn('host');

    const r = await e.call('host', '/api/v1/accounts', { jwt: base });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect((await e.call('host', '/api/v1/desktop/maintenance')).json.active).toBe(false);
    expect((await e.query('SELECT 1 FROM desktop_maintenance')).length).toBe(0);
    expect((await e.query("SELECT 1 FROM audit_log WHERE entity_type = 'desktop_maintenance' AND after_data::text LIKE '%maintenance_void%'")).length).toBe(1);
    // The new session can hold and end maintenance.
    await start(base);
    const end = await e.call('host', '/api/v1/desktop/maintenance', { method: 'DELETE', jwt: base });
    expect(end.status, JSON.stringify(end.json)).toBe(200);
  });

  it('a switch-tenant that starts a new chain takes the hold with it', async () => {
    await start(base);
    const next = await newChain(base);
    expect(sidOf(next)).not.toBe(sidOf(base));
    expect((await e.call('host', '/api/v1/desktop/maintenance')).json.holderSession).toBe(sidOf(next));
    expect((await e.call('host', '/api/v1/accounts', { jwt: next })).status).toBe(200);
    const end = await e.call('host', '/api/v1/desktop/maintenance', { method: 'DELETE', jwt: next });
    expect(end.status, JSON.stringify(end.json)).toBe(200);
    base = next;
  });

  it('reset answers with no hold, and again (the host app calls it at every start)', async () => {
    for (let i = 0; i < 2; i++) {
      const r = await e.call('host', '/api/v1/desktop/maintenance/reset', { method: 'POST' });
      expect(r.status).toBe(200);
      expect(r.json).toEqual({ cleared: false });
    }
    expect((await e.call('host', '/api/v1/accounts', { jwt: base })).status).toBe(200);
  });

  it('a holder that signs out leaves no hold behind', async () => {
    const t = await e.login('host');
    await start(t.accessToken);
    const out = await e.call('host', '/api/v1/auth/logout', { method: 'POST', jwt: t.accessToken, body: { refreshToken: t.refreshToken } });
    expect(out.status, JSON.stringify(out.json)).toBeLessThan(300);
    expect((await e.query('SELECT 1 FROM sessions WHERE chain_id = $1', [sidOf(t.accessToken)])).length).toBe(0);
    const ws = await e.signIn(A);
    expect((await e.call(A, '/api/v1/accounts', { jwt: ws })).status).toBe(200);
    base = await e.signIn('host');
  });

  it('session trimming never ends the holder chain', async () => {
    await start(base);
    // The same user then signs in on more computers than the cap allows
    // (newer session rows), and once more: the sign-in trims the oldest.
    await e.query(`INSERT INTO sessions (user_id, refresh_token_hash, expires_at)
      SELECT u.id, md5(random()::text || g::text), now() + interval '1 day'
      FROM users u, generate_series(1, ${CAP + 2}) g WHERE u.email = $1`, [OWNER.email]);
    await e.login(A);
    expect((await e.query('SELECT 1 FROM sessions WHERE chain_id = $1', [sidOf(base)])).length).toBe(1);
    const r = await e.call('host', '/api/v1/accounts', { jwt: base });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect((await e.call('host', '/api/v1/desktop/maintenance', { method: 'DELETE', jwt: base })).status).toBe(200);
  });
});
describe('maintenance drain (P33 review S8)', () => {
  const fake = (path: string, token: string, method = 'POST'): Request =>
    ({ method, path, headers: { authorization: `Bearer ${token}` } }) as unknown as Request;

  it('counts book writes only', async () => {
    const { drainCounts } = await import('./maintenance.js');
    const counted: Array<[string, string]> = [
      ['POST', '/api/v1/transactions'], ['PUT', '/api/v1/invoices/x'], ['DELETE', '/api/v1/contacts/x'],
      ['POST', '/api/v1/recurring/run-due'], ['POST', '/api/v1/tags/transactions/x/add'],
      ['POST', '/api/v1/ai/categorize/accept'], ['POST', '/api/v1/ai/parse/statement/import'],
      ['POST', '/api/v1/tenant-archives/import'], ['POST', '/api/v1/payroll-import/sessions/x/post'],
    ];
    const exempt: Array<[string, string]> = [
      ['GET', '/api/v1/transactions'], ['POST', '/api/v1/auth/login'], ['POST', '/api/v1/auth/refresh'],
      ['POST', '/api/v1/ai/ocr/receipt'], ['POST', '/api/v1/ai/categorize'], ['POST', '/api/v1/chat/conversations/x/messages'],
      ['POST', '/api/v1/document-reading/read'], ['POST', '/api/v1/reports/profit-loss'], ['POST', '/api/v1/report-builder/run'],
      ['POST', '/api/v1/invoices/preview'], ['POST', '/api/v1/daily-sales/entries/preview'], ['PUT', '/api/v1/users/me/preferences'],
    ];
    for (const [m, p] of counted) expect(drainCounts(m, p), `${m} ${p}`).toBe(true);
    for (const [m, p] of exempt) expect(drainCounts(m, p), `${m} ${p}`).toBe(false);
  });

  it("the holder's own write and another session's slow AI call do not block the start", async () => {
    const m = await import('./maintenance.js');
    m._setDrainMs(300);
    const holder = base;
    const ws = await e.signIn(A);
    const own = m._trackInFlight(fake('/api/v1/transactions', holder));
    const ai = m._trackInFlight(fake('/api/v1/ai/ocr/receipt', ws));
    try {
      await start(holder);
    } finally {
      own();
      ai();
    }
  });

  it("another session's book write in flight still makes the start wait, then refuse", async () => {
    const m = await import('./maintenance.js');
    m._setDrainMs(300);
    const holder = base;
    const other = await newChain(base);
    const write = m._trackInFlight(fake('/api/v1/transactions', other));
    try {
      const s = await e.call('host', '/api/v1/desktop/maintenance', { method: 'POST', jwt: holder });
      expect(s.status).toBe(409);
      expect(s.json.error.code).toBe('MAINTENANCE_BUSY');
      expect((await e.call('host', '/api/v1/desktop/maintenance')).json.active).toBe(false);
    } finally {
      write();
    }
  });
});
