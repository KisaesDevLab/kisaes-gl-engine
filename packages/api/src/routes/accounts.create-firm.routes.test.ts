// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// POST /accounts (Quick Add Account) is open to members of the firm
// assigned to the tenant regardless of role; every other accounts
// mutation still needs the Chart of Accounts write permission.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'express-async-errors';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import { tenants, users, accounts, firms, firmUsers, tenantFirmAssignments, auditLog as auditLogTable } from '../db/schema/index.js';
import { accountsRouter } from './accounts.routes.js';
import { errorHandler } from '../middleware/error-handler.js';

let server: Server | null = null;
let port = 0;
let tenantId = '';
let firmId = '';

function request(method: string, path: string, body: unknown, token: string): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : undefined;
    const req = http.request({
      hostname: '127.0.0.1', port, path, method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...(data ? { 'Content-Length': String(data.length) } : {}),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode ?? 0, json: raw ? JSON.parse(raw) : null });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function seedUser(role: string) {
  const [u] = await db.insert(users).values({
    tenantId,
    email: `${role}-${Date.now()}-${Math.random()}@example.com`,
    passwordHash: await bcrypt.hash('secret-123-456', 12),
    role,
    displayName: role,
  }).returning();
  const token = jwt.sign({ userId: u!.id, tenantId, role, isSuperAdmin: false }, process.env['JWT_SECRET']!, { expiresIn: '5m' });
  return { id: u!.id, token };
}

beforeEach(async () => {
  const [t] = await db.insert(tenants).values({ name: 'QA Acct', slug: 'qa-acct-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6) }).returning();
  tenantId = t!.id;
  const [f] = await db.insert(firms).values({ name: 'QA Firm', slug: 'qa-firm-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6) }).returning();
  firmId = f!.id;
  await db.insert(tenantFirmAssignments).values({ tenantId, firmId });
  const app = express();
  app.use(express.json());
  app.use('/api/v1/accounts', accountsRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => { port = (server!.address() as AddressInfo).port; resolve(); });
  });
});

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
  await db.delete(auditLogTable).where(eq(auditLogTable.tenantId, tenantId));
  await db.delete(accounts).where(eq(accounts.tenantId, tenantId));
  await db.delete(firmUsers).where(eq(firmUsers.firmId, firmId));
  await db.delete(tenantFirmAssignments).where(eq(tenantFirmAssignments.firmId, firmId));
  await db.delete(firms).where(inArray(firms.id, [firmId]));
  await db.delete(users).where(eq(users.tenantId, tenantId));
  await db.delete(tenants).where(eq(tenants.id, tenantId));
});

const NEW_ACCOUNT = { name: 'Feed - Alfalfa', accountNumber: '61191', accountType: 'expense' };

describe('POST /accounts — firm quick add', () => {
  it('lets a firm member create an account even with a readonly role', async () => {
    const member = await seedUser('readonly');
    await db.insert(firmUsers).values({ firmId, userId: member.id, firmRole: 'firm_readonly' });
    const res = await request('POST', '/api/v1/accounts', NEW_ACCOUNT, member.token);
    expect(res.status).toBe(201);
    expect(res.json.account.name).toBe('Feed - Alfalfa');

    // Only creation is opened up — editing still needs the permission.
    const edit = await request('PUT', `/api/v1/accounts/${res.json.account.id}`, { name: 'Renamed' }, member.token);
    expect(edit.status).toBe(403);
  });

  it('rejects a readonly user who is not a member of the assigned firm', async () => {
    const outsider = await seedUser('readonly');
    const res = await request('POST', '/api/v1/accounts', NEW_ACCOUNT, outsider.token);
    expect(res.status).toBe(403);
  });

  it('rejects an inactive firm membership', async () => {
    const member = await seedUser('readonly');
    await db.insert(firmUsers).values({ firmId, userId: member.id, firmRole: 'firm_staff', isActive: false });
    const res = await request('POST', '/api/v1/accounts', NEW_ACCOUNT, member.token);
    expect(res.status).toBe(403);
  });

  it('still lets an owner create without any firm membership', async () => {
    const owner = await seedUser('owner');
    const res = await request('POST', '/api/v1/accounts', NEW_ACCOUNT, owner.token);
    expect(res.status).toBe(201);
  });
});
