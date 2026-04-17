// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
// express-async-errors patches Express 4 to auto-catch async route handler
// throws and forward them to the error middleware. The real app imports it
// once at startup; tests that mount the admin router on a fresh app need to
// do the same or every async-thrown error (e.g. from authenticate) hangs
// the response.
import 'express-async-errors';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { tenants, users, systemSettings } from '../db/schema/index.js';
import { adminRouter } from './admin.routes.js';
import { createSentinel, sentinelExists } from '../services/sentinel.service.js';
import { recoveryFileExists, readRecoveryFile } from '../services/env-recovery.service.js';
import { generateRecoveryKey } from '../services/recovery-key.service.js';
import { SystemSettingsKeys } from '../constants/system-settings-keys.js';

let tmpDir: string;
let server: Server | null = null;
let port = 0;
let adminToken = '';
let adminUserId = '';
let adminTenantId = '';

const ADMIN_EMAIL = `admin-sec-${Date.now()}@example.com`;
const ADMIN_PASSWORD = 'super-secret-123';

async function startApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/admin', adminRouter);
  // Simple error handler so errors don't crash the test. AppError exposes
  // statusCode (not status) — use whichever is present.
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status =
      typeof err.statusCode === 'number'
        ? err.statusCode
        : typeof err.status === 'number'
          ? err.status
          : 500;
    res.status(status).json({ error: { message: err.message, code: err.code } });
  });
  return new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      port = (server!.address() as AddressInfo).port;
      resolve();
    });
  });
}

function request(method: string, pathname: string, body?: unknown, token?: string): Promise<{ status: number; json: any }> {
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

async function cleanDb() {
  await db.delete(users).where(eq(users.email, ADMIN_EMAIL));
  await db.delete(tenants).where(eq(tenants.slug, `sec-${ADMIN_EMAIL}`));
  await db.delete(systemSettings).where(eq(systemSettings.key, SystemSettingsKeys.INSTALLATION_ID));
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-sec-test-'));
  process.env['DATA_DIR'] = tmpDir;
  await cleanDb();

  // Seed a super admin with a known password and a JWT for it.
  const [tenant] = await db
    .insert(tenants)
    .values({ name: 'Sec Tenant', slug: `sec-${ADMIN_EMAIL}` })
    .returning();
  adminTenantId = tenant!.id;

  const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 12);
  const [user] = await db
    .insert(users)
    .values({
      tenantId: adminTenantId,
      email: ADMIN_EMAIL,
      passwordHash,
      displayName: 'Admin',
      role: 'owner',
      isSuperAdmin: true,
    })
    .returning();
  adminUserId = user!.id;

  adminToken = jwt.sign(
    {
      userId: adminUserId,
      tenantId: adminTenantId,
      role: 'owner',
      isSuperAdmin: true,
    },
    process.env['JWT_SECRET']!,
    { expiresIn: '5m' },
  );

  // Seed installation_id and a sentinel so security/status has something to show
  await db
    .insert(systemSettings)
    .values({ key: SystemSettingsKeys.INSTALLATION_ID, value: 'test-install-id' });

  createSentinel(
    {
      installationId: 'test-install-id',
      hostId: 'test-host-id',
      adminEmail: ADMIN_EMAIL,
      appVersion: '0.1.0',
      databaseUrl: process.env['DATABASE_URL']!,
      jwtSecret: process.env['JWT_SECRET']!,
      tenantCountAtSetup: 1,
    },
    process.env['ENCRYPTION_KEY']!,
  );

  await startApp();
});

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }
  delete process.env['DATA_DIR'];
  fs.rmSync(tmpDir, { recursive: true, force: true });
  await cleanDb();
});

describe('admin security routes', () => {
  describe('GET /security/status', () => {
    it('rejects unauthenticated requests', async () => {
      const { status } = await request('GET', '/api/admin/security/status');
      expect(status).toBe(401);
    });

    it('returns sentinel + DB state for super admins', async () => {
      const { status, json } = await request('GET', '/api/admin/security/status', undefined, adminToken);
      expect(status).toBe(200);
      expect(json.sentinelExists).toBe(true);
      expect(json.sentinelHeader?.installationId).toBe('test-install-id');
      expect(json.dbInstallationId).toBe('test-install-id');
      expect(json.recoveryFileExists).toBe(false);
      expect(json.recoveryFileStale).toBe(false);
    });
  });

  describe('POST /security/recovery-key/regenerate', () => {
    it('400 without password', async () => {
      const { status } = await request('POST', '/api/admin/security/recovery-key/regenerate', {}, adminToken);
      expect(status).toBe(400);
    });

    it('401 with wrong password', async () => {
      const { status } = await request(
        'POST',
        '/api/admin/security/recovery-key/regenerate',
        { password: 'wrong' },
        adminToken,
      );
      expect(status).toBe(401);
    });

    it('writes a new recovery file and returns a fresh RKVMB key on success', async () => {
      const { status, json } = await request(
        'POST',
        '/api/admin/security/recovery-key/regenerate',
        { password: ADMIN_PASSWORD },
        adminToken,
      );
      expect(status).toBe(200);
      expect(json.success).toBe(true);
      expect(json.recoveryKey).toMatch(/^RKVMB-[A-Z2-9-]+$/);
      expect(recoveryFileExists()).toBe(true);

      const contents = readRecoveryFile(json.recoveryKey);
      expect(contents).not.toBeNull();
      expect(contents!.encryptionKey).toBe(process.env['ENCRYPTION_KEY']);
      expect(contents!.jwtSecret).toBe(process.env['JWT_SECRET']);
    });
  });

  describe('POST /security/recovery-key/test', () => {
    it('400 without recoveryKey body', async () => {
      const { status } = await request('POST', '/api/admin/security/recovery-key/test', {}, adminToken);
      expect(status).toBe(400);
    });

    it('404 when no recovery file exists', async () => {
      const { status } = await request(
        'POST',
        '/api/admin/security/recovery-key/test',
        { recoveryKey: generateRecoveryKey() },
        adminToken,
      );
      expect(status).toBe(404);
    });

    it('validates a correct key without revealing the secrets', async () => {
      const regen = await request(
        'POST',
        '/api/admin/security/recovery-key/regenerate',
        { password: ADMIN_PASSWORD },
        adminToken,
      );
      const { status, json } = await request(
        'POST',
        '/api/admin/security/recovery-key/test',
        { recoveryKey: regen.json.recoveryKey },
        adminToken,
      );
      expect(status).toBe(200);
      expect(json.valid).toBe(true);
      expect(json).not.toHaveProperty('encryptionKey');
      expect(json).not.toHaveProperty('jwtSecret');
    });

    it('rejects a wrong key', async () => {
      await request(
        'POST',
        '/api/admin/security/recovery-key/regenerate',
        { password: ADMIN_PASSWORD },
        adminToken,
      );
      const wrong = generateRecoveryKey();
      const { status, json } = await request(
        'POST',
        '/api/admin/security/recovery-key/test',
        { recoveryKey: wrong },
        adminToken,
      );
      expect(status).toBe(401);
      expect(json.valid).toBe(false);
    });
  });

  describe('POST /security/installation-id/rotate', () => {
    it('401 with wrong password', async () => {
      const { status } = await request(
        'POST',
        '/api/admin/security/installation-id/rotate',
        { password: 'wrong' },
        adminToken,
      );
      expect(status).toBe(401);
    });

    it('rotates installation_id and returns a fresh recovery key', async () => {
      const beforeId = 'test-install-id';
      const { status, json } = await request(
        'POST',
        '/api/admin/security/installation-id/rotate',
        { password: ADMIN_PASSWORD },
        adminToken,
      );
      expect(status).toBe(200);
      expect(json.success).toBe(true);
      expect(json.installationId).not.toBe(beforeId);
      expect(json.recoveryKey).toMatch(/^RKVMB-[A-Z2-9-]+$/);
      expect(sentinelExists()).toBe(true);
    });
  });

  describe('DELETE /security/recovery-key', () => {
    it('removes the recovery file on correct password', async () => {
      await request(
        'POST',
        '/api/admin/security/recovery-key/regenerate',
        { password: ADMIN_PASSWORD },
        adminToken,
      );
      expect(recoveryFileExists()).toBe(true);

      const { status } = await request(
        'DELETE',
        '/api/admin/security/recovery-key',
        { password: ADMIN_PASSWORD },
        adminToken,
      );
      expect(status).toBe(200);
      expect(recoveryFileExists()).toBe(false);
    });
  });
});
