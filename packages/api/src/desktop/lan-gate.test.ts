// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

// LAN profile (U-289, lan-profile-v1): loads the REAL app.ts in desktop LAN
// mode and checks the two-token gate, default deny, device-keyed limiters
// and audit rows (T1, B1, M7).

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { Express } from 'express';

const HOST_TOKEN = 'langate_host_' + 'h'.repeat(40);
const LAN_TOKEN = 'langate_lan_' + 'w'.repeat(40);
const DEVICE_A = 'a'.repeat(64);
const DEVICE_B = 'b'.repeat(64);

let server: http.Server;
let base = '';

async function loadLanApp(): Promise<Express> {
  vi.resetModules();
  const profile = await import('./profile.js');
  profile.loadDesktopProfile({
    CL_MODE: 'desktop',
    CL_TOKEN: HOST_TOKEN,
    CL_LAN: '1',
    CL_LAN_TOKEN: LAN_TOKEN,
    CL_BIND: '127.0.0.1:0',
    CL_DATA_DIR: path.join(os.tmpdir(), 'cl-lan-gate-test'),
  });
  const { app } = await import('../app.js');
  return app;
}

beforeAll(async () => {
  const app = await loadLanApp();
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const { setDesktopBoundAddress } = await import('../middleware/desktop-gate.js');
  setDesktopBoundAddress('127.0.0.1', port);
  base = `http://127.0.0.1:${port}`;
}, 120_000);

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  (await import('./profile.js'))._resetDesktopProfileForTests();
});

type Who = 'host' | 'ws' | 'none';

function headersFor(who: Who, extra: Record<string, string> = {}, device = DEVICE_A, peer = '192.168.1.20'): Record<string, string> {
  const h: Record<string, string> = { 'content-type': 'application/json', ...extra };
  if (who === 'host') h['x-cl-token'] = HOST_TOKEN;
  if (who === 'ws') {
    h['x-cl-token'] = LAN_TOKEN;
    h['x-forwarded-for'] = peer;
    h['x-cl-device'] = device;
  }
  return h;
}

async function call(who: Who, method: string, p: string, opts: { body?: unknown; headers?: Record<string, string>; device?: string } = {}) {
  const r = await fetch(`${base}${p}`, {
    method,
    headers: { ...headersFor(who, {}, opts.device), ...(opts.headers ?? {}) },
    body: opts.body === undefined || method === 'GET' ? undefined : JSON.stringify(opts.body),
  });
  const text = await r.text();
  let json: { error?: { code?: string } } & Record<string, unknown> = {};
  try {
    json = JSON.parse(text);
  } catch { /* not JSON */ }
  return { status: r.status, json };
}

describe('LAN gate (U-289)', () => {
  it('the host token is the host; /desktop/info reports lan', async () => {
    const r = await call('host', 'GET', '/api/v1/desktop/info');
    expect(r.status).toBe(200);
    expect(r.json['lan']).toBe(true);
    expect(r.json['capabilities']).toContain('lan-profile-v1');
  });

  it('the workstation token reaches workstation routes only', async () => {
    expect((await call('ws', 'GET', '/api/v1/desktop/info')).status).toBe(200);
    // A book route: through the gate, refused by authenticate (no session).
    expect((await call('ws', 'GET', '/api/v1/accounts')).status).toBe(401);
    for (const [m, p] of [
      ['POST', '/api/v1/desktop/initialize'],
      ['POST', '/api/v1/desktop/recover-password'],
      ['PUT', '/api/v1/desktop/session-secrets'],
      ['DELETE', '/api/v1/desktop/session-secrets/smtp'],
      ['POST', '/api/v1/tenant-archives/import'],
      ['GET', '/api/v1/tenant-archives/jobs/00000000-0000-4000-8000-000000000000'],
      ['POST', '/api/v1/payroll-import/sessions/00000000-0000-4000-8000-000000000000/post'],
      ['POST', '/api/v1/imports/batches/00000000-0000-4000-8000-000000000000/undo'],
      ['POST', '/api/v1/tenants'],
      ['GET', '/api/v1/no-such-route'],
      // Case and slash variants route the same in Express and classify the same.
      ['POST', '/API/V1/DESKTOP/initialize'],
      ['POST', '/api/v1/desktop//initialize/'],
    ] as const) {
      const r = await call('ws', m, p, { body: {} });
      expect(r.status, `${m} ${p}`).toBe(403);
      expect(r.json.error?.code, `${m} ${p}`).toBe('HOST_ONLY');
    }
  });

  it('a workstation request without its two proxy headers is refused', async () => {
    const bad: Array<Record<string, string>> = [
      { 'x-forwarded-for': '' },
      { 'x-forwarded-for': '10.0.0.1, 10.0.0.2' },
      { 'x-forwarded-for': 'not-an-ip' },
      { 'x-cl-device': 'xyz' },
      { 'x-cl-device': 'a'.repeat(63) },
    ];
    for (const h of bad) {
      const r = await call('ws', 'GET', '/api/v1/desktop/info', { headers: h });
      expect(r.status, JSON.stringify(h)).toBe(400);
      expect(r.json.error?.code).toBe('LAN_HEADERS_INVALID');
    }
  });

  it('no token or a wrong one is 401; a host request ignores spoofed LAN headers', async () => {
    expect((await call('none', 'GET', '/api/v1/desktop/info')).status).toBe(401);
    expect((await call('none', 'GET', '/api/v1/desktop/info', { headers: { 'x-cl-token': LAN_TOKEN + 'x' } })).status).toBe(401);
    // The host token with a device header is still the host (class from the token, B1).
    const r = await call('host', 'POST', '/api/v1/desktop/recover-password', {
      headers: { 'x-cl-device': DEVICE_A, 'x-forwarded-for': '10.1.1.1' },
      body: {},
    });
    expect(r.status).not.toBe(403);
  });

  it('auth limiters count per device, not per address', async () => {
    // Login: authLimiter (10 per minute) and the account limiter (no email: the device). Empty bodies, until 429.
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      statuses.push((await call('ws', 'POST', '/api/v1/auth/login', { body: {}, device: DEVICE_A })).status);
    }
    expect(statuses.at(-1)).toBe(429);
    // Another device on the same address is not limited.
    expect((await call('ws', 'POST', '/api/v1/auth/login', { body: {}, device: DEVICE_B })).status).not.toBe(429);
  });
});

describe('LAN audit rows (M7)', () => {
  it('a workstation write records the address and the device; others record neither', async () => {
    const { auditLog } = await import('../middleware/audit.js');
    const { runWithLanContext } = await import('./lan-context.js');
    const { db } = await import('../db/index.js');
    const { sql } = await import('drizzle-orm');
    const tenantId = crypto.randomUUID();
    await runWithLanContext({ device: DEVICE_A, peerIp: '192.168.1.20' }, () =>
      auditLog(tenantId, 'update', 'lan_test', null, null, { x: 1 }));
    await auditLog(tenantId, 'update', 'lan_test_host', null, null, { x: 2 });
    const rows = await db.execute(sql`SELECT entity_type, ip_address, user_agent FROM audit_log WHERE tenant_id = ${tenantId} ORDER BY id`);
    expect(rows.rows).toEqual([
      { entity_type: 'lan_test', ip_address: '192.168.1.20', user_agent: `lan-device:${DEVICE_A}` },
      { entity_type: 'lan_test_host', ip_address: null, user_agent: null },
    ]);
    await db.execute(sql`DELETE FROM audit_log WHERE tenant_id = ${tenantId}`);
  });
});
