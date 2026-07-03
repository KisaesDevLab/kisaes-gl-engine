// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

// Route-level coverage for tenant custom detail types
// (GET/POST/DELETE /tenant-settings/detail-types) — merged list,
// validation, duplicate/builtin collisions, the in-use deletion guard,
// and tenant isolation.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import 'express-async-errors';
import express from 'express';
import http from 'http';
import type { AddressInfo, Server } from 'net';
import { eq, and, sql } from 'drizzle-orm';
import { db, pool } from '../db/index.js';
import { auditLog as auditLogTable, accounts } from '../db/schema/index.js';
import * as authService from '../services/auth.service.js';
import * as accountsService from '../services/accounts.service.js';
import { tenantSettingsRouter } from './tenant-settings.routes.js';
import { errorHandler } from '../middleware/error-handler.js';

let server: Server | null = null;
let port = 0;
let token = '';
let tenantId = '';
let otherToken = '';

async function cleanDb() {
  await db.execute(sql`TRUNCATE
    audit_log, journal_lines, transaction_tags, transactions, contacts,
    tags, tag_groups, api_keys, sessions, tenant_detail_types,
    accounts, companies, users, tenants
    CASCADE`);
}

async function startApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/tenant-settings', tenantSettingsRouter);
  app.use(errorHandler);
  return new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      port = (server!.address() as AddressInfo).port;
      resolve();
    });
  });
}

function req(method: string, path: string, body?: unknown, authToken?: string): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const r = http.request({
      method, hostname: '127.0.0.1', port, path: `/api/v1/tenant-settings${path}`,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken ?? token}`,
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode!, json: data ? JSON.parse(data) : null }); }
        catch { resolve({ status: res.statusCode!, json: data }); }
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

beforeAll(async () => {
  await cleanDb();
  await startApp();
  const result = await authService.register({
    email: `dt-test-${Date.now()}@example.com`,
    password: 'password123456',
    displayName: 'Detail Types Test',
    companyName: 'DT Test Co',
  });
  token = result.tokens.accessToken;
  tenantId = result.user.tenantId;

  const other = await authService.register({
    email: `dt-other-${Date.now()}@example.com`,
    password: 'password123456',
    displayName: 'Other Tenant',
    companyName: 'Other Co',
  });
  otherToken = other.tokens.accessToken;
}, 30000);

afterAll(async () => {
  await new Promise<void>((r) => server?.close(() => r()));
  await cleanDb();
  await pool.end();
});

describe('custom detail types', () => {
  it('GET returns merged builtin lists per account type', async () => {
    const r = await req('GET', '/detail-types');
    expect(r.status).toBe(200);
    expect(r.json.custom).toEqual([]);
    const expense = r.json.detailTypes.expense;
    expect(expense.some((o: any) => o.value === 'advertising' && o.isCustom === false)).toBe(true);
    const asset = r.json.detailTypes.asset;
    expect(asset.some((o: any) => o.value === 'accounts_receivable' && o.label === 'Accounts Receivable')).toBe(true);
  });

  it('POST creates a custom detail type, merged list includes it, audit logged', async () => {
    const r = await req('POST', '/detail-types', {
      accountType: 'expense', value: 'equipment_leases', label: 'Equipment Leases',
    });
    expect(r.status).toBe(201);
    expect(r.json.value).toBe('equipment_leases');
    expect(r.json.tenantId).toBe(tenantId);

    const list = await req('GET', '/detail-types');
    const custom = list.json.detailTypes.expense.find((o: any) => o.value === 'equipment_leases');
    expect(custom).toBeDefined();
    expect(custom.isCustom).toBe(true);
    expect(custom.label).toBe('Equipment Leases');

    const audits = await db.select().from(auditLogTable)
      .where(and(eq(auditLogTable.tenantId, tenantId), eq(auditLogTable.entityType, 'detail_type')));
    expect(audits.length).toBeGreaterThanOrEqual(1);
    expect(audits[0]!.action).toBe('create');
  });

  it('rejects an invalid slug (zod) and a builtin collision (409)', async () => {
    const bad = await req('POST', '/detail-types', {
      accountType: 'expense', value: 'Not A Slug!', label: 'Bad',
    });
    expect(bad.status).toBe(400);

    const builtin = await req('POST', '/detail-types', {
      accountType: 'expense', value: 'advertising', label: 'Advertising Again',
    });
    expect(builtin.status).toBe(409);
  });

  it('rejects a duplicate custom value for the same account type (409)', async () => {
    const dup = await req('POST', '/detail-types', {
      accountType: 'expense', value: 'equipment_leases', label: 'Duplicate',
    });
    expect(dup.status).toBe(409);
    // …but the same slug under a different account type is fine.
    const otherType = await req('POST', '/detail-types', {
      accountType: 'other_expense', value: 'equipment_leases', label: 'Equipment Leases (Other)',
    });
    expect(otherType.status).toBe(201);
    await req('DELETE', `/detail-types/${otherType.json.id}`);
  });

  it('refuses to delete a detail type in use by an account, allows it once freed', async () => {
    const created = await req('POST', '/detail-types', {
      accountType: 'expense', value: 'drone_maintenance', label: 'Drone Maintenance',
    });
    expect(created.status).toBe(201);

    const account = await accountsService.create(tenantId, {
      name: 'Drone Upkeep', accountNumber: '6666',
      accountType: 'expense' as never, detailType: 'drone_maintenance',
    });

    const blocked = await req('DELETE', `/detail-types/${created.json.id}`);
    expect(blocked.status).toBe(409);
    expect(blocked.json.error.code).toBe('DETAIL_TYPE_IN_USE');

    // Free the slug and retry.
    await db.update(accounts).set({ detailType: null }).where(eq(accounts.id, account.id));
    const ok = await req('DELETE', `/detail-types/${created.json.id}`);
    expect(ok.status).toBe(204);

    const list = await req('GET', '/detail-types');
    expect(list.json.detailTypes.expense.some((o: any) => o.value === 'drone_maintenance')).toBe(false);
  });

  it('is tenant-isolated: other tenants cannot see or delete custom types', async () => {
    const mine = await req('POST', '/detail-types', {
      accountType: 'revenue', value: 'consulting_income', label: 'Consulting Income',
    });
    expect(mine.status).toBe(201);

    const otherList = await req('GET', '/detail-types', undefined, otherToken);
    expect(otherList.json.detailTypes.revenue.some((o: any) => o.value === 'consulting_income')).toBe(false);

    const otherDelete = await req('DELETE', `/detail-types/${mine.json.id}`, undefined, otherToken);
    expect(otherDelete.status).toBe(404);

    // Still present for the owning tenant.
    const myList = await req('GET', '/detail-types');
    expect(myList.json.detailTypes.revenue.some((o: any) => o.value === 'consulting_income')).toBe(true);
  });
});
