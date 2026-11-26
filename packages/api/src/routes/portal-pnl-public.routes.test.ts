// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

// Portal live Profit & Loss — the router must enforce session cookie →
// per-contact profit_loss_access → tenant/company scoping, the P&L must
// equal the staff builder, the drill-down must sum to its P&L row, the
// unposted-bank-feed memo must count only open items in range for the
// company, and asking about a transaction must reject a transaction from
// another company.

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
  portalContacts, portalContactCompanies, portalContactSessions, portalQuestions,
  bankConnections, bankFeedItems, tenantFeatureFlags,
} from '../db/schema/index.js';
import { portalPnlPublicRouter } from './portal-pnl-public.routes.js';
import { errorHandler } from '../middleware/error-handler.js';
import * as reportSvc from '../services/report.service.js';
import * as questionSvc from '../services/portal-question.service.js';

let server: Server | null = null;
let port = 0;
let tenantAId = '';
let tenantBId = '';
const ids: Record<string, string> = {};
const cookies: Record<string, string> = {};

const START = '2026-01-01';
const END = '2026-12-31';
const qs = (companyId: string) => `companyId=${companyId}&start_date=${START}&end_date=${END}`;

function request(method: string, pathname: string, cookie?: string): Promise<{ status: number; json: any }> {
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
  app.use('/api/portal/profit-loss', portalPnlPublicRouter);
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

async function setBankingFlag(tenantId: string, enabled: boolean) {
  await db
    .insert(tenantFeatureFlags)
    .values({ tenantId, flagKey: 'PORTAL_BANKING_V1', enabled, rolloutPercent: enabled ? 100 : 0 })
    .onConflictDoUpdate({
      target: [tenantFeatureFlags.tenantId, tenantFeatureFlags.flagKey],
      set: { enabled, rolloutPercent: enabled ? 100 : 0 },
    });
}

async function seed() {
  const suffix = () => Date.now() + '-' + Math.random().toString(36).slice(2, 6);
  const [tA] = await db.insert(tenants).values({ name: 'PnL T A', slug: 'ppnl-a-' + suffix() }).returning();
  const [tB] = await db.insert(tenants).values({ name: 'PnL T B', slug: 'ppnl-b-' + suffix() }).returning();
  tenantAId = tA!.id;
  tenantBId = tB!.id;

  const [a1] = await db.insert(companies).values({ tenantId: tenantAId, businessName: 'A One' }).returning();
  const [a2] = await db.insert(companies).values({ tenantId: tenantAId, businessName: 'A Two' }).returning();
  const [b1] = await db.insert(companies).values({ tenantId: tenantBId, businessName: 'B One' }).returning();
  ids['a1'] = a1!.id; ids['a2'] = a2!.id; ids['b1'] = b1!.id;

  const [rev] = await db.insert(accounts).values({
    tenantId: tenantAId, name: 'Sales', accountType: 'revenue', detailType: 'service_fee_income',
  }).returning();
  const [asset] = await db.insert(accounts).values({
    tenantId: tenantAId, companyId: a1!.id, name: 'Checking', accountType: 'asset', detailType: 'bank',
  }).returning();
  ids['revenue'] = rev!.id; ids['asset'] = asset!.id;
  // Portal banking is on for both tenants; one test switches it off.
  await setBankingFlag(tenantAId, true);
  await setBankingFlag(tenantBId, true);

  const mkTxn = async (key: string, companyId: string, status: string, credit: string, date = '2026-03-15') => {
    const [txn] = await db.insert(transactions).values({
      tenantId: tenantAId, companyId, txnType: 'deposit', txnDate: date, status, memo: key,
    }).returning();
    await db.insert(journalLines).values({
      tenantId: tenantAId, transactionId: txn!.id, accountId: ids['revenue']!, debit: '0', credit,
    });
    ids[key] = txn!.id;
  };
  await mkTxn('sale1', ids['a1']!, 'posted', '100.0000');
  await mkTxn('sale2', ids['a1']!, 'posted', '50.0000', '2026-04-02');
  await mkTxn('voided', ids['a1']!, 'void', '999.0000');
  await mkTxn('otherCompany', ids['a2']!, 'posted', '777.0000');
  await mkTxn('outOfRange', ids['a1']!, 'posted', '5.0000', '2025-06-01');

  // Bank feed items behind the "unposted" memo line. Tenant A has two
  // companies, so a NULL-company item must NOT count toward A One.
  const [conn] = await db.insert(bankConnections).values({
    tenantId: tenantAId, companyId: ids['a1']!, accountId: ids['asset']!, provider: 'manual',
  }).returning();
  ids['conn'] = conn!.id;
  // A connection with no company of its own, in a tenant with two: its
  // NULL-company items belong to nobody in particular.
  const [shared] = await db.insert(bankConnections).values({
    tenantId: tenantAId, accountId: ids['asset']!, provider: 'manual',
  }).returning();
  // A retired account: the banking pages no longer list it.
  const [retired] = await db.insert(accounts).values({
    tenantId: tenantAId, companyId: ids['a1']!, name: 'Old Checking', accountType: 'asset', detailType: 'bank', isActive: false,
  }).returning();
  const [retiredConn] = await db.insert(bankConnections).values({
    tenantId: tenantAId, companyId: ids['a1']!, accountId: retired!.id, provider: 'manual',
  }).returning();
  const mkFeed = async (
    companyId: string | null, status: string, amount: string, feedDate: string,
    extra: { bankConnectionId?: string; possibleDuplicate?: boolean; entryVoidedAt?: Date } = {},
  ) => {
    await db.insert(bankFeedItems).values({
      tenantId: tenantAId, companyId, bankConnectionId: ids['conn']!, feedDate, amount, status,
      description: `${status} ${amount}`, ...extra,
    });
  };
  await mkFeed(ids['a1']!, 'pending', '120.0000', '2026-03-10');     // money out, counts
  await mkFeed(ids['a1']!, 'assigned', '-80.0000', '2026-05-01');    // money in, counts (abs)
  await mkFeed(ids['a1']!, 'categorized', '500.0000', '2026-03-11'); // already posted
  await mkFeed(ids['a1']!, 'matched', '400.0000', '2026-03-12');     // already posted
  await mkFeed(ids['a1']!, 'excluded', '300.0000', '2026-03-13');    // deliberately out
  await mkFeed(ids['a1']!, 'pending', '999.0000', '2025-12-31');     // out of range
  await mkFeed(ids['a2']!, 'pending', '777.0000', '2026-03-14');     // other company
  await mkFeed(null, 'pending', '555.0000', '2026-03-15');           // no company: takes its connection's (A One), counts
  await mkFeed(null, 'pending', '444.0000', '2026-03-16', { bankConnectionId: shared!.id }); // no company anywhere, two companies
  await mkFeed(ids['a1']!, 'categorizing', '30.0000', '2026-03-21'); // being posted, not in the P&L yet, counts
  await mkFeed(ids['a1']!, 'categorized', '60.0000', '2026-03-20', { entryVoidedAt: new Date() }); // entry voided, counts
  await mkFeed(ids['a1']!, 'pending', '222.0000', '2026-03-22', { possibleDuplicate: true });      // look-alike awaiting staff
  await mkFeed(ids['a1']!, 'pending', '111.0000', '2026-03-23', { bankConnectionId: retiredConn!.id }); // retired account

  const mkContact = async (key: string, tenantId: string, companyId: string, flags: { profitLossAccess: boolean; questionsForUsAccess: boolean; bankingAccess?: boolean }) => {
    const [c] = await db.insert(portalContacts).values({
      tenantId, email: `${key}-${suffix()}@ex.com`, status: 'active',
    }).returning();
    await db.insert(portalContactCompanies).values({ contactId: c!.id, companyId, ...flags });
    ids[key] = c!.id;
    await mkSession(key, tenantId, c!.id);
  };
  await mkContact('cGranted', tenantAId, ids['a1']!, { profitLossAccess: true, questionsForUsAccess: true, bankingAccess: true });
  // The P&L alone: the firm has not given this contact the banking pages.
  await mkContact('cNoBanking', tenantAId, ids['a1']!, { profitLossAccess: true, questionsForUsAccess: true });
  await mkContact('cDenied', tenantAId, ids['a1']!, { profitLossAccess: false, questionsForUsAccess: true });
  await mkContact('cNoQuestions', tenantAId, ids['a1']!, { profitLossAccess: true, questionsForUsAccess: false });
  await mkContact('cTenantB', tenantBId, ids['b1']!, { profitLossAccess: true, questionsForUsAccess: true, bankingAccess: true });
}

async function cleanDb() {
  for (const tenantId of [tenantAId, tenantBId]) {
    if (!tenantId) continue;
    await db.delete(portalQuestions).where(eq(portalQuestions.tenantId, tenantId));
    await db.delete(tenantFeatureFlags).where(eq(tenantFeatureFlags.tenantId, tenantId));
    await db.delete(bankFeedItems).where(eq(bankFeedItems.tenantId, tenantId));
    await db.delete(bankConnections).where(eq(bankConnections.tenantId, tenantId));
    await db.delete(journalLines).where(eq(journalLines.tenantId, tenantId));
    await db.delete(transactions).where(eq(transactions.tenantId, tenantId));
    await db.delete(portalContactSessions).where(eq(portalContactSessions.tenantId, tenantId));
    const contactRows = await db.select({ id: portalContacts.id }).from(portalContacts).where(eq(portalContacts.tenantId, tenantId));
    for (const c of contactRows) {
      await db.delete(portalContactCompanies).where(eq(portalContactCompanies.contactId, c.id));
    }
    await db.delete(portalContacts).where(eq(portalContacts.tenantId, tenantId));
    await db.delete(accounts).where(eq(accounts.tenantId, tenantId));
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

describe('portal profit & loss router', () => {
  it('rejects requests without a session cookie', async () => {
    const r = await request('GET', `/api/portal/profit-loss?${qs(ids['a1']!)}`);
    expect(r.status).toBe(401);
  });

  it('403 without profit_loss_access, for both endpoints', async () => {
    const pl = await request('GET', `/api/portal/profit-loss?${qs(ids['a1']!)}`, cookies['cDenied']);
    expect(pl.status).toBe(403);
    const drill = await request(
      'GET', `/api/portal/profit-loss/accounts/${ids['revenue']}/transactions?${qs(ids['a1']!)}`, cookies['cDenied'],
    );
    expect(drill.status).toBe(403);
  });

  it('403 for a company the contact is not linked to, and across tenants', async () => {
    const other = await request('GET', `/api/portal/profit-loss?${qs(ids['a2']!)}`, cookies['cGranted']);
    expect(other.status).toBe(403);
    const crossTenant = await request('GET', `/api/portal/profit-loss?${qs(ids['a1']!)}`, cookies['cTenantB']);
    expect(crossTenant.status).toBe(403);
  });

  it('validates the date range', async () => {
    const missing = await request('GET', `/api/portal/profit-loss?companyId=${ids['a1']}`, cookies['cGranted']);
    expect(missing.status).toBe(400);
    const reversed = await request(
      'GET', `/api/portal/profit-loss?companyId=${ids['a1']}&start_date=2026-12-31&end_date=2026-01-01`, cookies['cGranted'],
    );
    expect(reversed.status).toBe(400);
    const tooLong = await request(
      'GET', `/api/portal/profit-loss?companyId=${ids['a1']}&start_date=2000-01-01&end_date=2026-01-01`, cookies['cGranted'],
    );
    expect(tooLong.status).toBe(400);
  });

  it('returns the same P&L as the staff builder (posted, this company, in range)', async () => {
    const r = await request('GET', `/api/portal/profit-loss?${qs(ids['a1']!)}`, cookies['cGranted']);
    expect(r.status).toBe(200);
    const staff = await reportSvc.buildProfitAndLoss(tenantAId, START, END, 'accrual', ids['a1']!);
    expect(r.json.netIncome).toBe(staff.netIncome);
    expect(r.json.totalRevenue).toBe(150);
    expect(r.json.revenue.find((e: { accountId: string }) => e.accountId === ids['revenue']).amount).toBe(150);
  });

  it('reports unposted bank feed activity in range without changing the P&L', async () => {
    const r = await request('GET', `/api/portal/profit-loss?${qs(ids['a1']!)}`, cookies['cGranted']);
    expect(r.status).toBe(200);
    // Out: pending 120, the NULL-company 555 on A One's connection, the
    // voided-entry 60 and the mid-posting 30. In: assigned |-80|.
    // Categorized/matched/excluded, out-of-range, other-company, the item
    // with no company anywhere, the possible duplicate and the retired
    // account's item all stay out.
    expect(r.json.unpostedBankFeed).toEqual({ count: 5, moneyIn: 80, moneyOut: 765, amount: 845 });
    expect(r.json.netIncome).toBe(150);

    const narrow = await request(
      'GET', `/api/portal/profit-loss?companyId=${ids['a1']}&start_date=2026-03-01&end_date=2026-03-31`, cookies['cGranted'],
    );
    expect(narrow.json.unpostedBankFeed).toEqual({ count: 4, moneyIn: 0, moneyOut: 765, amount: 765 });
  });

  it('leaves the bank feed memo off for a contact without banking access', async () => {
    const r = await request('GET', `/api/portal/profit-loss?${qs(ids['a1']!)}`, cookies['cNoBanking']);
    expect(r.status).toBe(200);
    // Same statement as everyone else, and no bank figures at all.
    expect(r.json.netIncome).toBe(150);
    expect('unpostedBankFeed' in r.json).toBe(false);
  });

  it('leaves the bank feed memo off when the firm has portal banking switched off', async () => {
    await setBankingFlag(tenantAId, false);
    const r = await request('GET', `/api/portal/profit-loss?${qs(ids['a1']!)}`, cookies['cGranted']);
    expect(r.status).toBe(200);
    expect(r.json.netIncome).toBe(150);
    expect('unpostedBankFeed' in r.json).toBe(false);
  });

  it('rejects a companyId or account id that is not a UUID, and repeated date parameters', async () => {
    const badCompany = await request('GET', `/api/portal/profit-loss?companyId=nope&start_date=${START}&end_date=${END}`, cookies['cGranted']);
    expect(badCompany.status).toBe(400);
    const badAccount = await request('GET', `/api/portal/profit-loss/accounts/nope/transactions?${qs(ids['a1']!)}`, cookies['cGranted']);
    expect(badAccount.status).toBe(400);
    const repeated = await request(
      'GET', `/api/portal/profit-loss?companyId=${ids['a1']}&start_date=${START}&start_date=${START}&end_date=${END}`, cookies['cGranted'],
    );
    expect(repeated.status).toBe(400);
  });

  it('counts NULL-company feed items when the tenant has a single company', async () => {
    const [bAsset] = await db.insert(accounts).values({
      tenantId: tenantBId, name: 'B Checking', accountType: 'asset', detailType: 'bank',
    }).returning();
    const [b] = await db.insert(bankConnections).values({
      tenantId: tenantBId, accountId: bAsset!.id, provider: 'manual',
    }).returning();
    await db.insert(bankFeedItems).values({
      tenantId: tenantBId, companyId: null, bankConnectionId: b!.id, feedDate: '2026-02-02', amount: '42.5000', status: 'pending',
    });
    const r = await request('GET', `/api/portal/profit-loss?${qs(ids['b1']!)}`, cookies['cTenantB']);
    expect(r.status).toBe(200);
    expect(r.json.unpostedBankFeed).toEqual({ count: 1, moneyIn: 0, moneyOut: 42.5, amount: 42.5 });
  });

  it('drill-down lists posted lines for the company and sums to the P&L row', async () => {
    const r = await request(
      'GET', `/api/portal/profit-loss/accounts/${ids['revenue']}/transactions?${qs(ids['a1']!)}`, cookies['cGranted'],
    );
    expect(r.status).toBe(200);
    const txnIds = r.json.items.map((i: { transactionId: string }) => i.transactionId).sort();
    expect(txnIds).toEqual([ids['sale1'], ids['sale2']].sort());
    expect(r.json.total).toBe(2);
    expect(r.json.sum).toBe(150);
  });

  it('cash-basis company: drill-down sums to the P&L row', async () => {
    await db.update(companies).set({ accountingMethod: 'cash' }).where(eq(companies.id, ids['a1']!));
    const pl = await request('GET', `/api/portal/profit-loss?${qs(ids['a1']!)}`, cookies['cGranted']);
    expect(pl.status).toBe(200);
    expect(pl.json.basis).toBe('cash');
    const row = pl.json.revenue.find((e: { accountId: string }) => e.accountId === ids['revenue']);
    const drill = await request(
      'GET', `/api/portal/profit-loss/accounts/${ids['revenue']}/transactions?${qs(ids['a1']!)}`, cookies['cGranted'],
    );
    expect(drill.status).toBe(200);
    expect(drill.json.sum).toBe(row.amount);
    expect(drill.json.total).toBe(2);
  });

  it('drill-down paginates', async () => {
    const r = await request(
      'GET', `/api/portal/profit-loss/accounts/${ids['revenue']}/transactions?${qs(ids['a1']!)}&perPage=1&page=2`,
      cookies['cGranted'],
    );
    expect(r.status).toBe(200);
    expect(r.json.items).toHaveLength(1);
    expect(r.json.total).toBe(2);
  });

  it('drill-down 404s for a non-P&L account', async () => {
    const r = await request(
      'GET', `/api/portal/profit-loss/accounts/${ids['asset']}/transactions?${qs(ids['a1']!)}`, cookies['cGranted'],
    );
    expect(r.status).toBe(404);
  });
});

describe('asking about a transaction (contactAsk)', () => {
  it('links the question to the transaction', async () => {
    const { id } = await questionSvc.contactAsk(tenantAId, ids['cGranted']!, {
      companyId: ids['a1']!, body: 'What is this?', transactionId: ids['sale1']!,
    });
    const [row] = await db.select().from(portalQuestions).where(eq(portalQuestions.id, id));
    expect(row?.transactionId).toBe(ids['sale1']);
  });

  it('rejects a transaction that belongs to another company', async () => {
    await expect(questionSvc.contactAsk(tenantAId, ids['cGranted']!, {
      companyId: ids['a1']!, body: 'What is this?', transactionId: ids['otherCompany']!,
    })).rejects.toThrow(/not found/i);
  });

  it('rejects a contact without questionsForUsAccess', async () => {
    await expect(questionSvc.contactAsk(tenantAId, ids['cNoQuestions']!, {
      companyId: ids['a1']!, body: 'What is this?', transactionId: ids['sale1']!,
    })).rejects.toThrow(/not enabled/i);
  });
});
