// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.
//
// U-197: every bank detail type (BANK_DETAIL_TYPES: bank, checking, savings,
// cash, petty_cash), not only the umbrella 'bank', in
//   - the dashboard's stale-reconciliation list (GET /dashboard/action-items);
//   - the admin Plaid mapping picker (GET /admin/plaid/tenant-accounts).

import 'express-async-errors';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import jwt from 'jsonwebtoken';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { accounts, users } from '../db/schema/index.js';
import { adminRouter } from './admin.routes.js';
import { errorHandler } from '../middleware/error-handler.js';
import * as dashboardService from '../services/dashboard.service.js';
import { BANK_DETAIL_TYPES } from '../services/bank-account-types.js';
import { makeCompany, cleanTenant, type Co } from '../services/templates/templates.test-helpers.js';

let server: Server | null = null;
let port = 0;
let adminToken = '';
const tenantIds: string[] = [];
let c: Co;
const ids: Record<string, string> = {};

function get(pathname: string): Promise<{ status: number; json: ReturnType<typeof JSON.parse> }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port, path: pathname, method: 'GET',
      headers: { Authorization: `Bearer ${adminToken}` },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (ch) => chunks.push(ch));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        try { resolve({ status: res.statusCode ?? 0, json: raw ? JSON.parse(raw) : null }); }
        catch { resolve({ status: res.statusCode ?? 0, json: raw }); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

beforeAll(async () => {
  c = await makeCompany('u197', tenantIds);
  const add = async (key: string, values: Partial<typeof accounts.$inferInsert>) => {
    const [a] = await db.insert(accounts).values({
      tenantId: c.tenantId, companyId: c.companyId, name: `U197 ${key}`, accountType: 'asset', ...values,
    }).returning();
    ids[key] = a!.id;
  };
  await add('checking', { detailType: 'checking' });
  await add('savings', { detailType: 'savings' });
  await add('cash', { detailType: 'cash' });
  await add('petty_cash', { detailType: 'petty_cash' });
  await add('inactive', { detailType: 'checking', isActive: false });
  await add('receivable', { detailType: 'accounts_receivable' });
  await add('liabilityChecking', { accountType: 'liability', detailType: 'checking' });

  await db.update(users).set({ isSuperAdmin: true }).where(eq(users.id, c.userId));
  adminToken = jwt.sign(
    { userId: c.userId, tenantId: c.tenantId, role: 'owner', isSuperAdmin: true },
    process.env['JWT_SECRET']!,
    { expiresIn: '5m' },
  );

  const app = express();
  app.use(express.json());
  app.use('/api/admin', adminRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => { port = (server!.address() as AddressInfo).port; resolve(); });
  });
}, 60_000);

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  while (tenantIds.length) await cleanTenant(tenantIds.pop()!);
});

describe('bank detail types (U-197)', () => {
  it('stale reconciliations list every active asset bank account of any bank detail type', async () => {
    const items = await dashboardService.getActionItems(c.tenantId, c.companyId, { asOf: '2026-03-15' });
    const names = new Set(items.staleReconciliations.map((r) => r.accountName));
    for (const key of ['checking', 'savings', 'cash', 'petty_cash']) expect(names.has(`U197 ${key}`)).toBe(true);
    // The umbrella 'bank' accounts are still there.
    const [bank] = await db.select({ name: accounts.name }).from(accounts).where(eq(accounts.id, c.bank));
    expect(names.has(bank!.name)).toBe(true);
    // Inactive, non-bank and non-asset accounts are not.
    expect(names.has('U197 inactive')).toBe(false);
    expect(names.has('U197 receivable')).toBe(false);
    expect(names.has('U197 liabilityChecking')).toBe(false);
  });

  it('the admin Plaid mapping picker offers every bank detail type', async () => {
    const r = await get(`/api/admin/plaid/tenant-accounts?tenantId=${c.tenantId}`);
    expect(r.status).toBe(200);
    const listed = new Set((r.json.accounts as Array<{ id: string; detailType: string }>).map((a) => a.id));
    for (const key of ['checking', 'savings', 'cash', 'petty_cash']) expect(listed.has(ids[key]!)).toBe(true);
    expect(listed.has(c.bank)).toBe(true);
    expect(listed.has(ids['inactive']!)).toBe(false);
    expect(listed.has(ids['receivable']!)).toBe(false);
    for (const a of r.json.accounts as Array<{ detailType: string }>) {
      expect([...BANK_DETAIL_TYPES, 'credit_card', 'other_current_asset', 'other_current_liability']).toContain(a.detailType);
    }
  });
});
