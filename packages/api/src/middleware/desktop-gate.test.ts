// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import express from 'express';
import http, { type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {
  desktopGate,
  hostAllowed,
  setDesktopBoundAddress,
  _resetDesktopBoundAddressForTests,
} from './desktop-gate.js';
import { loadDesktopProfile, _resetDesktopProfileForTests } from '../desktop/profile.js';

const TOKEN = 'T0k3n_' + 'x'.repeat(40);

function loadDesktop() {
  loadDesktopProfile({
    CL_MODE: 'desktop',
    CL_TOKEN: TOKEN,
    CL_BIND: '127.0.0.1:0',
    CL_DATA_DIR: path.join(os.tmpdir(), 'cl-gate-test'),
  });
}

/** Raw request so Host/Origin can be set freely (fetch forbids Host). */
function request(
  port: number,
  opts: { method?: string; path?: string; headers?: Record<string, string> },
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method: opts.method ?? 'GET', path: opts.path ?? '/', headers: opts.headers ?? {} },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('hostAllowed', () => {
  afterEach(() => _resetDesktopBoundAddressForTests());

  it('rejects everything before the bound address is known', () => {
    expect(hostAllowed('127.0.0.1:3001')).toBe(false);
  });

  it('accepts the bound literal and localhost with the bound port only', () => {
    setDesktopBoundAddress('127.0.0.1', 3001);
    expect(hostAllowed('127.0.0.1:3001')).toBe(true);
    expect(hostAllowed('LOCALHOST:3001')).toBe(true);
    expect(hostAllowed('127.0.0.1:3002')).toBe(false);
    expect(hostAllowed('127.0.0.1')).toBe(false);
    expect(hostAllowed('evil.example:3001')).toBe(false);
    expect(hostAllowed(undefined)).toBe(false);
  });

  it('IPv6 loopback uses the bracketed form', () => {
    setDesktopBoundAddress('::1', 4000);
    expect(hostAllowed('[::1]:4000')).toBe(true);
    expect(hostAllowed('::1:4000')).toBe(false);
  });

  it('LAN (all interfaces) checks the port only', () => {
    setDesktopBoundAddress('0.0.0.0', 4000);
    expect(hostAllowed('books-pc.local:4000')).toBe(true);
    expect(hostAllowed('books-pc.local:4001')).toBe(false);
  });
});

describe('desktopGate middleware', () => {
  let server: Server;
  let port: number;
  let reached = 0;

  beforeAll(async () => {
    loadDesktop();
    const app = express();
    app.use(desktopGate());
    app.all('*', (req, res) => {
      reached += 1;
      res.json({ ok: true, trusted: req.desktopTrusted === true });
    });
    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
    setDesktopBoundAddress('127.0.0.1', port);
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    _resetDesktopProfileForTests();
    _resetDesktopBoundAddressForTests();
  });

  const host = () => `127.0.0.1:${port}`;

  it('no header / wrong token / different length / correct token → 401, 401, 401, 200', async () => {
    const before = reached;
    const none = await request(port, { path: '/health', headers: { host: host() } });
    const wrong = await request(port, { path: '/health', headers: { host: host(), 'x-cl-token': TOKEN.slice(0, -1) + 'Q' } });
    const shorter = await request(port, { path: '/health', headers: { host: host(), 'x-cl-token': 'abc' } });
    const ok = await request(port, { path: '/health', headers: { host: host(), 'x-cl-token': TOKEN } });
    expect([none.status, wrong.status, shorter.status, ok.status]).toEqual([401, 401, 401, 200]);
    expect(none.body).toBe(wrong.body);
    expect(JSON.parse(none.body)).toEqual({
      error: { message: 'Missing or invalid X-CL-Token.', code: 'DESKTOP_TOKEN_REQUIRED' },
    });
    expect(JSON.parse(ok.body)).toEqual({ ok: true, trusted: true });
    expect(reached - before).toBe(1);
  });

  it('has no exemptions: /ping, /openapi.json, setup status and OPTIONS need the token', async () => {
    for (const [method, p] of [
      ['GET', '/ping'],
      ['GET', '/api/v1/ping'],
      ['GET', '/openapi.json'],
      ['GET', '/api/setup/status'],
      ['OPTIONS', '/api/v1/accounts'],
      ['POST', '/api/v1/stripe/webhook'],
    ] as const) {
      const r = await request(port, { method, path: p, headers: { host: host() } });
      expect(r.status, `${method} ${p}`).toBe(401);
    }
  });

  it('rejects any Origin header, even with a valid token', async () => {
    const r = await request(port, {
      headers: { host: host(), 'x-cl-token': TOKEN, origin: 'http://evil.example' },
    });
    expect(r.status).toBe(403);
    expect(JSON.parse(r.body).error.code).toBe('ORIGIN_NOT_ALLOWED');
    const nullOrigin = await request(port, { headers: { host: host(), 'x-cl-token': TOKEN, origin: 'null' } });
    expect(nullOrigin.status).toBe(403);
  });

  it('rejects a foreign Host header (DNS rebinding) with 421', async () => {
    const r = await request(port, { headers: { host: `attacker.example:${port}`, 'x-cl-token': TOKEN } });
    expect(r.status).toBe(421);
    expect(JSON.parse(r.body).error.code).toBe('HOST_NOT_ALLOWED');
    const ok = await request(port, { headers: { host: `localhost:${port}`, 'x-cl-token': TOKEN } });
    expect(ok.status).toBe(200);
  });
});
