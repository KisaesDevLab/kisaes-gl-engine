// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// GET /ai/usage/summary is a settings concern: it needs the same right
// that edits company settings (company_settings: full). Owners have it;
// read-only users and a bookkeeper whose right was removed get 403
// PERMISSION_DENIED (review low, PR #152).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import 'express-async-errors';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import jwt from 'jsonwebtoken';
import { eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { tenants, users, companies, userPermissions } from '../db/schema/index.js';
import { setUserPermissions } from '../services/permission.service.js';
import { aiRouter } from './ai.routes.js';
import { errorHandler } from '../middleware/error-handler.js';

let server: http.Server;
let port = 0;
let tenantId = '';
const tokens: Record<string, string> = {};
const SLUG = `ai-usage-role-${Date.now()}`;

const ids: Record<string, string> = {};

async function seedUser(role: string, label = role): Promise<string> {
  const [u] = await db.insert(users).values({
    tenantId, email: `${label}-${SLUG}@example.com`, passwordHash: 'x', displayName: label, role,
  }).returning();
  ids[label] = u!.id;
  return jwt.sign({ userId: u!.id, tenantId, role, isSuperAdmin: false }, process.env['JWT_SECRET']!, { expiresIn: '5m' });
}

beforeAll(async () => {
  const [t] = await db.insert(tenants).values({ name: 'AI usage role', slug: SLUG }).returning();
  tenantId = t!.id;
  await db.insert(companies).values({ tenantId, businessName: 'Usage Co' });
  for (const role of ['owner', 'bookkeeper', 'readonly']) tokens[role] = await seedUser(role);
  tokens['limited'] = await seedUser('bookkeeper', 'limited');
  await setUserPermissions(tenantId, ids['limited']!, { templateId: null, overrides: { company_settings: 'none' } });
  const app = express();
  app.use(express.json());
  app.use('/api/v1/ai', aiRouter);
  app.use(errorHandler);
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await db.delete(companies).where(eq(companies.tenantId, tenantId));
  await db.delete(userPermissions).where(eq(userPermissions.tenantId, tenantId));
  await db.execute(sql`DELETE FROM audit_log WHERE tenant_id = ${tenantId}`);
  await db.delete(users).where(eq(users.tenantId, tenantId));
  await db.delete(tenants).where(eq(tenants.id, tenantId));
});

async function get(role: string): Promise<{ status: number; json: any }> {
  const r = await fetch(`http://127.0.0.1:${port}/api/v1/ai/usage/summary`, { headers: { authorization: `Bearer ${tokens[role]}` } });
  return { status: r.status, json: await r.json() };
}

describe('GET /ai/usage/summary role check', () => {
  it.each(['owner', 'bookkeeper'])('answers a %s holding the company-settings right', async (role) => {
    const r = await get(role);
    expect(r.status).toBe(200);
    expect(r.json.totals).toEqual({ calls: 0, inputTokens: 0, outputTokens: 0 });
  });

  it.each(['readonly', 'limited'])('refuses %s with 403 PERMISSION_DENIED', async (role) => {
    const r = await get(role);
    expect(r.status).toBe(403);
    expect(r.json.error.code).toBe('PERMISSION_DENIED');
  });
});
