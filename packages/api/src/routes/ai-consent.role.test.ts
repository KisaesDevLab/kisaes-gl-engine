// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

// M14: accepting / revoking / re-scoping a company's AI disclosure is a binding
// data-sharing decision and must be owner-only. A non-owner tenant member gets
// 403; the owner passes the role gate (and only then hits downstream logic).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'express-async-errors';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import jwt from 'jsonwebtoken';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { tenants, users, sessions, companies, accounts, aiConfig } from '../db/schema/index.js';
import * as authService from '../services/auth.service.js';
import { aiRouter } from './ai.routes.js';
import { errorHandler } from '../middleware/error-handler.js';

let server: Server | null = null;
let port = 0;
let tenantId = '';
let companyId = '';
let ownerId = '';
let bookkeeperId = '';

function tokenFor(userId: string, role: string) {
  return jwt.sign({ userId, tenantId, role, isSuperAdmin: false }, process.env['JWT_SECRET']!, { expiresIn: '5m' });
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
    req.end('{}');
  });
}

async function cleanDb() {
  await db.delete(aiConfig);
  await db.delete(accounts);
  await db.delete(companies);
  await db.delete(sessions);
  await db.delete(users);
  await db.delete(tenants);
}

beforeEach(async () => {
  await cleanDb();
  const { user } = await authService.register({
    email: `owner-${Date.now()}@example.com`,
    password: 'password123',
    displayName: 'Owner',
    companyName: 'Role Co',
  });
  tenantId = user.tenantId;
  ownerId = user.id;
  const company = await db.query.companies.findFirst({ where: eq(companies.tenantId, tenantId) });
  companyId = company!.id;
  const [bk] = await db.insert(users).values({
    tenantId, email: `bk-${Date.now()}@example.com`, passwordHash: 'x',
    displayName: 'Bookkeeper', role: 'bookkeeper', isActive: true,
  }).returning();
  bookkeeperId = bk!.id;

  const app = express();
  app.use(express.json());
  app.use('/api/v1/ai', aiRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => { port = (server!.address() as AddressInfo).port; resolve(); });
  });
});

afterEach(async () => {
  if (server) { await new Promise<void>((r) => server!.close(() => r())); server = null; }
  await cleanDb();
});

describe('AI consent endpoints — owner-only (M14)', () => {
  it('non-owner (bookkeeper) gets 403 on accept', async () => {
    const res = await request('POST', `/api/v1/ai/consent/${companyId}/accept`, tokenFor(bookkeeperId, 'bookkeeper'));
    expect(res.status).toBe(403);
  });

  it('non-owner (bookkeeper) gets 403 on revoke', async () => {
    const res = await request('POST', `/api/v1/ai/consent/${companyId}/revoke`, tokenFor(bookkeeperId, 'bookkeeper'));
    expect(res.status).toBe(403);
  });

  it('owner passes the role gate (not 403)', async () => {
    // Owner clears requireOwner; the request then fails downstream because AI
    // isn't enabled system-wide — a 400, NOT the 403 the gate would produce.
    const res = await request('POST', `/api/v1/ai/consent/${companyId}/accept`, tokenFor(ownerId, 'owner'));
    expect(res.status).not.toBe(403);
    expect(res.status).toBe(400);
  });
});
