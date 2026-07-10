// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// End-to-end enforcement test: real DB + authenticate + requireResource
// + permissionService. Proves the locked policy —
//   - owner/accountant → full; readonly → view (write blocked)
//   - bookkeeper with NO permission row → legacy full (no regression)
//   - bookkeeper with a template → exactly what the template grants
//     (the user's example: view Invoices, full Receive Payment)
//   - permission mutations write audit rows

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'express-async-errors';
import express from 'express';
import { Router } from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { tenants, users, permissionTemplates, userPermissions, auditLog as auditLogTable } from '../db/schema/index.js';
import { authenticate } from './auth.js';
import { requireResource } from './permission.js';
import * as permissionService from '../services/permission.service.js';
import { errorHandler } from './error-handler.js';

let server: Server | null = null;
let port = 0;
let tenantId = '';
const ids: Record<string, string> = {};

function tokenFor(userId: string, role: string, isSuperAdmin = false) {
  return jwt.sign({ userId, tenantId, role, isSuperAdmin }, process.env['JWT_SECRET']!, { expiresIn: '5m' });
}

function request(method: string, pathname: string, token?: string): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path: pathname, method,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          try { resolve({ status: res.statusCode ?? 0, json: raw ? JSON.parse(raw) : null }); }
          catch { resolve({ status: res.statusCode ?? 0, json: raw }); }
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

async function startApp() {
  const app = express();
  app.use(express.json());
  const guarded = Router();
  guarded.use(authenticate);
  guarded.get('/invoices', requireResource('invoices'), (_req, res) => res.json({ ok: true }));
  guarded.post('/invoices', requireResource('invoices'), (_req, res) => res.json({ ok: true }));
  guarded.post('/payments/receive', requireResource('receive_payment'), (_req, res) => res.json({ ok: true }));
  app.use('/api/v1', guarded);
  app.use(errorHandler);
  return new Promise<void>((resolve) => {
    server = app.listen(0, () => { port = (server!.address() as AddressInfo).port; resolve(); });
  });
}

async function seed() {
  const [t] = await db.insert(tenants).values({ name: 'Perm T', slug: 'perm-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6) }).returning();
  tenantId = t!.id;
  const passwordHash = await bcrypt.hash('pw-123', 12);
  const mk = async (key: string, role: string) => {
    const [u] = await db.insert(users).values({
      tenantId, email: `${key}-${Date.now()}-${Math.random().toString(36).slice(2, 5)}@ex.com`,
      passwordHash, displayName: key, role, isSuperAdmin: false,
    }).returning();
    ids[key] = u!.id;
  };
  await mk('owner', 'owner');
  await mk('readonly', 'readonly');
  await mk('bkRestricted', 'bookkeeper');
  await mk('bkLegacy', 'bookkeeper');
}

async function cleanDb() {
  if (tenantId) {
    await db.delete(auditLogTable).where(eq(auditLogTable.tenantId, tenantId));
    await db.delete(userPermissions).where(eq(userPermissions.tenantId, tenantId));
    await db.delete(permissionTemplates).where(eq(permissionTemplates.tenantId, tenantId));
    await db.delete(users).where(eq(users.tenantId, tenantId));
    await db.delete(tenants).where(eq(tenants.id, tenantId));
  }
  tenantId = '';
}

beforeEach(async () => {
  await cleanDb();
  await seed();
  await startApp();
});

afterEach(async () => {
  if (server) { await new Promise<void>((r) => server!.close(() => r())); server = null; }
  await cleanDb();
});

describe('requireResource enforcement', () => {
  it('401 without a token', async () => {
    expect((await request('GET', '/api/v1/invoices')).status).toBe(401);
  });

  it('owner has full access (read + write)', async () => {
    const tk = tokenFor(ids['owner']!, 'owner');
    expect((await request('GET', '/api/v1/invoices', tk)).status).toBe(200);
    expect((await request('POST', '/api/v1/invoices', tk)).status).toBe(200);
  });

  it('readonly can read but not write', async () => {
    const tk = tokenFor(ids['readonly']!, 'readonly');
    expect((await request('GET', '/api/v1/invoices', tk)).status).toBe(200);
    expect((await request('POST', '/api/v1/invoices', tk)).status).toBe(403);
  });

  it('bookkeeper with no permission row keeps legacy full access', async () => {
    const tk = tokenFor(ids['bkLegacy']!, 'bookkeeper');
    expect((await request('POST', '/api/v1/invoices', tk)).status).toBe(200);
  });

  it('bookkeeper with a template: view Invoices, full Receive Payment', async () => {
    const tpl = await permissionService.createTemplate(tenantId, {
      name: 'AR Clerk',
      permissions: { invoices: 'view', receive_payment: 'full' },
    }, ids['owner']!);
    await permissionService.setUserPermissions(tenantId, ids['bkRestricted']!, { templateId: tpl.id }, ids['owner']!);

    const tk = tokenFor(ids['bkRestricted']!, 'bookkeeper');
    expect((await request('GET', '/api/v1/invoices', tk)).status).toBe(200);   // view → read ok
    expect((await request('POST', '/api/v1/invoices', tk)).status).toBe(403);   // view → write denied
    expect((await request('POST', '/api/v1/payments/receive', tk)).status).toBe(200); // full → write ok
  });

  it('per-user override beats the template', async () => {
    const tpl = await permissionService.createTemplate(tenantId, {
      name: 'Full Clerk', permissions: { invoices: 'full' },
    }, ids['owner']!);
    await permissionService.setUserPermissions(tenantId, ids['bkRestricted']!, {
      templateId: tpl.id, overrides: { invoices: 'view' },
    }, ids['owner']!);
    const tk = tokenFor(ids['bkRestricted']!, 'bookkeeper');
    expect((await request('POST', '/api/v1/invoices', tk)).status).toBe(403);
  });

  it('permission mutations are audited', async () => {
    const tpl = await permissionService.createTemplate(tenantId, { name: 'Audited', permissions: {} }, ids['owner']!);
    await permissionService.setUserPermissions(tenantId, ids['bkRestricted']!, { templateId: tpl.id }, ids['owner']!);
    const rows = await db.select().from(auditLogTable).where(eq(auditLogTable.tenantId, tenantId));
    const entities = rows.map((r) => r.entityType);
    expect(entities).toContain('permission_template');
    expect(entities).toContain('user_permissions');
  });
});
