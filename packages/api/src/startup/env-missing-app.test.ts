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
