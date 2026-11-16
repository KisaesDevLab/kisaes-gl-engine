// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

// Test-only harness for sensitive accounts (U-33): one tenant with an owner
// (sees everything) and a legacy bookkeeper with no permission row (full
// access except `sensitive_accounts`), served by the REAL app so the viewer
// store in `authenticate` and the reports refusal table run as in
// production. Not imported by any production module.

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';
import jwt from 'jsonwebtoken';
import { eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { tenants, users } from '../db/schema/index.js';
import { createCompanyForTenant } from '../services/company.service.js';
import * as accountsService from '../services/accounts.service.js';

export type Who = 'owner' | 'bk';

export interface CallResult {
  status: number;
  text: string;
  json: any;
}

export interface SensitiveHarness {
  tenantId: string;
  companyId: string;
  ownerId: string;
  bookkeeperId: string;
  /** Accounts every fixture has. `wages` is marked sensitive by `markWages`. */
  acct: { bank: string; wages: string; wagesSub: string; supplies: string; sales: string; ar: string; ap: string };
  call: (who: Who, method: string, path: string, body?: unknown) => Promise<CallResult>;
  markWages: () => Promise<void>;
  close: () => Promise<void>;
}

/** Deletes every row of `tenantId` from every tenant-scoped table, then the tenant. */
export async function deleteTenant(tenantId: string): Promise<void> {
  const tables = await db.execute<{ table_name: string }>(sql`
    SELECT c.table_name FROM information_schema.columns c
    JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id' AND t.table_type = 'BASE TABLE'`);
  const names = tables.rows.map((r) => r.table_name);
  for (let pass = 0; pass < 8 && names.length > 0; pass++) {
    for (const name of [...names]) {
      try {
        await db.execute(sql`DELETE FROM ${sql.identifier(name)} WHERE tenant_id = ${tenantId}`);
        names.splice(names.indexOf(name), 1);
      } catch { /* still referenced; next pass */ }
    }
  }
  await db.delete(users).where(eq(users.tenantId, tenantId));
  await db.delete(tenants).where(eq(tenants.id, tenantId));
}

export async function startSensitiveHarness(slugPrefix: string): Promise<SensitiveHarness> {
  const slug = `${slugPrefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const [t] = await db.insert(tenants).values({ name: 'Sensitive', slug }).returning();
  const tenantId = t!.id;
  const company = (await createCompanyForTenant(tenantId, 'Sensitive Co'))!;
  const [owner] = await db.insert(users).values({
    tenantId, email: `${slug}-owner@example.com`, passwordHash: 'x', displayName: 'Owner', role: 'owner',
  }).returning();
  const [bk] = await db.insert(users).values({
    tenantId, email: `${slug}-bk@example.com`, passwordHash: 'x', displayName: 'Bookkeeper', role: 'bookkeeper',
  }).returning();
  const tokens: Record<Who, string> = {
    owner: jwt.sign({ userId: owner!.id, tenantId, role: 'owner', isSuperAdmin: false }, process.env['JWT_SECRET']!, { expiresIn: '10m' }),
    bk: jwt.sign({ userId: bk!.id, tenantId, role: 'bookkeeper', isSuperAdmin: false }, process.env['JWT_SECRET']!, { expiresIn: '10m' }),
  };

  const mk = async (name: string, accountType: string, accountNumber: string, extra: Record<string, unknown> = {}) =>
    (await accountsService.create(tenantId, { name, accountType: accountType as never, accountNumber, ...extra })).id;
  const bank = await mk('Checking', 'asset', '1010', { detailType: 'bank' });
  const ar = await mk('Accounts Receivable', 'asset', '1200');
  const ap = await mk('Accounts Payable', 'liability', '2000');
  await db.execute(sql`UPDATE accounts SET system_tag = 'accounts_receivable', is_system = true WHERE id = ${ar}`);
  await db.execute(sql`UPDATE accounts SET system_tag = 'accounts_payable', is_system = true WHERE id = ${ap}`);
  const sales = await mk('Sales', 'revenue', '4000');
  const supplies = await mk('Supplies', 'expense', '6000');
  const wages = await mk('Canary Wages', 'expense', '6999');
  const wagesSub = await mk('Canary Wages Officers', 'expense', '6998', { parentId: wages });

  const { app } = await import('../app.js');
  const server = http.createServer(app as Express);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;

  const call = (who: Who, method: string, path: string, body?: unknown) => new Promise<CallResult>((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1', port, path, method,
      headers: {
        Authorization: `Bearer ${tokens[who]}`,
        'X-Company-Id': company.id,
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json: any = null;
        try { json = text ? JSON.parse(text) : null; } catch { json = null; }
        resolve({ status: res.statusCode ?? 0, text, json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });

  return {
    tenantId,
    companyId: company.id,
    ownerId: owner!.id,
    bookkeeperId: bk!.id,
    acct: { bank, wages, wagesSub, supplies, sales, ar, ap },
    call,
    markWages: async () => {
      const r = await call('owner', 'PUT', `/api/v1/accounts/${wages}/sensitive`, { isSensitive: true });
      if (r.status !== 200) throw new Error(`markWages: ${r.status} ${r.text}`);
    },
    close: async () => {
      await new Promise<void>((r) => server.close(() => r()));
      await deleteTenant(tenantId);
    },
  };
}
