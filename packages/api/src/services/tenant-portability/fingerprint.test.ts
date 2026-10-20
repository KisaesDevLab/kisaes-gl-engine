// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Tenant fingerprint (fp1), trial balance by company, session settings and
// advisory locks (U-05 step 32), including the read-only browse test that
// seeds VOLATILE_COLUMNS: GETs of the main screens and a switch-tenant must
// not move a company's fingerprint.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import jwt from 'jsonwebtoken';
import { eq, sql } from 'drizzle-orm';
import { db, pool } from '../../db/index.js';
import { tenants, users, userTenantAccess, companies, accounts, contacts, transactions, journalLines, attachments } from '../../db/schema/index.js';
import { env } from '../../config/env.js';
import { buildPortabilityPlan, type PortabilityPlan } from './plan.js';
import {
  computeTenantFingerprint, computeTrialBalance, countUnbalancedTransactions, fingerprintDiff, ledgerVersionSum, TRIAL_BALANCE_DEFINITION,
} from './fingerprint.js';
import {
  ARCHIVE_SESSION, applyArchiveSession, acquireSharedTenantLock, releaseSharedTenantLock, tryExclusiveTenantLock, withArchiveConnection,
} from './session.js';
import * as authService from '../auth.service.js';

let plan: PortabilityPlan;
let tenantId = '';
let otherTenantId = '';
let userId = '';
let companyId = '';
let cashId = '';
let salesId = '';
const stamp = crypto.randomUUID().slice(0, 8);

async function fp() {
  return withArchiveConnection(async (c) => {
    await c.query('BEGIN');
    await applyArchiveSession(c);
    try {
      return await computeTenantFingerprint(c, plan, tenantId);
    } finally {
      await c.query('ROLLBACK');
    }
  });
}

beforeAll(async () => {
  plan = await buildPortabilityPlan(db);
  const [t] = await db.insert(tenants).values({ name: `FP ${stamp}`, slug: `fp-${stamp}` }).returning();
  const [o] = await db.insert(tenants).values({ name: `FP other ${stamp}`, slug: `fpo-${stamp}` }).returning();
  tenantId = t!.id;
  otherTenantId = o!.id;
  const [u] = await db.insert(users).values({ tenantId, email: `fp-${stamp}@example.test`, passwordHash: 'x', displayName: 'FP', role: 'owner', isSuperAdmin: true }).returning();
  userId = u!.id;
  await db.insert(userTenantAccess).values([{ userId, tenantId, role: 'owner' }, { userId, tenantId: otherTenantId, role: 'owner' }]);
  const [co] = await db.insert(companies).values({ tenantId, businessName: 'FP Co', entityType: 'llc', setupComplete: true }).returning();
  companyId = co!.id;
  const [cash] = await db.insert(accounts).values({ tenantId, companyId, name: 'Cash', accountType: 'asset', accountNumber: `1${stamp.slice(0, 3)}` }).returning();
  const [sales] = await db.insert(accounts).values({ tenantId, companyId, name: 'Sales', accountType: 'income', accountNumber: `4${stamp.slice(0, 3)}` }).returning();
  cashId = cash!.id;
  salesId = sales!.id;
  const [txn] = await db.insert(transactions).values({ tenantId, companyId, txnType: 'journal', txnDate: '2026-01-15', status: 'posted' }).returning();
  await db.insert(journalLines).values([
    { tenantId, transactionId: txn!.id, accountId: cashId, companyId, debit: '999999999999999.9999', credit: '0' },
    { tenantId, transactionId: txn!.id, accountId: salesId, companyId, debit: '0', credit: '999999999999999.9999' },
  ]);
  const [draft] = await db.insert(transactions).values({ tenantId, companyId, txnType: 'journal', txnDate: '2026-01-16', status: 'draft' }).returning();
  await db.insert(journalLines).values([{ tenantId, transactionId: draft!.id, accountId: cashId, companyId, debit: '0.0001', credit: '0' }]);
  await db.insert(attachments).values({ tenantId, companyId, fileName: 'a.txt', filePath: `/uploads/${tenantId}/attachments/a.txt`, attachableType: 'transaction', attachableId: txn!.id, fileSize: 3 });
}, 60_000);

afterAll(async () => {
  for (const id of [tenantId, otherTenantId]) {
    if (!id) continue;
    await db.execute(sql`DELETE FROM sessions WHERE tenant_id = ${id}`);
    await db.execute(sql`DELETE FROM audit_log WHERE tenant_id = ${id}`);
    await db.delete(attachments).where(eq(attachments.tenantId, id));
    await db.delete(journalLines).where(eq(journalLines.tenantId, id));
    await db.delete(transactions).where(eq(transactions.tenantId, id));
    await db.delete(accounts).where(eq(accounts.tenantId, id));
    await db.delete(companies).where(eq(companies.tenantId, id));
    await db.delete(userTenantAccess).where(eq(userTenantAccess.tenantId, id));
  }
  await db.execute(sql`DELETE FROM sessions WHERE user_id = ${userId}`);
  await db.delete(users).where(eq(users.id, userId));
  await db.delete(tenants).where(eq(tenants.id, tenantId));
  await db.delete(tenants).where(eq(tenants.id, otherTenantId));
});

describe('trial balance and counters', () => {
  it('groups by company, account, status and basis as exact text', async () => {
    const tb = await withArchiveConnection((c) => computeTrialBalance(c, tenantId));
    expect(tb.definition).toBe(TRIAL_BALANCE_DEFINITION);
    expect(tb.rows).toEqual([
      { companyId, accountId: cashId, status: 'draft', basis: 'both', debit: '0.0001', credit: '0.0000', lines: 1 },
      { companyId, accountId: cashId, status: 'posted', basis: 'both', debit: '999999999999999.9999', credit: '0.0000', lines: 1 },
      { companyId, accountId: salesId, status: 'posted', basis: 'both', debit: '0.0000', credit: '999999999999999.9999', lines: 1 },
    ].sort((a, b) => a.accountId.localeCompare(b.accountId) || a.status.localeCompare(b.status)));
    expect(tb.totals).toEqual({ debit: '1000000000000000.0000', credit: '999999999999999.9999' });
    expect(await withArchiveConnection((c) => countUnbalancedTransactions(c, tenantId))).toBe(1);
    const lv = await withArchiveConnection((c) => ledgerVersionSum(c, tenantId));
    expect(Number(lv)).toBeGreaterThan(0); // the 0144 triggers stamped the inserts
  });
});

describe('fingerprint fp1', () => {
  it('covers every archived table, detects a business edit, and ignores volatile columns', async () => {
    const a = await fp();
    expect(a.algorithm).toBe('fp1');
    expect(Object.keys(a.tables).sort()).toEqual(plan.tables.map((t) => t.name).sort());
    expect(a.tables['journal_lines']).toEqual({ rows: 3, digest: expect.stringMatching(/^-?\d+:-?\d+$/) });
    expect(a.tables['contacts']!.rows).toBe(0);
    expect(a.tables['contacts']!.digest).toBe('0:0');
    expect(await fp()).toEqual(a);

    // Volatile: tenant rename, attachment cache fill, access-row touch.
    await db.update(tenants).set({ name: `FP renamed ${stamp}`, slug: `fpr-${stamp}`, updatedAt: new Date() }).where(eq(tenants.id, tenantId));
    await db.update(attachments).set({ localCachePath: '/tmp/cache/x', cacheExpiresAt: new Date() }).where(eq(attachments.tenantId, tenantId));
    await db.update(userTenantAccess).set({ lastAccessedAt: new Date() }).where(eq(userTenantAccess.tenantId, tenantId));
    expect(fingerprintDiff(a, await fp())).toEqual([]);

    // Business edits are detected, table by table.
    const [contact] = await db.insert(contacts).values({ tenantId, companyId, displayName: 'Edit', contactType: 'customer' }).returning();
    const b = await fp();
    expect(fingerprintDiff(a, b)).toEqual(['contacts']);
    await db.update(accounts).set({ name: 'Cash renamed' }).where(eq(accounts.id, cashId));
    expect(fingerprintDiff(b, await fp())).toEqual(['accounts']);
    await db.update(companies).set({ lockDate: '2025-12-31' }).where(eq(companies.id, companyId));
    const c = await fp();
    expect(fingerprintDiff(b, c)).toEqual(['accounts', 'companies']);
    await db.update(attachments).set({ fileSize: 4 }).where(eq(attachments.tenantId, tenantId));
    expect(fingerprintDiff(c, await fp())).toEqual(['attachments']);
    await db.update(tenants).set({ reportSettings: { x: 1 } }).where(eq(tenants.id, tenantId));
    expect(fingerprintDiff(c, await fp())).toEqual(['attachments', 'tenantRow']);
    await db.delete(contacts).where(eq(contacts.id, contact!.id));
  });

  it('moving a journal line to another company changes the trial balance part (MT11)', async () => {
    const before = await fp();
    const [co2] = await db.insert(companies).values({ tenantId, businessName: 'FP Co 2', entityType: 'llc', setupComplete: true }).returning();
    const line = (await db.select().from(journalLines).where(eq(journalLines.tenantId, tenantId)).limit(1))[0]!;
    await db.update(journalLines).set({ companyId: co2!.id }).where(eq(journalLines.id, line.id));
    const after = await fp();
    expect(fingerprintDiff(before, after)).toEqual(['companies', 'journal_lines', 'trialBalance']);
    await db.update(journalLines).set({ companyId }).where(eq(journalLines.id, line.id));
    await db.delete(companies).where(eq(companies.id, co2!.id));
  });

  it('leaves the archive audit rows out of the fingerprint (S-e) but counts other audit rows', async () => {
    const a = await fp();
    await db.execute(sql`INSERT INTO audit_log (tenant_id, action, entity_type, entity_id, after_data) VALUES (${tenantId}, 'create', 'tenant_archive', ${crypto.randomUUID()}, '{"archiveId":"x"}')`);
    expect(fingerprintDiff(a, await fp())).toEqual([]);
    await db.execute(sql`INSERT INTO audit_log (tenant_id, action, entity_type) VALUES (${tenantId}, 'update', 'account')`);
    expect(fingerprintDiff(a, await fp())).toEqual(['audit_log']);
  });
});

describe('read-only browse', () => {
  it('GETs of the main screens and a switch-tenant do not move the fingerprint', async () => {
    const before = await fp();
    const { app } = await import('../../app.js');
    const server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    const token = jwt.sign({ userId, tenantId, role: 'owner', isSuperAdmin: true }, env.JWT_SECRET, { expiresIn: '5m' });
    const paths = [
      '/api/v1/auth/me',
      '/api/v1/company',
      '/api/v1/accounts',
      '/api/v1/contacts',
      '/api/v1/transactions?limit=20',
      `/api/v1/transactions?companyId=${companyId}&limit=20`,
      '/api/v1/attachments?limit=20',
      '/api/v1/reports/trial-balance?startDate=2026-01-01&endDate=2026-12-31',
      '/api/v1/reports/profit-loss?startDate=2026-01-01&endDate=2026-12-31',
      '/api/v1/reports/balance-sheet?asOfDate=2026-12-31',
    ];
    try {
      for (const p of paths) {
        const r = await fetch(`http://127.0.0.1:${port}${p}`, { headers: { authorization: `Bearer ${token}` } });
        expect(r.status, p).toBeLessThan(500);
        await r.text();
      }
    } finally {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
    await authService.switchTenant(userId, otherTenantId);
    await authService.switchTenant(userId, tenantId);
    expect(fingerprintDiff(before, await fp())).toEqual([]);
  }, 120_000);
});

describe('session settings and advisory locks', () => {
  it('applies ARCHIVE_SESSION and renders row_to_json deterministically', async () => {
    await withArchiveConnection(async (c) => {
      await c.query('BEGIN');
      await applyArchiveSession(c);
      for (const [name, value] of ARCHIVE_SESSION) {
        const r = await c.query(`SHOW ${name}`);
        expect(String(Object.values(r.rows[0] as Record<string, string>)[0]).toLowerCase()).toBe(value.toLowerCase());
      }
      const r = await c.query(`SELECT row_to_json(x)::text AS j FROM (SELECT '2026-01-02T03:04:05.123456Z'::timestamptz AS ts, '\\x01ff'::bytea AS b, 1.5::float8 AS f, 12.3400::numeric(19,4) AS n) x`);
      expect((r.rows[0] as { j: string }).j).toBe('{"ts":"2026-01-02T03:04:05.123456+00:00","b":"\\\\x01ff","f":1.5,"n":12.3400}');
      await c.query('ROLLBACK');
    });
  });

  it('shared locks coexist and block an exclusive lock; exclusive is released with the transaction', async () => {
    const a = await pool.connect();
    const b = await pool.connect();
    try {
      await acquireSharedTenantLock(a, tenantId);
      await acquireSharedTenantLock(b, tenantId);
      await b.query('BEGIN');
      expect(await tryExclusiveTenantLock(b, tenantId)).toBe(false);
      await b.query('ROLLBACK');
      await releaseSharedTenantLock(a, tenantId);
      await releaseSharedTenantLock(b, tenantId);
      await b.query('BEGIN');
      expect(await tryExclusiveTenantLock(b, tenantId)).toBe(true);
      // Another tenant's lock is independent.
      await a.query('BEGIN');
      expect(await tryExclusiveTenantLock(a, otherTenantId)).toBe(true);
      await a.query('ROLLBACK');
      await b.query('ROLLBACK');
      await a.query('BEGIN');
      expect(await tryExclusiveTenantLock(a, tenantId)).toBe(true);
      await a.query('ROLLBACK');
    } finally {
      a.release();
      b.release();
    }
  });
});
