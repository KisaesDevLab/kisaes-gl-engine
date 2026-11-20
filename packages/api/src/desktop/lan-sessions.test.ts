// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

// LAN sessions (U-290, lan-sessions-v1): sid + device binding, revocation
// within one request (T11, S3), the session cap from env, the sessions
// routes and LAN audit events (M7).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import jwt from 'jsonwebtoken';
import { startLanEngine, DEVICE_A, DEVICE_B, type LanEngine } from './lan.test-support.js';

let e: LanEngine;

beforeAll(async () => {
  e = await startLanEngine({ env: { MAX_SESSIONS_PER_USER: '6' } });
}, 300_000);

afterAll(async () => {
  await e?.close();
});

const A = { device: DEVICE_A };
const B = { device: DEVICE_B };

describe('LAN sessions (U-290)', () => {
  it('access tokens carry the session chain; the session is bound to its device', async () => {
    const t = await e.login(A);
    const claims = jwt.decode(t.accessToken) as { sid?: string };
    expect(claims.sid).toMatch(/^[0-9a-f-]{36}$/);
    const rows = await e.query<{ device_id: string | null }>('SELECT device_id FROM sessions WHERE chain_id = $1', [claims.sid]);
    expect(rows).toEqual([{ device_id: DEVICE_A }]);

    expect((await e.call(A, '/api/v1/auth/me', { jwt: t.accessToken })).status).toBe(200);
    // The same token from another device, or from the host app, is refused.
    const fromB = await e.call(B, '/api/v1/auth/me', { jwt: t.accessToken });
    expect(fromB.status).toBe(401);
    expect(fromB.json.error.code).toBe('SESSION_DEVICE_MISMATCH');
    expect((await e.call('host', '/api/v1/auth/me', { jwt: t.accessToken })).status).toBe(401);
  });

  it('refresh keeps the chain and refuses another device', async () => {
    const t = await e.login(A);
    const sid = (jwt.decode(t.accessToken) as { sid: string }).sid;
    const r = await e.call(A, '/api/v1/auth/refresh', { method: 'POST', body: { refreshToken: t.refreshToken } });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect((jwt.decode(r.json.tokens.accessToken) as { sid: string }).sid).toBe(sid);
    // The old access token still works across the rotation (same chain).
    expect((await e.call(A, '/api/v1/auth/me', { jwt: t.accessToken })).status).toBe(200);

    const next = decodeURIComponent(r.cookies.map((c) => /^kb_refresh=([^;]+)/.exec(c)?.[1]).find((v) => v) ?? '');
    expect(next.length).toBeGreaterThan(20);
    const stolen = await e.call(B, '/api/v1/auth/refresh', { method: 'POST', body: { refreshToken: next } });
    expect(stolen.status).toBe(401);
    expect(stolen.json.error.code).toBe('SESSION_DEVICE_MISMATCH');
  });

  it('the chain always has a live row while it refreshes (no 401 in the rotation gap)', async () => {
    const t = await e.login(A);
    let refresh = t.refreshToken;
    let stop = false;
    const seen: number[] = [];
    const reader = (async () => {
      while (!stop) seen.push((await e.call(A, '/api/v1/auth/me', { jwt: t.accessToken })).status);
    })();
    for (let i = 0; i < 50; i++) {
      const r = await e.call(A, '/api/v1/auth/refresh', { method: 'POST', body: { refreshToken: refresh } });
      expect(r.status, JSON.stringify(r.json)).toBe(200);
      refresh = decodeURIComponent(r.cookies.map((c) => /^kb_refresh=([^;]+)/.exec(c)?.[1]).find((v) => v) ?? '');
    }
    stop = true;
    await reader;
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.filter((s) => s !== 200)).toEqual([]);
  });

  it('a token without a live session (revoked, or no sid) is refused at the next request', async () => {
    const host = await e.login('host');
    const t = await e.login(A);
    const sid = (jwt.decode(t.accessToken) as { sid: string }).sid;
    const list = await e.call('host', '/api/v1/desktop/sessions', { jwt: host.accessToken });
    expect(list.status, JSON.stringify(list.json)).toBe(200);
    const mine = list.json.sessions.find((s: { id: string }) => s.id === sid);
    expect(mine).toMatchObject({ deviceId: DEVICE_A, current: false, email: 'owner@example.test' });
    expect(list.json.sessions.find((s: { current: boolean }) => s.current)).toMatchObject({ deviceId: null });

    const del = await e.call('host', `/api/v1/desktop/sessions/${sid}`, { method: 'DELETE', jwt: host.accessToken });
    expect(del.status).toBe(200);
    const after = await e.call(A, '/api/v1/auth/me', { jwt: t.accessToken });
    expect(after.status).toBe(401);
    expect(after.json.error.code).toBe('SESSION_REVOKED');
    expect((await e.call('host', `/api/v1/desktop/sessions/${sid}`, { method: 'DELETE', jwt: host.accessToken })).status).toBe(404);

    // A session JWT minted without sid (an old token) is refused in LAN mode.
    const claims = jwt.decode(host.accessToken) as Record<string, unknown>;
    const { sid: _s, iat: _i, exp: _x, ...rest } = claims;
    const legacy = jwt.sign(rest, 'test-secret-key-for-testing-only', { expiresIn: 600 });
    const r = await e.call('host', '/api/v1/auth/me', { jwt: legacy });
    expect(r.status).toBe(401);
  });

  it('removing a device ends all its sessions', async () => {
    const host = await e.login('host');
    const t1 = await e.login(B);
    const t2 = await e.login(B);
    const r = await e.call('host', `/api/v1/desktop/sessions?device=${DEVICE_B}`, { method: 'DELETE', jwt: host.accessToken });
    expect(r.status).toBe(200);
    expect(r.json.revoked).toBeGreaterThanOrEqual(2);
    expect((await e.call(B, '/api/v1/auth/me', { jwt: t1.accessToken })).status).toBe(401);
    expect((await e.call(B, '/api/v1/auth/me', { jwt: t2.accessToken })).status).toBe(401);
  });

  it('sessions routes and audit events are host-only', async () => {
    const t = await e.login(A);
    for (const [m, p] of [['GET', '/api/v1/desktop/sessions'], ['DELETE', `/api/v1/desktop/sessions?device=${DEVICE_A}`],
      ['POST', '/api/v1/desktop/audit-events']] as const) {
      const r = await e.call(A, p, { method: m, jwt: t.accessToken, body: m === 'POST' ? { event: 'lan_host_mode_on' } : undefined });
      expect(r.status, `${m} ${p}`).toBe(403);
      expect(r.json.error.code).toBe('HOST_ONLY');
    }
  });

  it('the host app records LAN events in the audit trail', async () => {
    const r = await e.call('host', '/api/v1/desktop/audit-events', {
      method: 'POST', body: { event: 'lan_device_paired', deviceId: DEVICE_A.toUpperCase(), label: 'Front desk' },
    });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    const rows = await e.query<{ after_data: unknown }>(
      "SELECT after_data FROM audit_log WHERE entity_type = 'lan_event' ORDER BY id DESC LIMIT 1");
    const after = typeof rows[0]!.after_data === 'string' ? JSON.parse(rows[0]!.after_data as string) : rows[0]!.after_data;
    expect(after).toEqual({ event: 'lan_device_paired', deviceId: DEVICE_A, label: 'Front desk' });
    expect((await e.call('host', '/api/v1/desktop/audit-events', { method: 'POST', body: { event: 'nope' } })).status).toBe(400);
  });

  it('the session cap comes from MAX_SESSIONS_PER_USER', async () => {
    await e.query('DELETE FROM sessions');
    // In process (the login limiter allows 10 tries per account in 15 minutes).
    const auth = await import('../services/auth.service.js');
    const [u] = await e.query<{ id: string; tenant_id: string }>('SELECT id, tenant_id FROM users LIMIT 1');
    for (let i = 0; i < 8; i++) await auth.issueSession({ userId: u!.id, tenantId: u!.tenant_id, role: 'owner' });
    const rows = await e.query<{ n: string }>('SELECT COUNT(DISTINCT chain_id) AS n FROM sessions');
    expect(Number(rows[0]!.n)).toBe(6);
  });

  it('API keys are refused from workstations', async () => {
    const r = await e.call(A, '/api/v1/auth/me', { headers: { 'x-api-key': 'kb_whatever' } });
    expect(r.status).toBe(401);
    expect(r.json.error.code).toBe('API_KEY_NOT_ON_LAN');
  });
});
