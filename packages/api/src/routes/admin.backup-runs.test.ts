// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// GET /admin/backup/runs — super-admin gating, newest-first listing,
// status/kind filtering, limit/offset validation, and the per-kind
// health summary block. Seeds backup_runs rows directly; does not touch
// the shared backup_* system_settings keys other admin tests use.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'express-async-errors';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import jwt from 'jsonwebtoken';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import { tenants, users, backupRuns } from '../db/schema/index.js';
import { STALE_RUN_ERROR } from '../services/backup-run-log.service.js';
import { adminRouter } from './admin.routes.js';

let server: Server | null = null;
let port = 0;
let adminToken = '';
let staffToken = '';

const ADMIN_EMAIL = 'admin-backup-runs-test@example.com';
const STAFF_EMAIL = 'staff-backup-runs-test@example.com';
const TENANT_SLUG = 'admin-backup-runs-test';

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

function request(method: string, pathname: string, token?: string): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: pathname,
        method,
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
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
    req.end();
  });
}

async function cleanDb() {
  await db.delete(backupRuns);
  await db.delete(users).where(inArray(users.email, [ADMIN_EMAIL, STAFF_EMAIL]));
  await db.delete(tenants).where(eq(tenants.slug, TENANT_SLUG));
}

beforeEach(async () => {
  await cleanDb();

  const [tenant] = await db.insert(tenants).values({ name: 'Backup Runs Test', slug: TENANT_SLUG }).returning();
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

  // Seed a mixed run history (distinct started_at so ordering is stable).
  const base = Date.now() - 60_000;
  const at = (i: number) => new Date(base + i * 1000);
  await db.insert(backupRuns).values([
    { kind: 'db_backup', trigger: 'scheduled', status: 'success', startedAt: at(0), finishedAt: at(0), sizeBytes: 100, artifactName: 'a.vmb' },
    { kind: 'tenant_backup', trigger: 'scheduled', status: 'partial', startedAt: at(1), finishedAt: at(1), tenantId: tenant!.id,
      destinations: { local: { configured: true, ok: true }, mirror: { configured: true, ok: false, error: 'ENOSPC' } } },
    { kind: 'system_backup', trigger: 'manual', status: 'failed', startedAt: at(2), finishedAt: at(2), error: 'boom' },
    { kind: 'db_backup', trigger: 'scheduled', status: 'failed', startedAt: at(3), finishedAt: at(3), error: 'db down' },
  ]);

  await startApp();
});

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }
  await cleanDb();
});

describe('GET /admin/backup/runs', () => {
  it('rejects non-super-admin users', async () => {
    const { status } = await request('GET', '/api/admin/backup/runs', staffToken);
    expect(status).toBe(403);
  });

  it('rejects unauthenticated requests', async () => {
    const { status } = await request('GET', '/api/admin/backup/runs');
    expect(status).toBe(401);
  });

  it('lists runs newest first with total and summary', async () => {
    const { status, json } = await request('GET', '/api/admin/backup/runs', adminToken);
    expect(status).toBe(200);
    const runs = json['runs'] as Array<Record<string, unknown>>;
    expect(json['total']).toBe(4);
    expect(runs).toHaveLength(4);
    expect(runs[0]!['kind']).toBe('db_backup');
    expect(runs[0]!['status']).toBe('failed');
    expect(runs[3]!['kind']).toBe('db_backup');
    expect(runs[3]!['status']).toBe('success');
    // Destination detail round-trips through the endpoint.
    const partialRun = runs.find((r) => r['status'] === 'partial')!;
    const dest = partialRun['destinations'] as Record<string, Record<string, unknown>>;
    expect(dest['mirror']!['ok']).toBe(false);
    expect(dest['mirror']!['error']).toBe('ENOSPC');

    const summary = json['summary'] as Record<string, Record<string, unknown>>;
    expect(summary['db_backup']).toBeTruthy();
    expect(summary['db_backup']!['consecutiveFailures']).toBe(1);
    expect(summary['db_backup']!['lastSuccessAt']).toBeTruthy();
    const lastRun = summary['db_backup']!['lastRun'] as Record<string, unknown>;
    expect(lastRun['status']).toBe('failed');
    expect(summary['system_backup']!['lastSuccessAt']).toBeNull();
    expect(summary['system_backup']!['consecutiveFailures']).toBe(1);
  });

  it('filters by status', async () => {
    const { status, json } = await request('GET', '/api/admin/backup/runs?status=failed', adminToken);
    expect(status).toBe(200);
    expect(json['total']).toBe(2);
    for (const r of json['runs'] as Array<Record<string, unknown>>) expect(r['status']).toBe('failed');
  });

  it('filters by kind', async () => {
    const { status, json } = await request('GET', '/api/admin/backup/runs?kind=db_backup', adminToken);
    expect(status).toBe(200);
    expect(json['total']).toBe(2);
    for (const r of json['runs'] as Array<Record<string, unknown>>) expect(r['kind']).toBe('db_backup');
  });

  it('applies limit and offset', async () => {
    const { json } = await request('GET', '/api/admin/backup/runs?limit=2&offset=1', adminToken);
    const runs = json['runs'] as Array<Record<string, unknown>>;
    expect(runs).toHaveLength(2);
    expect(json['total']).toBe(4);
    expect(json['limit']).toBe(2);
    expect(json['offset']).toBe(1);
    expect(runs[0]!['kind']).toBe('system_backup'); // second-newest
  });

  it('sweeps stale running rows so a crashed backup shows as failed, not running', async () => {
    // A run whose process died 7h ago (never finished) + one started just now.
    await db.insert(backupRuns).values([
      { kind: 'db_backup', trigger: 'scheduled', status: 'running', startedAt: new Date(Date.now() - 7 * 60 * 60 * 1000) },
      { kind: 'db_backup', trigger: 'scheduled', status: 'running', startedAt: new Date() },
    ]);

    const { status, json } = await request('GET', '/api/admin/backup/runs?kind=db_backup', adminToken);
    expect(status).toBe(200);
    const runs = json['runs'] as Array<Record<string, unknown>>;

    const stale = runs.find((r) => r['error'] === STALE_RUN_ERROR)!;
    expect(stale).toBeTruthy();
    expect(stale['status']).toBe('failed');

    // The fresh in-flight run is untouched.
    const stillRunning = runs.filter((r) => r['status'] === 'running');
    expect(stillRunning).toHaveLength(1);
    expect(stillRunning[0]!['error']).toBeNull();
  });

  it('rejects invalid filter values with 400', async () => {
    expect((await request('GET', '/api/admin/backup/runs?status=exploded', adminToken)).status).toBe(400);
    expect((await request('GET', '/api/admin/backup/runs?kind=floppy', adminToken)).status).toBe(400);
  });
});
