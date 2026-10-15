// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Desktop mode never writes boot secrets (DESKTOP.md: the desktop app keeps
// them in the OS keychain). Two layers: the admin /security routes that
// write or rotate the recovery file / installation id are not mounted, and
// the writers themselves refuse in desktop mode.

import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { Express } from 'express';

const TOKEN = 'secretw_' + 'z'.repeat(40);

// Every /api/v1/admin/security route, as mounted in routes/admin.routes.ts.
const SECURITY_ROUTES: Array<[string, string]> = [
  ['GET', '/api/v1/admin/security/status'],
  ['POST', '/api/v1/admin/security/credential-encryption/recover'],
  ['POST', '/api/v1/admin/security/recovery-file/refresh'],
  ['POST', '/api/v1/admin/security/recovery-key/regenerate'],
  ['POST', '/api/v1/admin/security/recovery-key/test'],
  ['POST', '/api/v1/admin/security/installation-id/rotate'],
  ['DELETE', '/api/v1/admin/security/recovery-key'],
];

async function loadApp(mode: 'desktop' | 'server'): Promise<Express> {
  vi.resetModules();
  const profile = await import('./profile.js');
  if (mode === 'desktop') {
    profile.loadDesktopProfile({
      CL_MODE: 'desktop',
      CL_TOKEN: TOKEN,
      CL_BIND: '127.0.0.1:0',
      CL_DATA_DIR: path.join(os.tmpdir(), 'cl-secret-writes-test'),
    });
  } else {
    profile.loadDesktopProfile({});
  }
  const { app } = await import('../app.js');
  return app;
}

async function withServer<T>(app: Express, fn: (port: number) => Promise<T>): Promise<T> {
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  try {
    return await fn(port);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

afterEach(async () => {
  const profile = await import('./profile.js');
  profile._resetDesktopProfileForTests();
});

describe('admin /security routes', () => {
  it('desktop: every one answers 404 NOT_AVAILABLE_IN_DESKTOP (before auth)', async () => {
    const app = await loadApp('desktop');
    const { setDesktopBoundAddress } = await import('../middleware/desktop-gate.js');
    await withServer(app, async (port) => {
      setDesktopBoundAddress('127.0.0.1', port);
      for (const [method, p] of SECURITY_ROUTES) {
        const r = await fetch(`http://127.0.0.1:${port}${p}`, {
          method,
          headers: { 'x-cl-token': TOKEN, 'content-type': 'application/json', authorization: 'Bearer x' },
          body: method === 'GET' ? undefined : JSON.stringify({ password: 'x', recoveryKey: 'x' }),
        });
        const body = (await r.json()) as { error?: { code?: string } };
        expect(r.status, `${method} ${p}`).toBe(404);
        expect(body.error?.code, `${method} ${p}`).toBe('NOT_AVAILABLE_IN_DESKTOP');
      }
    });
  }, 120_000);

  it('server: still routed (401 from authenticate, not 404)', async () => {
    const app = await loadApp('server');
    await withServer(app, async (port) => {
      for (const [method, p] of SECURITY_ROUTES) {
        const r = await fetch(`http://127.0.0.1:${port}${p}`, { method });
        expect(r.status, `${method} ${p}`).toBe(401);
      }
    });
  }, 120_000);
});

describe('secret writers refuse in desktop mode', () => {
  it('recovery file, sentinel and .env are never written', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-secret-writes-'));
    const prevDataDir = process.env['DATA_DIR'];
    process.env['DATA_DIR'] = dataDir;
    try {
      vi.resetModules();
      const profile = await import('./profile.js');
      profile.loadDesktopProfile({
        CL_MODE: 'desktop',
        CL_TOKEN: TOKEN,
        CL_BIND: '127.0.0.1:0',
        CL_DATA_DIR: dataDir,
      });
      const recovery = await import('../services/env-recovery.service.js');
      const { generateRecoveryKey } = await import('../services/recovery-key.service.js');
      const sentinel = await import('../services/sentinel.service.js');
      const setup = await import('../services/setup.service.js');
      const values = { encryptionKey: 'e'.repeat(64), jwtSecret: 'j'.repeat(64), databaseUrl: 'postgres://u:p@h/d' };

      expect(() => recovery.writeRecoveryFile(generateRecoveryKey(), values, null)).toThrow(/desktop mode/);
      expect(() => recovery.writeRecoveryFileRaw(Buffer.alloc(128))).toThrow(/desktop mode/);
      expect(() =>
        sentinel.createSentinel(
          {
            installationId: '00000000-0000-4000-8000-000000000000',
            hostId: 'h',
            adminEmail: 'a@b.c',
            appVersion: '0',
            databaseUrl: values.databaseUrl,
            jwtSecret: values.jwtSecret,
            tenantCountAtSetup: 0,
          },
          values.encryptionKey,
        ),
      ).toThrow(/desktop mode/);
      expect(() => setup.writeEnvFile({} as Parameters<typeof setup.writeEnvFile>[0])).toThrow(/desktop mode/);
      expect(fs.readdirSync(dataDir)).toEqual([]);
    } finally {
      if (prevDataDir === undefined) delete process.env['DATA_DIR'];
      else process.env['DATA_DIR'] = prevDataDir;
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
