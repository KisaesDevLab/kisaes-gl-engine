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
import { createEnvMissingApp } from './env-missing-app.js';
import { createSentinel } from '../services/sentinel.service.js';
import { writeRecoveryFile } from '../services/env-recovery.service.js';
import { generateRecoveryKey } from '../services/recovery-key.service.js';
import crypto from 'crypto';

let tmpDir: string;
let server: Server | null = null;
let port = 0;

async function startApp(missingVars: string[] = ['ENCRYPTION_KEY'], sentinelReadable = true) {
  const app = createEnvMissingApp({ missingVars, sentinelReadable });
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-missing-app-test-'));
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

describe('env-missing-app', () => {
  it('/api/diagnostic/env-status reports missing vars + absent sentinel', async () => {
    await startApp(['DATABASE_URL', 'JWT_SECRET']);
    const { status, json } = await request('GET', '/api/diagnostic/env-status');
    expect(status).toBe(200);
    expect(json.state).toBe('env-missing');
    expect(json.missingVars).toEqual(['DATABASE_URL', 'JWT_SECRET']);
    expect(json.sentinelHeader).toBeNull();
    expect(json.recoveryFilePresent).toBe(false);
  });

  it('/api/diagnostic/env-status exposes sentinel header when present', async () => {
    createSentinel(
      {
        installationId: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
        hostId: 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb',
        adminEmail: 'env-test@example.com',
        appVersion: '0.1.0',
        databaseUrl: 'postgresql://x',
        jwtSecret: 'secret',
        tenantCountAtSetup: 1,
      },
      KEY,
    );
    await startApp();
    const { json } = await request('GET', '/api/diagnostic/env-status');
    expect(json.sentinelHeader?.installationId).toBe('aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa');
    expect(json.sentinelHeader?.adminEmail).toBe('env-test@example.com');
  });

  it('/api/diagnostic/env-recovery 400 without recoveryKey', async () => {
    await startApp();
    const { status } = await request('POST', '/api/diagnostic/env-recovery', {});
    expect(status).toBe(400);
  });

  it('/api/diagnostic/env-recovery 404 when no recovery file exists', async () => {
    await startApp();
    const { status } = await request('POST', '/api/diagnostic/env-recovery', { recoveryKey: 'whatever' });
    expect(status).toBe(404);
  });

  it('/api/diagnostic/env-recovery 401 on wrong key', async () => {
    const correct = generateRecoveryKey();
    const wrong = generateRecoveryKey();
    writeRecoveryFile(
      correct,
      {
        encryptionKey: KEY,
        jwtSecret: 'jwt-sec-for-recovery',
        databaseUrl: 'postgresql://db',
      },
      'inst-id',
    );
    await startApp();
    const { status } = await request('POST', '/api/diagnostic/env-recovery', { recoveryKey: wrong });
    expect(status).toBe(401);
  });

  it('/api/diagnostic/env-recovery writes .env on correct key', async () => {
    const correct = generateRecoveryKey();
    writeRecoveryFile(
      correct,
      {
        encryptionKey: KEY,
        jwtSecret: 'jwt-sec-for-recovery',
        databaseUrl: 'postgresql://db',
      },
      'inst-id',
    );
    await startApp();
    const { status, json } = await request('POST', '/api/diagnostic/env-recovery', { recoveryKey: correct });
    expect(status).toBe(200);
    expect(json.success).toBe(true);

    const envPath = path.join(process.env['CONFIG_DIR']!, '.env');
    expect(fs.existsSync(envPath)).toBe(true);
    const body = fs.readFileSync(envPath, 'utf8');
    expect(body).toContain(`ENCRYPTION_KEY=${KEY}`);
    expect(body).toContain(`JWT_SECRET=jwt-sec-for-recovery`);
    expect(body).toContain(`DATABASE_URL=postgresql://db`);
    // Secrets ONLY: the entrypoint uses this file to fill blanks in the
    // compose environment, so hardcoded defaults here would shadow the
    // operator's real REDIS_URL / CORS_ORIGIN / PORT on every later boot.
    for (const forbidden of ['REDIS_URL=', 'CORS_ORIGIN=', 'PORT=', 'UPLOAD_DIR=', 'BACKUP_DIR=', 'NODE_ENV=']) {
      expect(body).not.toContain(forbidden);
    }
  });

  it('/api/diagnostic/env-recovery writes PLAID_ENCRYPTION_KEY from a v2 file', async () => {
    const correct = generateRecoveryKey();
    const plaid = crypto.randomBytes(32).toString('hex');
    writeRecoveryFile(
      correct,
      { encryptionKey: KEY, jwtSecret: 'jwt-sec-for-recovery', databaseUrl: 'postgresql://db', plaidEncryptionKey: plaid },
      'inst-id',
    );
    await startApp(['PLAID_ENCRYPTION_KEY']);
    const { status } = await request('POST', '/api/diagnostic/env-recovery', { recoveryKey: correct });
    expect(status).toBe(200);
    const body = fs.readFileSync(path.join(process.env['CONFIG_DIR']!, '.env'), 'utf8');
    expect(body).toContain(`PLAID_ENCRYPTION_KEY=${plaid}`);
  });

  // A v1 file has no PLAID_ENCRYPTION_KEY. If the environment lacks it too,
  // writing the file just boots straight back into this page — so the
  // handler must say so instead, and only mint a key on explicit consent.
  it('/api/diagnostic/env-recovery 409s when PLAID_ENCRYPTION_KEY would still be missing', async () => {
    const correct = generateRecoveryKey();
    writeRecoveryFile(correct, { encryptionKey: KEY, jwtSecret: 'jwt-sec', databaseUrl: 'postgresql://db' }, 'inst-id');
    const prev = process.env['PLAID_ENCRYPTION_KEY'];
    delete process.env['PLAID_ENCRYPTION_KEY'];
    try {
      await startApp(['PLAID_ENCRYPTION_KEY']);
      const first = await request('POST', '/api/diagnostic/env-recovery', { recoveryKey: correct });
      expect(first.status).toBe(409);
      expect(first.json.error?.code).toBe('MISSING_AFTER_RECOVERY');
      expect(first.json.error?.missingAfterRecovery).toEqual(['PLAID_ENCRYPTION_KEY']);
      expect(fs.existsSync(path.join(process.env['CONFIG_DIR']!, '.env'))).toBe(false);

      const second = await request('POST', '/api/diagnostic/env-recovery', { recoveryKey: correct, generateMissingKeys: true });
      expect(second.status).toBe(200);
      expect(second.json.generatedKeys).toEqual(['PLAID_ENCRYPTION_KEY']);
      const body = fs.readFileSync(path.join(process.env['CONFIG_DIR']!, '.env'), 'utf8');
      expect(body).toMatch(/PLAID_ENCRYPTION_KEY=[0-9a-f]{64}/);
    } finally {
      if (prev !== undefined) process.env['PLAID_ENCRYPTION_KEY'] = prev;
    }
  });

  it('/api/diagnostic/env-recovery does not complain about a v1 file when the environment supplies the key', async () => {
    const correct = generateRecoveryKey();
    writeRecoveryFile(correct, { encryptionKey: KEY, jwtSecret: 'jwt-sec', databaseUrl: 'postgresql://db' }, 'inst-id');
    // test-setup.ts sets PLAID_ENCRYPTION_KEY in process.env
    await startApp(['ENCRYPTION_KEY']);
    const { status, json } = await request('POST', '/api/diagnostic/env-recovery', { recoveryKey: correct });
    expect(status).toBe(200);
    expect(json.generatedKeys).toEqual([]);
  });

  it('/api/diagnostic/env-recovery rate-limits after 10 attempts', async () => {
    const wrong = generateRecoveryKey();
    writeRecoveryFile(
      generateRecoveryKey(),
      { encryptionKey: KEY, jwtSecret: 'j', databaseUrl: 'd' },
      null,
    );
    await startApp();

    let seen429 = false;
    for (let i = 0; i < 15; i++) {
      const { status } = await request('POST', '/api/diagnostic/env-recovery', { recoveryKey: wrong });
      if (status === 429) {
        seen429 = true;
        break;
      }
    }
    expect(seen429).toBe(true);
  });

  it('/api/setup/initialize is not mounted', async () => {
    await startApp();
    const { status, json } = await request('POST', '/api/setup/initialize', { anything: true });
    expect(status).toBe(503);
    expect(json.error?.code).toBe('ENV_MISSING');
  });

  it('/api/health returns blocked status', async () => {
    await startApp();
    const { status, json } = await request('GET', '/api/health');
    expect(status).toBe(200);
    expect(json.status).toBe('blocked');
    expect(json.code).toBe('ENV_MISSING');
  });
});
