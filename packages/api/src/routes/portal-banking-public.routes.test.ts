// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// PORTAL_BANKING_V1 — the portal banking router must enforce, in order:
// session cookie → tenant feature flag → per-contact banking_access →
// account↔company eligibility (incl. the NULL-company single-company
// rule), and the register payload must be sanitized (no memo/recon/void).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'express-async-errors';
import express from 'express';
import http from 'http';
import crypto from 'crypto';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  tenants, companies, accounts, transactions, journalLines,
  portalContacts, portalContactCompanies, portalContactSessions,
  tenantFeatureFlags,
} from '../db/schema/index.js';
import { portalBankingPublicRouter } from './portal-banking-public.routes.js';
import { errorHandler } from '../middleware/error-handler.js';

let server: Server | null = null;
let port = 0;
let tenantAId = '';
let tenantBId = '';
const ids: Record<string, string> = {};
const cookies: Record<string, string> = {};

function request(
  method: string,
  pathname: string,
  cookie?: string,
): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1', port, path: pathname, method,
        headers: {
          'Content-Type': 'application/json',
          ...(cookie ? { Cookie: `kisbooks_portal_session=${cookie}` } : {}),
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
    req.end();
  });
}

async function startApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/portal/banking', portalBankingPublicRouter);
  app.use(errorHandler);
  return new Promise<void>((resolve) => {
    server = app.listen(0, () => { port = (server!.address() as AddressInfo).port; resolve(); });
  });
}

async function mkSession(key: string, tenantId: string, contactId: string) {
  const token = crypto.randomBytes(32).toString('hex');
  await db.insert(portalContactSessions).values({
    tenantId,
    contactId,
    tokenHash: crypto.createHash('sha256').update(token).digest('hex'),
    expiresAt: new Date(Date.now() + 3600_000),
  });
  cookies[key] = token;
}

async function setFlag(tenantId: string, enabled: boolean) {
  await db
    .insert(tenantFeatureFlags)
    .values({ tenantId, flagKey: 'PORTAL_BANKING_V1', enabled, rolloutPercent: enabled ? 100 : 0 })
    .onConflictDoUpdate({
      target: [tenantFeatureFlags.tenantId, tenantFeatureFlags.flagKey],
      set: { enabled },
    });
}

async function seed() {
  const suffix = () => Date.now() + '-' + Math.random().toString(36).slice(2, 6);
  const [tA] = await db.insert(tenants).values({ name: 'Bank T A', slug: 'pbank-a-' + suffix() }).returning();
  const [tB] = await db.insert(tenants).values({ name: 'Bank T B', slug: 'pbank-b-' + suffix() }).returning();
  tenantAId = tA!.id;
  tenantBId = tB!.id;

  // Tenant A: TWO companies (multi-company) — NULL-company accounts hidden.
  const [a1] = await db.insert(companies).values({ tenantId: tenantAId, businessName: 'A One' }).returning();
  const [a2] = await db.insert(companies).values({ tenantId: tenantAId, businessName: 'A Two' }).returning();
  // Tenant B: single company — NULL-company accounts visible.
  const [b1] = await db.insert(companies).values({ tenantId: tenantBId, businessName: 'B One' }).returning();
  ids['a1'] = a1!.id; ids['a2'] = a2!.id; ids['b1'] = b1!.id;

  const mkAccount = async (key: string, v: Partial<typeof accounts.$inferInsert> & { name: string; accountType: string }) => {
    const [row] = await db.insert(accounts).values({ tenantId: tenantAId, ...v }).returning();
    ids[key] = row!.id;
  };
  await mkAccount('checkingA1', { name: 'A1 Checking', accountType: 'asset', detailType: 'bank', companyId: ids['a1'], balance: '1500.2500' });
  await mkAccount('ccA1', { name: 'A1 Card', accountType: 'liability', detailType: 'credit_card', companyId: ids['a1'], balance: '-321.0000' });
  await mkAccount('checkingA2', { name: 'A2 Checking', accountType: 'asset', detailType: 'checking', companyId: ids['a2'] });
  await mkAccount('inactiveA1', { name: 'A1 Old', accountType: 'asset', detailType: 'bank', companyId: ids['a1'], isActive: false });
  await mkAccount('expenseA1', { name: 'A1 Rent', accountType: 'expense', detailType: 'rent', companyId: ids['a1'] });
  await mkAccount('sharedNullA', { name: 'A Shared', accountType: 'asset', detailType: 'bank', companyId: null });
  const [bAcct] = await db.insert(accounts).values({
    tenantId: tenantBId, name: 'B Checking', accountType: 'asset', detailType: 'savings', companyId: null, balance: '10.0000',
  }).returning();
  ids['checkingBNull'] = bAcct!.id;

  // Transactions on checkingA1: two posted + one void.
  const today = new Date().toISOString().split('T')[0]!;
  const mkTxn = async (key: string, status: string, debit: string, credit: string, memo: string) => {
    const [txn] = await db.insert(transactions).values({
      tenantId: tenantAId, companyId: ids['a1'], txnType: 'deposit', txnDate: today, status, memo,
    }).returning();
    await db.insert(journalLines).values({
      tenantId: tenantAId, transactionId: txn!.id, accountId: ids['checkingA1']!, debit, credit,
    });
    ids[key] = txn!.id;
  };
  await mkTxn('dep1', 'posted', '100.0000', '0', 'first deposit');
  await mkTxn('dep2', 'posted', '50.0000', '0', 'second deposit');
  await mkTxn('voided', 'void', '999.0000', '0', 'voided deposit');

  // Contacts: cGranted (banking on for A1), cDenied (off).
  const mkContact = async (key: string, tenantId: string, companyId: string, bankingAccess: boolean) => {
    const [c] = await db.insert(portalContacts).values({
      tenantId, email: `${key}-${suffix()}@ex.com`, status: 'active',
    }).returning();
    await db.insert(portalContactCompanies).values({ contactId: c!.id, companyId, bankingAccess });
    ids[key] = c!.id;
    await mkSession(key, tenantId, c!.id);
  };
  await mkContact('cGranted', tenantAId, ids['a1']!, true);
  await mkContact('cDenied', tenantAId, ids['a1']!, false);
  await mkContact('cTenantB', tenantBId, ids['b1']!, true);

  await setFlag(tenantAId, true);
  await setFlag(tenantBId, true);
}

async function cleanDb() {
  for (const tenantId of [tenantAId, tenantBId]) {
    if (!tenantId) continue;
    await db.delete(journalLines).where(eq(journalLines.tenantId, tenantId));
    await db.delete(transactions).where(eq(transactions.tenantId, tenantId));
    await db.delete(portalContactSessions).where(eq(portalContactSessions.tenantId, tenantId));
    const contactRows = await db.select({ id: portalContacts.id }).from(portalContacts).where(eq(portalContacts.tenantId, tenantId));
    for (const c of contactRows) {
      await db.delete(portalContactCompanies).where(eq(portalContactCompanies.contactId, c.id));
    }
    await db.delete(portalContacts).where(eq(portalContacts.tenantId, tenantId));
    await db.delete(accounts).where(eq(accounts.tenantId, tenantId));
    await db.delete(tenantFeatureFlags).where(eq(tenantFeatureFlags.tenantId, tenantId));
    await db.delete(companies).where(eq(companies.tenantId, tenantId));
    await db.delete(tenants).where(eq(tenants.id, tenantId));
  }
  tenantAId = '';
  tenantBId = '';
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

describe('portal banking router', () => {
  it('rejects requests without a session cookie', async () => {
    const r = await request('GET', `/api/portal/banking/accounts?companyId=${ids['a1']}`);
    expect(r.status).toBe(401);
  });

  it('flag off: accounts returns featureEnabled:false, register 403', async () => {
    await setFlag(tenantAId, false);
    const list = await request('GET', `/api/portal/banking/accounts?companyId=${ids['a1']}`, cookies['cGranted']);
    expect(list.status).toBe(200);
    expect(list.json.featureEnabled).toBe(false);
    expect(list.json.accounts).toEqual([]);

    const reg = await request(
      'GET',
      `/api/portal/banking/accounts/${ids['checkingA1']}/register?companyId=${ids['a1']}`,
      cookies['cGranted'],
    );
    expect(reg.status).toBe(403);
  });

  it('permission off: 403 BANKING_NOT_ENABLED on both endpoints', async () => {
    const list = await request('GET', `/api/portal/banking/accounts?companyId=${ids['a1']}`, cookies['cDenied']);
    expect(list.status).toBe(403);
    const reg = await request(
      'GET',
      `/api/portal/banking/accounts/${ids['checkingA1']}/register?companyId=${ids['a1']}`,
      cookies['cDenied'],
    );
    expect(reg.status).toBe(403);
  });

  it('lists only eligible accounts for the linked company, CC sign-adjusted', async () => {
    const r = await request('GET', `/api/portal/banking/accounts?companyId=${ids['a1']}`, cookies['cGranted']);
    expect(r.status).toBe(200);
    expect(r.json.featureEnabled).toBe(true);
    const byId = new Map(r.json.accounts.map((a: any) => [a.id, a]));
    expect(byId.has(ids['checkingA1'])).toBe(true);
    expect(byId.has(ids['ccA1'])).toBe(true);
    // Excluded: other company, inactive, non-bank, NULL-company (multi-company tenant).
    expect(byId.has(ids['checkingA2'])).toBe(false);
    expect(byId.has(ids['inactiveA1'])).toBe(false);
    expect(byId.has(ids['expenseA1'])).toBe(false);
    expect(byId.has(ids['sharedNullA'])).toBe(false);

    const cc: any = byId.get(ids['ccA1']);
    expect(cc.kind).toBe('card');
    expect(cc.balance).toBe(321); // liability negated → positive "owed"
    const chk: any = byId.get(ids['checkingA1']);
    expect(chk.kind).toBe('bank');
    expect(chk.balance).toBe(1500.25);
  });

  it('single-company tenant sees NULL-company accounts', async () => {
    const r = await request('GET', `/api/portal/banking/accounts?companyId=${ids['b1']}`, cookies['cTenantB']);
    expect(r.status).toBe(200);
    expect(r.json.accounts.map((a: any) => a.id)).toContain(ids['checkingBNull']);
  });

  it('register: sanitized lines, voids excluded, pagination shape', async () => {
    const r = await request(
      'GET',
      `/api/portal/banking/accounts/${ids['checkingA1']}/register?companyId=${ids['a1']}`,
      cookies['cGranted'],
    );
    expect(r.status).toBe(200);
    expect(r.json.featureEnabled).toBe(true);
    expect(r.json.account.id).toBe(ids['checkingA1']);
    expect(r.json.pagination.totalRows).toBe(2); // void excluded
    expect(r.json.lines).toHaveLength(2);
    for (const line of r.json.lines) {
      expect(line).not.toHaveProperty('memo');
      expect(line).not.toHaveProperty('reconciliationStatus');
      expect(line).not.toHaveProperty('isEditable');
      expect(line).not.toHaveProperty('contactId');
      expect(typeof line.runningBalance).toBe('number');
      expect(line.deposit).toBeGreaterThan(0);
    }
    // Newest-first display; both same-day rows present.
    const amounts = r.json.lines.map((l: any) => l.deposit);
    expect(amounts).toContain(100);
    expect(amounts).toContain(50);
  });

  it('register IDOR: cross-company and cross-tenant accounts are 404', async () => {
    // Account exists in tenant A but belongs to company A2 — asking with A1.
    const crossCompany = await request(
      'GET',
      `/api/portal/banking/accounts/${ids['checkingA2']}/register?companyId=${ids['a1']}`,
      cookies['cGranted'],
    );
    expect(crossCompany.status).toBe(404);

    // NULL-company account in a multi-company tenant: hidden.
    const nullCo = await request(
      'GET',
      `/api/portal/banking/accounts/${ids['sharedNullA']}/register?companyId=${ids['a1']}`,
      cookies['cGranted'],
    );
    expect(nullCo.status).toBe(404);

    // Cross-tenant: tenant B's account via tenant A's session.
    const crossTenant = await request(
      'GET',
      `/api/portal/banking/accounts/${ids['checkingBNull']}/register?companyId=${ids['a1']}`,
      cookies['cGranted'],
    );
    expect(crossTenant.status).toBe(404);
  });

  it('companyId from another tenant is 403 (not linked in-tenant)', async () => {
    const r = await request('GET', `/api/portal/banking/accounts?companyId=${ids['b1']}`, cookies['cGranted']);
    expect(r.status).toBe(403);
  });

  it('rejects malformed query params', async () => {
    const noCompany = await request('GET', '/api/portal/banking/accounts', cookies['cGranted']);
    expect(noCompany.status).toBe(400);
    const badDate = await request(
      'GET',
      `/api/portal/banking/accounts/${ids['checkingA1']}/register?companyId=${ids['a1']}&startDate=nope`,
      cookies['cGranted'],
    );
    expect(badDate.status).toBe(400);
    const badPage = await request(
      'GET',
      `/api/portal/banking/accounts/${ids['checkingA1']}/register?companyId=${ids['a1']}&page=0`,
      cookies['cGranted'],
    );
    expect(badPage.status).toBe(400);
  });
});
