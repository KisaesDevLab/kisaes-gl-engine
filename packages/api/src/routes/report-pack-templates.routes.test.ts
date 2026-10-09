// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Report pack templates: only a super admin may save/manage templates;
// staff may list and apply them; client-type users never see them.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import 'express-async-errors';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import jwt from 'jsonwebtoken';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import { tenants, users, sessions, companies, accounts, reportPacks, reportPackItems, reportPackTemplates } from '../db/schema/index.js';
import * as authService from '../services/auth.service.js';
import { reportPacksRouter } from './report-packs.routes.js';
import { errorHandler } from '../middleware/error-handler.js';

let server: Server | null = null;
let port = 0;
let tenantId = '';
let companyId = '';
let ownerId = '';
let clientId = '';
let superAdminId = '';
const templateIds: string[] = [];

const tokenFor = (userId: string, role: string) =>
  jwt.sign({ userId, tenantId, role, isSuperAdmin: false }, process.env['JWT_SECRET']!, { expiresIn: '5m' });

function request(method: string, pathname: string, token: string, body: unknown = {}): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path: pathname, method,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-Company-Id': companyId } },
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
    req.end(method === 'GET' || method === 'DELETE' ? undefined : JSON.stringify(body));
  });
}

beforeAll(async () => {
  const { user } = await authService.register({
    email: `tpl-owner-${Date.now()}@example.com`, password: 'password123', displayName: 'Owner', companyName: 'Tpl Co',
  });
  tenantId = user.tenantId;
  ownerId = user.id;
  companyId = (await db.query.companies.findFirst({ where: eq(companies.tenantId, tenantId) }))!.id;
  const [cl] = await db.insert(users).values({
    tenantId, email: `tpl-client-${Date.now()}@example.com`, passwordHash: 'x', displayName: 'Client',
    role: 'owner', userType: 'client', isActive: true,
  }).returning();
  clientId = cl!.id;
  const [sa] = await db.insert(users).values({
    tenantId, email: `tpl-sa-${Date.now()}@example.com`, passwordHash: 'x', displayName: 'Super',
    role: 'owner', isActive: true, isSuperAdmin: true,
  }).returning();
  superAdminId = sa!.id;
  const app = express();
  app.use(express.json());
  app.use('/api/v1/reports', reportPacksRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => { server = app.listen(0, () => { port = (server!.address() as AddressInfo).port; resolve(); }); });
});

afterAll(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  if (templateIds.length) await db.delete(reportPackTemplates).where(inArray(reportPackTemplates.id, templateIds));
  const packs = await db.select({ id: reportPacks.id }).from(reportPacks).where(eq(reportPacks.tenantId, tenantId));
  if (packs.length) await db.delete(reportPackItems).where(inArray(reportPackItems.packId, packs.map((p) => p.id)));
  await db.delete(reportPacks).where(eq(reportPacks.tenantId, tenantId));
  await db.execute((await import('drizzle-orm')).sql`DELETE FROM audit_log WHERE tenant_id = ${tenantId}`);
  await db.delete(accounts).where(eq(accounts.tenantId, tenantId));
  await db.delete(companies).where(eq(companies.tenantId, tenantId));
  await db.delete(sessions).where(inArray(sessions.userId, db.select({ id: users.id }).from(users).where(eq(users.tenantId, tenantId))));
  await db.delete(users).where(eq(users.tenantId, tenantId));
  await db.delete(tenants).where(eq(tenants.id, tenantId));
});

describe('report pack template routes', () => {
  it('super admin saves; staff lists and applies; non-super-admin cannot save; clients see nothing', async () => {
    const created = await request('POST', '/api/v1/reports/packs', tokenFor(ownerId, 'owner'), {
      name: 'Close', items: [{ reportId: 'profit-loss', options: {} }],
    });
    expect(created.status).toBe(201);
    const packId = created.json.id as string;

    const denied = await request('POST', `/api/v1/reports/packs/${packId}/save-as-template`, tokenFor(ownerId, 'owner'), { name: 'X' });
    expect(denied.status).toBe(403);

    // Super admin saving a pack from this tenant.
    const saved = await request('POST', `/api/v1/reports/packs/${packId}/save-as-template`, tokenFor(superAdminId, 'owner'), { name: 'Firm Close' });
    expect(saved.status).toBe(201);
    templateIds.push(saved.json.template.id);

    const list = await request('GET', '/api/v1/reports/pack-templates', tokenFor(ownerId, 'owner'));
    expect(list.status).toBe(200);
    expect(list.json.templates.some((t: { name: string }) => t.name === 'Firm Close')).toBe(true);

    const applied = await request('POST', `/api/v1/reports/pack-templates/${saved.json.template.id}/apply`, tokenFor(ownerId, 'owner'), {});
    expect(applied.status).toBe(201);
    expect(applied.json.name).toBe('Firm Close');
    expect(applied.json.items).toHaveLength(1);

    const del = await request('DELETE', `/api/v1/reports/pack-templates/${saved.json.template.id}`, tokenFor(ownerId, 'owner'));
    expect(del.status).toBe(403);

    const clientList = await request('GET', '/api/v1/reports/pack-templates', tokenFor(clientId, 'owner'));
    expect(clientList.status).toBe(404);
  });
});
