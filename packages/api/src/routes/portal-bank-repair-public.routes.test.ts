// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Portal bank-login repair: session cookie → tenant flag → per-contact
// bank_repair_access → the item must belong to the company (accounts →
// mappings → plaid item walk; the NULL-company rule applies) → update-mode
// Link token with the registered redirect → completion refreshes + syncs.
// Preview sessions can list but never mint tokens; other tenants' and
// unmapped items are invisible.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import 'express-async-errors';
import express from 'express';
import http from 'http';
import crypto from 'crypto';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  tenants, companies, accounts, portalContacts, portalContactCompanies, portalContactSessions,
  tenantFeatureFlags, plaidItems, plaidAccounts, plaidAccountMappings, auditLog, users,
} from '../db/schema/index.js';
import { errorHandler } from '../middleware/error-handler.js';

const plaidMocks = vi.hoisted(() => ({ createUpdateLinkToken: vi.fn(), createLinkToken: vi.fn() }));
vi.mock('../services/plaid-client.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/plaid-client.service.js')>();
  return {
    ...actual,
    createUpdateLinkToken: (...a: unknown[]) => plaidMocks.createUpdateLinkToken(...a),
    createLinkToken: (...a: unknown[]) => plaidMocks.createLinkToken(...a),
  };
});
const connMocks = vi.hoisted(() => ({ refreshItemStatus: vi.fn() }));
vi.mock('../services/plaid-connection.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/plaid-connection.service.js')>();
  return { ...actual, refreshItemStatus: (...a: unknown[]) => connMocks.refreshItemStatus(...a) };
});
const syncMocks = vi.hoisted(() => ({ syncItem: vi.fn() }));
vi.mock('../services/plaid-sync.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/plaid-sync.service.js')>();
  return { ...actual, syncItem: (...a: unknown[]) => syncMocks.syncItem(...a) };
});

import { portalBankRepairPublicRouter } from './portal-bank-repair-public.routes.js';

let server: Server | null = null;
let port = 0;
let tenantId = '';
let otherTenantId = '';
const ids: Record<string, string> = {};
const cookies: Record<string, string> = {};

function request(method: string, pathname: string, cookie?: string): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port, path: pathname, method,
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: `kisbooks_portal_session=${cookie}` } : {}) },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { const raw = Buffer.concat(chunks).toString('utf8'); try { resolve({ status: res.statusCode ?? 0, json: raw ? JSON.parse(raw) : null }); } catch { resolve({ status: res.statusCode ?? 0, json: raw }); } });
    });
    req.on('error', reject);
    req.end();
  });
}

async function mkSession(key: string, tId: string, contactId: string) {
  const token = crypto.randomBytes(32).toString('hex');
  await db.insert(portalContactSessions).values({
    tenantId: tId, contactId, tokenHash: crypto.createHash('sha256').update(token).digest('hex'), expiresAt: new Date(Date.now() + 3600_000),
  });
  cookies[key] = token;
}
async function setFlag(tId: string, enabled: boolean) {
  await db.insert(tenantFeatureFlags).values({ tenantId: tId, flagKey: 'PORTAL_BANKING_V1', enabled, rolloutPercent: enabled ? 100 : 0 })
    .onConflictDoUpdate({ target: [tenantFeatureFlags.tenantId, tenantFeatureFlags.flagKey], set: { enabled } });
}

beforeAll(async () => {
  const { encrypt } = await import('../utils/encryption.js');
  const sfx = () => Date.now() + '-' + Math.random().toString(36).slice(2, 6);
  const [t] = await db.insert(tenants).values({ name: 'PBR T', slug: 'pbr-' + sfx() }).returning();
  const [o] = await db.insert(tenants).values({ name: 'PBR Other', slug: 'pbr-o-' + sfx() }).returning();
  tenantId = t!.id; otherTenantId = o!.id;
  const [co] = await db.insert(companies).values({ tenantId, businessName: 'PBR Co' }).returning();
  const [co2] = await db.insert(companies).values({ tenantId: otherTenantId, businessName: 'Other Co' }).returning();
  ids['co'] = co!.id; ids['co2'] = co2!.id;
  const [staff] = await db.insert(users).values({ tenantId, email: `pbr-staff-${sfx()}@example.com`, passwordHash: 'x'.repeat(60), role: 'accountant', displayName: 'Staff' }).returning();
  ids['staff'] = staff!.id;
  // Single-company tenant → a NULL-company checking account is eligible.
  const [chk] = await db.insert(accounts).values({ tenantId, name: 'Checking', accountType: 'asset', detailType: 'checking', isActive: true }).returning();
  const [chkOther] = await db.insert(accounts).values({ tenantId: otherTenantId, companyId: co2!.id, name: 'Other Chk', accountType: 'asset', detailType: 'checking', isActive: true }).returning();
  ids['chk'] = chk!.id;
  // Broken item mapped into this company; healthy item mapped into the other tenant; an unmapped item.
  const mkItem = async (key: string, status: string, name: string) => {
    const [it] = await db.insert(plaidItems).values({
      plaidItemId: 'item-' + sfx(), institutionName: name, accessTokenEncrypted: encrypt('tok-' + key), itemStatus: status,
      errorCode: status === 'login_required' ? 'ITEM_LOGIN_REQUIRED' : null, createdByEmail: 'staff@example.com',
    }).returning();
    ids[key] = it!.id;
    const [pa] = await db.insert(plaidAccounts).values({ plaidItemId: it!.id, plaidAccountId: 'pa-' + sfx(), name: `${name} Checking`, mask: '1234', accountType: 'depository' }).returning();
    ids[key + '-pa'] = pa!.id;
  };
  await mkItem('broken', 'login_required', 'U.S. Bank');
  await mkItem('other', 'login_required', 'Foreign Bank');
  await mkItem('unmapped', 'login_required', 'Orphan Bank');
  await db.insert(plaidAccountMappings).values([
    { plaidAccountId: ids['broken-pa']!, tenantId, mappedAccountId: chk!.id, syncStartDate: '2026-01-01', mappedBy: staff!.id },
    { plaidAccountId: ids['other-pa']!, tenantId: otherTenantId, mappedAccountId: chkOther!.id, syncStartDate: '2026-01-01', mappedBy: staff!.id },
  ]);
  const mkContact = async (key: string, tId: string, companyId: string, repair: boolean) => {
    const [c] = await db.insert(portalContacts).values({ tenantId: tId, email: `${key}-${sfx()}@example.com`, status: 'active' }).returning();
    await db.insert(portalContactCompanies).values({ contactId: c!.id, companyId, bankingAccess: true, bankRepairAccess: repair });
    ids[key] = c!.id;
    await mkSession(key, tId, c!.id);
  };
  await mkContact('fixer', tenantId, co!.id, true);
  await mkContact('viewer', tenantId, co!.id, false);
  await setFlag(tenantId, true);
  await new Promise<void>((resolve) => {
    const app = express();
    app.use(express.json());
    app.use('/api/portal/banking/connections', portalBankRepairPublicRouter);
    app.use(errorHandler);
    server = app.listen(0, () => { port = (server!.address() as AddressInfo).port; resolve(); });
  });
});

afterAll(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  const tIds = [tenantId, otherTenantId];
  await db.delete(plaidAccountMappings).where(inArray(plaidAccountMappings.tenantId, tIds));
  await db.delete(plaidAccounts).where(inArray(plaidAccounts.plaidItemId, [ids['broken']!, ids['other']!, ids['unmapped']!]));
  await db.delete(plaidItems).where(inArray(plaidItems.id, [ids['broken']!, ids['other']!, ids['unmapped']!]));
  await db.delete(auditLog).where(inArray(auditLog.tenantId, tIds));
  await db.delete(portalContactSessions).where(inArray(portalContactSessions.tenantId, tIds));
  await db.delete(portalContacts).where(inArray(portalContacts.tenantId, tIds));
  await db.delete(users).where(inArray(users.tenantId, tIds));
  await db.delete(tenantFeatureFlags).where(inArray(tenantFeatureFlags.tenantId, tIds));
  await db.delete(accounts).where(inArray(accounts.tenantId, tIds));
  await db.delete(companies).where(inArray(companies.tenantId, tIds));
  await db.delete(tenants).where(inArray(tenants.id, tIds));
});

const co = () => ids['co']!;

describe('portal bank repair', () => {
  it('lists only the company\'s connections with client-safe messages; other tenants and unmapped items are invisible', async () => {
    const r = await request('GET', `/api/portal/banking/connections?companyId=${co()}`, cookies['fixer']);
    expect(r.status).toBe(200);
    expect(r.json.connections.map((c: { plaidItemId: string }) => c.plaidItemId)).toEqual([ids['broken']]);
    expect(r.json.connections[0]).toMatchObject({ institutionName: 'U.S. Bank', needsAttention: true, itemStatus: 'login_required' });
    expect(r.json.connections[0].message).toMatch(/sign in again/);
    expect(r.json.connections[0].accounts[0]).toMatchObject({ name: 'U.S. Bank Checking', mask: '1234' });
    expect(JSON.stringify(r.json)).not.toMatch(/ITEM_LOGIN_REQUIRED|access|tok-/);
  });

  it('requires the session, the per-contact grant, and the tenant flag', async () => {
    expect((await request('GET', `/api/portal/banking/connections?companyId=${co()}`)).status).toBe(401);
    const viewer = await request('GET', `/api/portal/banking/connections?companyId=${co()}`, cookies['viewer']);
    expect(viewer.status).toBe(403);
    expect(viewer.json?.error?.code ?? viewer.json?.code).toBe('BANK_REPAIR_NOT_ENABLED');
    expect((await request('POST', `/api/portal/banking/connections/${ids['broken']}/link-token?companyId=${co()}`, cookies['viewer'])).status).toBe(403);
    // Cross-tenant company id → 403 (tenant join), not a leak.
    expect((await request('GET', `/api/portal/banking/connections?companyId=${ids['co2']}`, cookies['fixer'])).status).toBe(403);
    await setFlag(tenantId, false);
    const off = await request('GET', `/api/portal/banking/connections?companyId=${co()}`, cookies['fixer']);
    expect(off.json.featureEnabled).toBe(false);
    expect((await request('POST', `/api/portal/banking/connections/${ids['broken']}/link-token?companyId=${co()}`, cookies['fixer'])).status).toBe(403);
    await setFlag(tenantId, true);
  });

  it('mints an update-mode Link token for an in-company item only, with the registered redirect', async () => {
    plaidMocks.createUpdateLinkToken.mockResolvedValue('link-update-xyz');
    const { env } = await import('../config/env.js');
    const prev = env.PUBLIC_URL;
    (env as { PUBLIC_URL: string }).PUBLIC_URL = 'https://books.example.com';
    try {
      const r = await request('POST', `/api/portal/banking/connections/${ids['broken']}/link-token?companyId=${co()}`, cookies['fixer']);
      expect(r.status).toBe(200);
      expect(r.json).toMatchObject({ linkToken: 'link-update-xyz', institutionName: 'U.S. Bank', oauthReturnEnabled: true });
      const call = plaidMocks.createUpdateLinkToken.mock.calls[0]!;
      expect(call[1]).toMatch(/^portal-repair:/);
      expect(call[2]).toBe('tok-broken'); // decrypted access token passed through
      expect(call[3]).toEqual({ redirectUri: 'https://books.example.com/connect/oauth-return' });
      expect(plaidMocks.createLinkToken).not.toHaveBeenCalled();
    } finally {
      (env as { PUBLIC_URL: string }).PUBLIC_URL = prev;
    }
    // Items outside the company walk are 404, never minted.
    expect((await request('POST', `/api/portal/banking/connections/${ids['other']}/link-token?companyId=${co()}`, cookies['fixer'])).status).toBe(404);
    expect((await request('POST', `/api/portal/banking/connections/${ids['unmapped']}/link-token?companyId=${co()}`, cookies['fixer'])).status).toBe(404);
    expect(plaidMocks.createUpdateLinkToken).toHaveBeenCalledTimes(1);
  });

  it('repair-complete refreshes the item, kicks a sync, reports the resulting status and audits', async () => {
    connMocks.refreshItemStatus.mockImplementation(async (id: string) => {
      await db.update(plaidItems).set({ itemStatus: 'active', errorCode: null, errorMessage: null }).where(eq(plaidItems.id, id));
    });
    syncMocks.syncItem.mockResolvedValue({ added: 0 });
    const r = await request('POST', `/api/portal/banking/connections/${ids['broken']}/repair-complete?companyId=${co()}`, cookies['fixer']);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, healthy: true, itemStatus: 'active', institutionName: 'U.S. Bank' });
    expect(connMocks.refreshItemStatus).toHaveBeenCalledWith(ids['broken']);
    expect(syncMocks.syncItem).toHaveBeenCalledWith(ids['broken']);
    const audits = await db.select().from(auditLog).where(eq(auditLog.tenantId, tenantId));
    const kinds = audits.map((a) => (typeof a.afterData === 'string' ? JSON.parse(a.afterData) : a.afterData)?.action).sort();
    expect(kinds).toEqual(['portal_repair_complete', 'portal_repair_link_token']);
    // Now healthy → no longer flagged.
    const list = await request('GET', `/api/portal/banking/connections?companyId=${co()}`, cookies['fixer']);
    expect(list.json.connections[0].needsAttention).toBe(false);
    // A still-failing refresh reports healthy:false but is still ok:true.
    await db.update(plaidItems).set({ itemStatus: 'login_required' }).where(eq(plaidItems.id, ids['broken']!));
    connMocks.refreshItemStatus.mockRejectedValue(new Error('plaid down'));
    const r2 = await request('POST', `/api/portal/banking/connections/${ids['broken']}/repair-complete?companyId=${co()}`, cookies['fixer']);
    expect(r2.status).toBe(200);
    expect(r2.json.healthy).toBe(false);
  });
});
