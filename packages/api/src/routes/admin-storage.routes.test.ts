// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// System-level file storage admin routes + B2 remote-backup config.
// Covers: secret encryption at rest, secret masking on GET, omitted
// secrets preserved on re-save, super-admin gating, the local
// put/get/delete probe, and the b2 case of getSystemRemoteProvider.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'express-async-errors';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import jwt from 'jsonwebtoken';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import { tenants, users, systemSettings } from '../db/schema/index.js';
import { adminRouter } from './admin.routes.js';
import { decrypt } from '../utils/encryption.js';
import { __getSystemRemoteProviderForTests } from '../services/backup.service.js';
import { invalidateSystemProviderCache } from '../services/storage/storage-provider.factory.js';

let tmpDir: string;
let originalUploadDir: string | undefined;
let server: Server | null = null;
let port = 0;
let adminToken = '';
let staffToken = '';

const ADMIN_EMAIL = 'admin-storage-test@example.com';
const STAFF_EMAIL = 'staff-storage-test@example.com';
const TENANT_SLUG = 'admin-storage-test';

const SETTING_KEYS = [
  'storage_system_provider',
  'storage_system_config',
  'backup_remote_provider',
  'backup_remote_config',
];

async function startApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/admin', adminRouter);
  app.use((err: Error & { statusCode?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err.statusCode ?? 500).json({ error: { message: err.message } });
  });
  return new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      port = (server!.address() as AddressInfo).port;
      resolve();
    });
  });
}

function request(method: string, pathname: string, body?: unknown, token?: string): Promise<{ status: number; json: Record<string, unknown> }> {
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
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(data ? { 'Content-Length': String(data.length) } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          try {
            resolve({ status: res.statusCode ?? 0, json: raw ? JSON.parse(raw) : {} });
          } catch {
            resolve({ status: res.statusCode ?? 0, json: { raw } });
          }
        });
      },
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function cleanDb() {
  await db.delete(systemSettings).where(inArray(systemSettings.key, SETTING_KEYS));
  await db.delete(users).where(inArray(users.email, [ADMIN_EMAIL, STAFF_EMAIL]));
  await db.delete(tenants).where(eq(tenants.slug, TENANT_SLUG));
  invalidateSystemProviderCache();
}

async function getStoredSetting(key: string): Promise<string | null> {
  const row = await db.query.systemSettings.findFirst({ where: eq(systemSettings.key, key) });
  return row?.value ?? null;
}

beforeEach(async () => {
  await cleanDb();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-storage-test-'));
  originalUploadDir = process.env['UPLOAD_DIR'];
  process.env['UPLOAD_DIR'] = tmpDir;

  const [tenant] = await db.insert(tenants).values({ name: 'Storage Admin Test', slug: TENANT_SLUG }).returning();

  const [admin] = await db.insert(users).values({
    tenantId: tenant!.id,
    email: ADMIN_EMAIL,
    passwordHash: 'not-used',
    displayName: 'Admin',
    role: 'owner',
    isSuperAdmin: true,
  }).returning();
  const [staff] = await db.insert(users).values({
    tenantId: tenant!.id,
    email: STAFF_EMAIL,
    passwordHash: 'not-used',
    displayName: 'Staff',
    role: 'bookkeeper',
    isSuperAdmin: false,
  }).returning();

  adminToken = jwt.sign(
    { userId: admin!.id, tenantId: tenant!.id, role: 'owner', isSuperAdmin: true },
    process.env['JWT_SECRET']!,
    { expiresIn: '5m' },
  );
  staffToken = jwt.sign(
    { userId: staff!.id, tenantId: tenant!.id, role: 'bookkeeper', isSuperAdmin: false },
    process.env['JWT_SECRET']!,
    { expiresIn: '5m' },
  );

  await startApp();
});

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }
  if (originalUploadDir === undefined) delete process.env['UPLOAD_DIR'];
  else process.env['UPLOAD_DIR'] = originalUploadDir;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  await cleanDb();
});

describe('GET /storage/system-config', () => {
  it('rejects non-super-admin users', async () => {
    const { status } = await request('GET', '/api/admin/storage/system-config', undefined, staffToken);
    expect(status).toBe(403);
  });

  it('returns local defaults when nothing is configured', async () => {
    const { status, json } = await request('GET', '/api/admin/storage/system-config', undefined, adminToken);
    expect(status).toBe(200);
    expect(json['storageSystemProvider']).toBe('local');
    expect(json['envOverrideActive']).toBe(false);
  });
});

describe('PUT /storage/system-config', () => {
  it('rejects unknown providers', async () => {
    const { status } = await request('PUT', '/api/admin/storage/system-config', { storageSystemProvider: 'ftp' }, adminToken);
    expect(status).toBe(400);
  });

  it('encrypts the B2 application key at rest and masks it on GET', async () => {
    const { status } = await request('PUT', '/api/admin/storage/system-config', {
      storageSystemProvider: 'b2',
      providerConfig: {
        bucket: 'sys-bucket',
        endpoint: 'https://s3.us-west-004.backblazeb2.com',
        keyId: 'sys-key-id',
        applicationKey: 'plaintext-app-key',
        prefix: 'files/',
      },
    }, adminToken);
    expect(status).toBe(200);

    // Encrypted at rest, never stored plaintext
    const stored = JSON.parse((await getStoredSetting('storage_system_config'))!) as Record<string, string>;
    expect(stored['application_key_encrypted']).toBeDefined();
    expect(stored['application_key_encrypted']).not.toContain('plaintext-app-key');
    expect(decrypt(stored['application_key_encrypted']!)).toBe('plaintext-app-key');
    expect(JSON.stringify(stored)).not.toContain('plaintext-app-key');

    // GET masks the secret to a has* flag
    const { json } = await request('GET', '/api/admin/storage/system-config', undefined, adminToken);
    expect(json['storageSystemProvider']).toBe('b2');
    const safe = JSON.parse(json['storageSystemConfig'] as string) as Record<string, unknown>;
    expect(safe['application_key_encrypted']).toBeUndefined();
    expect(safe['hasApplicationKey']).toBe(true);
    expect(safe['bucket']).toBe('sys-bucket');
    expect(safe['keyId']).toBe('sys-key-id');
  });

  it('preserves the stored secret when omitted on re-save', async () => {
    await request('PUT', '/api/admin/storage/system-config', {
      storageSystemProvider: 'b2',
      providerConfig: {
        bucket: 'sys-bucket',
        endpoint: 'https://s3.us-west-004.backblazeb2.com',
        keyId: 'sys-key-id',
        applicationKey: 'the-secret',
      },
    }, adminToken);
    const before = JSON.parse((await getStoredSetting('storage_system_config'))!) as Record<string, string>;

    // Re-save without the applicationKey (form field left blank)
    const { status } = await request('PUT', '/api/admin/storage/system-config', {
      storageSystemProvider: 'b2',
      providerConfig: {
        bucket: 'renamed-bucket',
        endpoint: 'https://s3.us-west-004.backblazeb2.com',
        keyId: 'sys-key-id',
      },
    }, adminToken);
    expect(status).toBe(200);

    const after = JSON.parse((await getStoredSetting('storage_system_config'))!) as Record<string, string>;
    expect(after['bucket']).toBe('renamed-bucket');
    expect(after['application_key_encrypted']).toBe(before['application_key_encrypted']);
    expect(decrypt(after['application_key_encrypted']!)).toBe('the-secret');
  });
});

describe('POST /storage/system-test', () => {
  it('runs a live put/get/delete probe against the local provider', async () => {
    await request('PUT', '/api/admin/storage/system-config', { storageSystemProvider: 'local' }, adminToken);
    const { status, json } = await request('POST', '/api/admin/storage/system-test', undefined, adminToken);
    expect(status).toBe(200);
    expect(json['status']).toBe('healthy');
    expect(json['probe']).toBe('ok');
    expect(json['provider']).toBe('local');
    // Probe cleaned up after itself
    const healthDir = path.join(tmpDir, '_vibe_health');
    const leftovers = fs.existsSync(healthDir) ? fs.readdirSync(healthDir) : [];
    expect(leftovers).toEqual([]);
  });

  it('rejects non-super-admin users', async () => {
    const { status } = await request('POST', '/api/admin/storage/system-test', undefined, staffToken);
    expect(status).toBe(403);
  });
});

describe('backup remote config — Backblaze B2', () => {
  it('stores the B2 application key encrypted and masks it on GET', async () => {
    const { status } = await request('PUT', '/api/admin/backup/remote-config', {
      backupRemoteProvider: 'b2',
      providerConfig: {
        bucket: 'backup-bucket',
        endpoint: 'https://s3.us-west-004.backblazeb2.com',
        keyId: 'backup-key-id',
        applicationKey: 'backup-app-secret',
        prefix: 'backups/',
      },
    }, adminToken);
    expect(status).toBe(200);

    const stored = JSON.parse((await getStoredSetting('backup_remote_config'))!) as Record<string, string>;
    expect(decrypt(stored['application_key_encrypted']!)).toBe('backup-app-secret');
    expect(JSON.stringify(stored)).not.toContain('backup-app-secret');

    const { json } = await request('GET', '/api/admin/backup/remote-config', undefined, adminToken);
    expect(json['backupRemoteProvider']).toBe('b2');
    const safe = JSON.parse(json['backupRemoteConfig'] as string) as Record<string, unknown>;
    expect(safe['application_key_encrypted']).toBeUndefined();
    expect(safe['hasApplicationKey']).toBe(true);
  });

  it('getSystemRemoteProvider constructs a b2 provider from the saved config', async () => {
    await request('PUT', '/api/admin/backup/remote-config', {
      backupRemoteProvider: 'b2',
      providerConfig: {
        bucket: 'backup-bucket',
        endpoint: 'https://s3.us-west-004.backblazeb2.com',
        keyId: 'backup-key-id',
        applicationKey: 'backup-app-secret',
      },
    }, adminToken);

    const provider = await __getSystemRemoteProviderForTests();
    expect(provider).not.toBeNull();
    expect(provider!.name).toBe('b2');
  });

  it('getSystemRemoteProvider returns null for an incomplete b2 config', async () => {
    await request('PUT', '/api/admin/backup/remote-config', {
      backupRemoteProvider: 'b2',
      providerConfig: { bucket: 'backup-bucket' }, // no keyId / endpoint
    }, adminToken);

    const provider = await __getSystemRemoteProviderForTests();
    expect(provider).toBeNull();
  });
});
