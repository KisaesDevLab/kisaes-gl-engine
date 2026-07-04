// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.
//
// Tenant-level Backblaze B2 storage: available-list exposure, the
// system-default indicator, configure validation, and activation of a
// configured b2 record flowing through the factory.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'express-async-errors';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import jwt from 'jsonwebtoken';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import { tenants, users, systemSettings, storageProviders } from '../db/schema/index.js';
import { storageRouter } from './storage.routes.js';
import { encrypt } from '../utils/encryption.js';
import {
  getProviderForTenant,
  invalidateProviderCache,
  invalidateSystemProviderCache,
} from '../services/storage/storage-provider.factory.js';

let server: Server | null = null;
let port = 0;
let token = '';
let tenantId = '';

const USER_EMAIL = 'storage-b2-test@example.com';
const TENANT_SLUG = 'storage-b2-test';
const SETTING_KEYS = ['storage_system_provider', 'storage_system_config'];

async function startApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/storage', storageRouter);
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

function request(method: string, pathname: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
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
          Authorization: `Bearer ${token}`,
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
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.slug, TENANT_SLUG) });
  if (tenant) {
    await db.delete(storageProviders).where(eq(storageProviders.tenantId, tenant.id));
    await db.delete(users).where(eq(users.email, USER_EMAIL));
    await db.delete(tenants).where(eq(tenants.id, tenant.id));
  }
  invalidateSystemProviderCache();
}

beforeEach(async () => {
  await cleanDb();
  const [tenant] = await db.insert(tenants).values({ name: 'Storage B2 Test', slug: TENANT_SLUG }).returning();
  tenantId = tenant!.id;
  const [user] = await db.insert(users).values({
    tenantId,
    email: USER_EMAIL,
    passwordHash: 'not-used',
    displayName: 'Storage Tester',
    role: 'owner',
  }).returning();
  token = jwt.sign(
    { userId: user!.id, tenantId, role: 'owner', isSuperAdmin: false },
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
  await cleanDb();
});

describe('GET /settings/storage with B2', () => {
  it('lists b2 as an available provider with status', async () => {
    const { status, json } = await request('GET', '/api/storage/');
    expect(status).toBe(200);
    expect(json['available']).toContain('b2');
    const providerStatus = json['providerStatus'] as Record<string, { configured: boolean; connected: boolean }>;
    expect(providerStatus['b2']).toEqual({ configured: true, connected: false });
    expect(json['systemDefault']).toBe('local');
  });

  it('surfaces the system default on the active card when the tenant has no provider', async () => {
    const { saveSystemStorageConfig } = await import('../services/admin.service.js');
    await saveSystemStorageConfig({
      storageSystemProvider: 'b2',
      storageSystemConfig: JSON.stringify({
        bucket: 'sys-bucket',
        endpoint: 'https://s3.us-west-004.backblazeb2.com',
        keyId: 'sys-key',
        application_key_encrypted: encrypt('sys-secret'),
      }),
    });
    invalidateSystemProviderCache();

    const { json } = await request('GET', '/api/storage/');
    expect(json['systemDefault']).toBe('b2');
    const active = json['active'] as Record<string, unknown>;
    expect(active['provider']).toBe('b2');
    expect(active['isSystemDefault']).toBe(true);
  });

  it('keeps the tenant-configured active provider even when a system default exists', async () => {
    const { saveSystemStorageConfig } = await import('../services/admin.service.js');
    await saveSystemStorageConfig({
      storageSystemProvider: 'b2',
      storageSystemConfig: JSON.stringify({
        bucket: 'sys-bucket',
        endpoint: 'https://s3.us-west-004.backblazeb2.com',
        keyId: 'sys-key',
        application_key_encrypted: encrypt('sys-secret'),
      }),
    });
    invalidateSystemProviderCache();
    await db.insert(storageProviders).values({
      tenantId,
      provider: 's3',
      isActive: true,
      config: { bucket: 'tenant-bucket', accessKeyId: 'k', secretAccessKey: encrypt('s') },
      healthStatus: 'healthy',
      displayName: 'S3 Storage',
    });

    const { json } = await request('GET', '/api/storage/');
    const active = json['active'] as Record<string, unknown>;
    expect(active['provider']).toBe('s3');
    expect(active['isSystemDefault']).toBeUndefined();
  });
});

describe('POST /settings/storage/configure/b2', () => {
  it('rejects incomplete configuration', async () => {
    const { status, json } = await request('POST', '/api/storage/configure/b2', {
      bucket: 'my-bucket',
      keyId: 'key-id',
      // endpoint + applicationKey missing
    });
    expect(status).toBe(400);
    expect((json['error'] as { message: string }).message).toContain('required');
  });
});

describe('activating a configured b2 provider', () => {
  it('activates and resolves through the factory as b2', async () => {
    // Insert a configured (health-checked elsewhere) b2 record directly —
    // the live connection test in /configure/b2 needs a reachable bucket.
    await db.insert(storageProviders).values({
      tenantId,
      provider: 'b2',
      isActive: false,
      config: {
        bucket: 'tenant-bucket',
        endpoint: 'https://s3.us-west-004.backblazeb2.com',
        keyId: 'tenant-key',
        applicationKey: encrypt('tenant-secret'),
      },
      healthStatus: 'healthy',
      displayName: 'Backblaze B2',
    });

    const { status, json } = await request('POST', '/api/storage/activate', { provider: 'b2' });
    expect(status).toBe(200);
    expect(json['activated']).toBe('b2');

    invalidateProviderCache(tenantId);
    const provider = await getProviderForTenant(tenantId);
    expect(provider.name).toBe('b2');
  });
});
