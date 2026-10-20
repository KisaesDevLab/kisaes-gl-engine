// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// POST /practice/conditional-rules/evaluate (U-51, rules-evaluate-v1): what
// the active rules would set for one entry. Match / no match, the payee
// name and amount feeding the context, read-only (no fire recorded),
// tenant isolation (another tenant's rules, bank account and contact), and
// the same feature-flag gate as the rest of the router.

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
  tenants, users, accounts, contacts, conditionalRules, conditionalRuleAudit, tenantFeatureFlags, auditLog,
} from '../db/schema/index.js';
import { conditionalRulesRouter } from './conditional-rules.routes.js';
import { errorHandler } from '../middleware/error-handler.js';
import * as accountsService from '../services/accounts.service.js';

const URL = '/api/v1/practice/conditional-rules/evaluate';

let server: Server | null = null;
let port = 0;

interface Seeded { tenantId: string; userId: string; token: string; bankId: string; suppliesId: string; contactId: string }
let a: Seeded;
let b: Seeded;

function call(body: unknown, token: string): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request({
      hostname: '127.0.0.1', port, path: URL, method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'Content-Length': String(data.length) },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json: any = null;
        try { json = raw ? JSON.parse(raw) : null; } catch { json = raw; }
        resolve({ status: res.statusCode ?? 0, json });
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function seedTenant(label: string): Promise<Seeded> {
  const [t] = await db.insert(tenants).values({
    name: `Eval ${label}`, slug: `eval-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
  }).returning();
  const tenantId = t!.id;
  await db.insert(tenantFeatureFlags).values({ tenantId, flagKey: 'CONDITIONAL_RULES_V1', enabled: true });
  const [u] = await db.insert(users).values({
    tenantId, email: `eval-${label}-${Date.now()}-${Math.random()}@example.com`,
    passwordHash: 'x', role: 'owner', displayName: 'Owner',
  }).returning();
  const token = jwt.sign({ userId: u!.id, tenantId, role: 'owner', isSuperAdmin: false }, process.env['JWT_SECRET']!, { expiresIn: '5m' });
  const bankId = (await accountsService.create(tenantId, { name: 'Checking', accountType: 'asset', detailType: 'bank', accountNumber: '1010' })).id;
  const suppliesId = (await accountsService.create(tenantId, { name: 'Supplies', accountType: 'expense', accountNumber: '6000' })).id;
  const [c] = await db.insert(contacts).values({ tenantId, contactType: 'vendor', displayName: 'Cosmos Granite' }).returning();
  return { tenantId, userId: u!.id, token, bankId, suppliesId, contactId: c!.id };
}

async function addRule(s: Seeded, name: string, conditions: unknown, actions: unknown, priority = 100) {
  const [r] = await db.insert(conditionalRules).values({
    tenantId: s.tenantId, ownerUserId: s.userId, name, priority, conditions, actions,
  } as typeof conditionalRules.$inferInsert).returning();
  return r!;
}

async function cleanup(s: Seeded | undefined) {
  if (!s) return;
  await db.delete(auditLog).where(eq(auditLog.tenantId, s.tenantId));
  await db.delete(conditionalRuleAudit).where(eq(conditionalRuleAudit.tenantId, s.tenantId));
  await db.delete(conditionalRules).where(eq(conditionalRules.tenantId, s.tenantId));
  await db.delete(contacts).where(eq(contacts.tenantId, s.tenantId));
  await db.delete(accounts).where(eq(accounts.tenantId, s.tenantId));
  await db.delete(tenantFeatureFlags).where(eq(tenantFeatureFlags.tenantId, s.tenantId));
  await db.delete(users).where(eq(users.tenantId, s.tenantId));
  await db.delete(tenants).where(eq(tenants.id, s.tenantId));
}

beforeEach(async () => {
  a = await seedTenant('a');
  b = await seedTenant('b');
  const app = express();
  app.use(express.json());
  app.use('/api/v1/practice/conditional-rules', conditionalRulesRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => { port = (server!.address() as AddressInfo).port; resolve(); });
  });
});

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
  await cleanup(a);
  await cleanup(b);
});

describe('POST /conditional-rules/evaluate', () => {
  it('returns the matching rule and what it sets', async () => {
    const rule = await addRule(a, 'Amazon → supplies',
      { type: 'leaf', field: 'descriptor', operator: 'contains', value: 'amazon' },
      [
        { type: 'set_account', accountId: a.suppliesId },
        { type: 'set_vendor', vendorId: a.contactId },
      ]);
    const r = await call({ description: 'AMAZON MKTPLACE 123', amount: '-42.17', bankAccountId: a.bankId }, a.token);
    expect(r.status).toBe(200);
    expect(r.json).toEqual({
      match: { ruleId: rule.id, ruleName: 'Amazon → supplies', accountId: a.suppliesId, tagId: null, contactId: a.contactId },
    });
  });

  it('returns match null when no rule matches, or the tenant has none', async () => {
    expect((await call({ description: 'Anything', amount: '-1.00', bankAccountId: a.bankId }, a.token)).json).toEqual({ match: null });
    await addRule(a, 'Amazon', { type: 'leaf', field: 'descriptor', operator: 'contains', value: 'amazon' },
      [{ type: 'set_account', accountId: a.suppliesId }]);
    const r = await call({ description: 'Office Depot', amount: '-1.00', bankAccountId: a.bankId }, a.token);
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ match: null });
  });

  it('tests the payee name, the signed amount and the bank account like the feed pipeline', async () => {
    await addRule(a, 'Granite payee', { type: 'leaf', field: 'descriptor', operator: 'contains', value: 'cosmos granite' },
      [{ type: 'set_account', accountId: a.suppliesId }], 10);
    await addRule(a, 'Big outflow on checking', {
      type: 'group', op: 'AND', children: [
        { type: 'leaf', field: 'amount', operator: 'lt', value: -1000 },
        { type: 'leaf', field: 'account_source_id', operator: 'eq', value: a.bankId },
      ],
    }, [{ type: 'mark_for_review' }], 20);

    const byPayee = await call({ description: 'CHECK 3301', amount: '-5.00', bankAccountId: a.bankId, contactId: a.contactId }, a.token);
    expect(byPayee.json.match).toMatchObject({ ruleName: 'Granite payee', accountId: a.suppliesId });
    expect((await call({ description: 'CHECK 3301', amount: '-5.00', bankAccountId: a.bankId }, a.token)).json).toEqual({ match: null });

    const big = await call({ description: 'Wire', amount: '-1500.00', bankAccountId: a.bankId }, a.token);
    expect(big.json.match).toMatchObject({ ruleName: 'Big outflow on checking', accountId: null, tagId: null, contactId: null });
    expect((await call({ description: 'Wire', amount: '-999.99', bankAccountId: a.bankId }, a.token)).json).toEqual({ match: null });
  });

  it('is read-only: no rule fire and no audit row', async () => {
    await addRule(a, 'Amazon', { type: 'leaf', field: 'descriptor', operator: 'contains', value: 'amazon' },
      [{ type: 'set_account', accountId: a.suppliesId }]);
    const auditsBefore = (await db.select().from(auditLog).where(eq(auditLog.tenantId, a.tenantId))).length;
    const r = await call({ description: 'amazon', amount: '-3.00', bankAccountId: a.bankId }, a.token);
    expect(r.json.match).not.toBeNull();
    expect(await db.select().from(conditionalRuleAudit).where(eq(conditionalRuleAudit.tenantId, a.tenantId))).toHaveLength(0);
    expect(await db.select().from(auditLog).where(eq(auditLog.tenantId, a.tenantId))).toHaveLength(auditsBefore);
  });

  it('never sees another tenant\'s rules, bank account or contact', async () => {
    await addRule(b, 'B only', { type: 'leaf', field: 'descriptor', operator: 'contains', value: 'amazon' },
      [{ type: 'set_account', accountId: b.suppliesId }]);
    expect((await call({ description: 'amazon', amount: '-3.00', bankAccountId: a.bankId }, a.token)).json).toEqual({ match: null });

    const foreignBank = await call({ description: 'amazon', amount: '-3.00', bankAccountId: b.bankId }, a.token);
    expect(foreignBank.status).toBe(400);
    expect(foreignBank.json.error.code).toBe('VALIDATION_ERROR');

    const foreignContact = await call({ description: 'amazon', amount: '-3.00', bankAccountId: a.bankId, contactId: b.contactId }, a.token);
    expect(foreignContact.status).toBe(400);
    expect(foreignContact.json.error.code).toBe('VALIDATION_ERROR');
  });

  it('validates the body and keeps the CONDITIONAL_RULES_V1 gate', async () => {
    for (const amount of ['1e3', '1,000.00', '12.34567', 'abc']) {
      const r = await call({ description: 'x', amount, bankAccountId: a.bankId }, a.token);
      expect(r.status).toBe(400);
      expect(r.json.error.code).toBe('VALIDATION_ERROR');
    }
    await db.update(tenantFeatureFlags).set({ enabled: false }).where(eq(tenantFeatureFlags.tenantId, a.tenantId));
    expect((await call({ description: 'x', amount: '1.00', bankAccountId: a.bankId }, a.token)).status).toBe(404);
  });
});
