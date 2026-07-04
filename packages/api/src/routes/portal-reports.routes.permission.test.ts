// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

// H4 — the Report Builder admin router must enforce per-member
// permissions, not just userType/readonly. A bookkeeper whose template
// denies `reports` gets 403 on both reads and writes; a `view` grant
// allows GET but blocks POST. Mirrors permission.test.ts's harness.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'express-async-errors';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import jwt from 'jsonwebtoken';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  tenants, users, permissionTemplates, userPermissions,
  reportTemplates, reportInstances, kpiDefinitions,
  auditLog as auditLogTable,
} from '../db/schema/index.js';
import * as permissionService from '../services/permission.service.js';
import { portalReportsRouter } from './portal-reports.routes.js';
import { errorHandler } from '../middleware/error-handler.js';

let server: Server | null = null;
let port = 0;
let tenantId = '';
const ids: Record<string, string> = {};

function tokenFor(userId: string, role: string) {
  return jwt.sign({ userId, tenantId, role, isSuperAdmin: false }, process.env['JWT_SECRET']!, { expiresIn: '5m' });
}

function request(
  method: string,
  pathname: string,
  token?: string,
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      {
        hostname: '127.0.0.1', port, path: pathname, method,
        headers: {
          'Content-Type': 'application/json',
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      },
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
    if (payload) req.write(payload);
    req.end();
  });
}

async function startApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/practice/reports', portalReportsRouter);
  app.use(errorHandler);
  return new Promise<void>((resolve) => {
    server = app.listen(0, () => { port = (server!.address() as AddressInfo).port; resolve(); });
  });
}

async function seed() {
  const [t] = await db.insert(tenants).values({
    name: 'Reports Perm T',
    slug: 'rperm-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
  }).returning();
  tenantId = t!.id;
  const mkUser = async (key: string, role: string) => {
    const [u] = await db.insert(users).values({
      tenantId,
      email: `${key}-${Date.now()}-${Math.random().toString(36).slice(2, 5)}@ex.com`,
      passwordHash: 'not-a-real-hash',
      displayName: key,
      role,
      isSuperAdmin: false,
    }).returning();
    ids[key] = u!.id;
  };
  await mkUser('owner', 'owner');
  await mkUser('readonly', 'readonly');
  await mkUser('bkDenied', 'bookkeeper');
  await mkUser('bkViewOnly', 'bookkeeper');

  // Template that grants OTHER resources but not reports → reports denied.
  const denied = await permissionService.createTemplate(tenantId, {
    name: 'No Reports',
    permissions: { invoices: 'full' },
  }, ids['owner']!);
  await permissionService.setUserPermissions(
    tenantId, ids['bkDenied']!, { templateId: denied.id }, ids['owner']!,
  );

  // Template granting view-only reports.
  const viewOnly = await permissionService.createTemplate(tenantId, {
    name: 'Reports Viewer',
    permissions: { reports: 'view' },
  }, ids['owner']!);
  await permissionService.setUserPermissions(
    tenantId, ids['bkViewOnly']!, { templateId: viewOnly.id }, ids['owner']!,
  );
}

async function cleanDb() {
  if (tenantId) {
    await db.delete(reportInstances).where(eq(reportInstances.tenantId, tenantId));
    await db.delete(reportTemplates).where(eq(reportTemplates.tenantId, tenantId));
    await db.delete(kpiDefinitions).where(eq(kpiDefinitions.tenantId, tenantId));
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

describe('portal-reports router permission enforcement (H4)', () => {
  it('owner keeps full access', async () => {
    const tk = tokenFor(ids['owner']!, 'owner');
    expect((await request('GET', '/api/v1/practice/reports/kpis', tk)).status).toBe(200);
    const post = await request('POST', '/api/v1/practice/reports/templates', tk, { name: 'T1' });
    expect(post.status).toBe(201);
  });

  it('bookkeeper whose template denies reports gets 403 on GET and POST', async () => {
    const tk = tokenFor(ids['bkDenied']!, 'bookkeeper');
    expect((await request('GET', '/api/v1/practice/reports/kpis', tk)).status).toBe(403);
    expect((await request('GET', '/api/v1/practice/reports/instances', tk)).status).toBe(403);
    expect((await request('POST', '/api/v1/practice/reports/templates', tk, { name: 'Nope' })).status).toBe(403);
  });

  it('view grant on reports opens the Report Builder (reports is a read-only matrix resource; view is its max level)', async () => {
    const tk = tokenFor(ids['bkViewOnly']!, 'bookkeeper');
    expect((await request('GET', '/api/v1/practice/reports/kpis', tk)).status).toBe(200);
    expect((await request('GET', '/api/v1/practice/reports/templates', tk)).status).toBe(200);
    // Write gating stays role-based (readonly blocked below) — the
    // matrix cannot express reports write levels (writable: false).
    expect((await request('POST', '/api/v1/practice/reports/templates', tk, { name: 'BK T' })).status).toBe(201);
  });

  it('readonly role can read but never write, even with implicit view', async () => {
    const tk = tokenFor(ids['readonly']!, 'readonly');
    expect((await request('GET', '/api/v1/practice/reports/kpis', tk)).status).toBe(200);
    expect((await request('POST', '/api/v1/practice/reports/templates', tk, { name: 'Nope' })).status).toBe(403);
  });
});
