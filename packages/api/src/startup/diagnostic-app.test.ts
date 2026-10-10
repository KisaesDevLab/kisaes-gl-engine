// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { createDiagnosticApp } from './diagnostic-app.js';
import { createSentinel, sentinelExists } from '../services/sentinel.service.js';
import { writeRecoveryFile } from '../services/env-recovery.service.js';
import { generateRecoveryKey } from '../services/recovery-key.service.js';
import { ensureHostId, readHostId } from '../services/host-id.service.js';
import { readRestoreIntent, restoreIntentExists } from '../services/restore-intent.service.js';
import crypto from 'crypto';
import type { ValidationResult } from './installation-validator.js';
import { vi } from 'vitest';

// prepare-restore must confirm the database holds no accounts. The shared
// test database may hold users from other suites, so pin the count here —
// everything else in setup.service (withSetupLock, marker path) stays real.
vi.mock('../services/setup.service.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../services/setup.service.js')>();
  return { ...original, countTenantsAndUsers: vi.fn(async () => ({ tenants: 0, users: 0 })) };
});

let tmpDir: string;
let server: Server | null = null;
let port = 0;

async function startApp(result: ValidationResult) {
  const app = createDiagnosticApp(result);
  return new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      port = (server!.address() as AddressInfo).port;
      resolve();
    });
  });
}

function request(method: string, pathname: string, body?: unknown): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : undefined;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: pathname,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(data ? { 'Content-Length': String(data.length) } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          try {
            resolve({ status: res.statusCode ?? 0, json: raw ? JSON.parse(raw) : null });
          } catch {
            resolve({ status: res.statusCode ?? 0, json: raw });
          }
        });
      },
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const KEY = crypto.randomBytes(32).toString('hex');

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'diagnostic-app-test-'));
  process.env['DATA_DIR'] = tmpDir;
  process.env['CONFIG_DIR'] = path.join(tmpDir, 'config');
});

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }
  delete process.env['DATA_DIR'];
  delete process.env['CONFIG_DIR'];
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const RESET: ValidationResult = { status: 'blocked', code: 'DATABASE_RESET_DETECTED', details: 'test' };

function writeSentinel(hostId: string) {
  createSentinel(
    {
      installationId: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
      hostId,
      adminEmail: 'admin@example.com',
      appVersion: '0.1.0',
      databaseUrl: 'postgresql://x',
      jwtSecret: 'secret',
      tenantCountAtSetup: 1,
    },
    KEY,
  );
}

describe('diagnostic-app — prepare-restore (same-host DR path)', () => {
  it('409s outside DATABASE_RESET_DETECTED / ORPHANED_DATA', async () => {
    await startApp({ status: 'blocked', code: 'SENTINEL_DECRYPT_FAILED', details: 'test' });
    const { status } = await request('POST', '/api/diagnostic/prepare-restore', { recoveryKey: 'x', confirm: 'RESTORE' });
    expect(status).toBe(409);
  });

  it('400s without the typed RESTORE confirmation', async () => {
    await startApp(RESET);
    const { status } = await request('POST', '/api/diagnostic/prepare-restore', { recoveryKey: 'x', confirm: 'yes' });
    expect(status).toBe(400);
  });

  it('409s with NO_RECOVERY_FILE when the key cannot be verified against anything', async () => {
    await startApp(RESET);
    const { status, json } = await request('POST', '/api/diagnostic/prepare-restore', { recoveryKey: 'x', confirm: 'RESTORE' });
    expect(status).toBe(409);
    expect(json.error?.code).toBe('NO_RECOVERY_FILE');
  });

  it('401s on a wrong recovery key and changes nothing', async () => {
    const hostId = ensureHostId();
    writeSentinel(hostId);
    writeRecoveryFile(generateRecoveryKey(), { encryptionKey: KEY, jwtSecret: 's', databaseUrl: 'd' }, 'inst');
    await startApp(RESET);
    const { status } = await request('POST', '/api/diagnostic/prepare-restore', { recoveryKey: generateRecoveryKey(), confirm: 'RESTORE' });
    expect(status).toBe(401);
    expect(sentinelExists()).toBe(true);
    expect(restoreIntentExists()).toBe(false);
  });

  it('with the right key: sets sentinel + marker aside, keeps host-id, records intent', async () => {
    const hostId = ensureHostId();
    writeSentinel(hostId);
    const key = generateRecoveryKey();
    writeRecoveryFile(key, { encryptionKey: KEY, jwtSecret: 's', databaseUrl: 'd' }, 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa');
    fs.mkdirSync(process.env['CONFIG_DIR']!, { recursive: true });
    const marker = path.join(process.env['CONFIG_DIR']!, '.initialized');
    fs.writeFileSync(marker, '{}');
    const { getInitializedMarkerPath } = await import('../services/setup.service.js');
    const realMarker = getInitializedMarkerPath();
    expect(realMarker).toBe(marker); // CONFIG_DIR is resolved per call, not at import

    await startApp(RESET);
    const { status, json } = await request('POST', '/api/diagnostic/prepare-restore', { recoveryKey: key, confirm: 'RESTORE' });
    expect(status).toBe(200);
    expect(json.success).toBe(true);

    expect(sentinelExists()).toBe(false);
    expect(fs.existsSync(realMarker)).toBe(false);
    expect(readHostId()).toBe(hostId); // same-host identity preserved
    expect(restoreIntentExists()).toBe(true);
    expect(readRestoreIntent()?.previousInstallationId).toBe('aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa');
    // copies kept — nothing was destroyed
    expect(fs.readdirSync(tmpDir).some((f) => f.startsWith('.sentinel.pre-restore-'))).toBe(true);
    expect(fs.readdirSync(process.env['CONFIG_DIR']!).some((f) => f.startsWith('.initialized.pre-restore-'))).toBe(true);

    // The status endpoint now tells the page a restart is all that is left.
    const st = await request('GET', '/api/diagnostic/status');
    expect(st.json.restoreIntent).toBe(true);
  });
});

describe('diagnostic-app', () => {
  it('/api/diagnostic/status echoes the cached validation result', async () => {
    await startApp({
      status: 'blocked',
      code: 'DATABASE_RESET_DETECTED',
      details: 'test',
    });
    const { status, json } = await request('GET', '/api/diagnostic/status');
    expect(status).toBe(200);
    expect(json.result.status).toBe('blocked');
    expect(json.result.code).toBe('DATABASE_RESET_DETECTED');
  });

  it('/api/diagnostic/status includes sentinel header when available', async () => {
    createSentinel(
      {
        installationId: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
        hostId: 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb',
        adminEmail: 'diag@example.com',
        appVersion: '0.1.0',
        databaseUrl: 'x',
        jwtSecret: 'y',
        tenantCountAtSetup: 1,
      },
      KEY,
    );
    await startApp({
      status: 'blocked',
      code: 'DATABASE_RESET_DETECTED',
      details: 'test',
    });
    const { json } = await request('GET', '/api/diagnostic/status');
    expect(json.sentinelHeader?.installationId).toBe('aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa');
  });

  it('does NOT expose /api/setup/* in blocked state', async () => {
    await startApp({
      status: 'blocked',
      code: 'DATABASE_RESET_DETECTED',
      details: 'test',
    });
    const { status, json } = await request('POST', '/api/setup/initialize', { anything: true });
    expect(status).toBe(503);
    expect(json.error?.code).toBe('DATABASE_RESET_DETECTED');
  });

  it('/api/diagnostic/regenerate-sentinel returns 400 without credentials', async () => {
    await startApp({
      status: 'blocked',
      code: 'SENTINEL_DECRYPT_FAILED',
      details: 'test',
    });
    const { status } = await request('POST', '/api/diagnostic/regenerate-sentinel', {});
    expect(status).toBe(400);
  });

  it('/api/health exposes the blocked status for monitors', async () => {
    await startApp({
      status: 'blocked',
      code: 'SENTINEL_CORRUPT',
      details: 'test',
    });
    const { status, json } = await request('GET', '/api/health');
    expect(status).toBe(200);
    expect(json.status).toBe('blocked');
    expect(json.code).toBe('SENTINEL_CORRUPT');
  });
});
