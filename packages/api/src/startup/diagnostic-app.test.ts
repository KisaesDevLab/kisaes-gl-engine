import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { createDiagnosticApp } from './diagnostic-app.js';
import { createSentinel } from '../services/sentinel.service.js';
import crypto from 'crypto';
import type { ValidationResult } from './installation-validator.js';

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
});

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }
  delete process.env['DATA_DIR'];
  fs.rmSync(tmpDir, { recursive: true, force: true });
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
