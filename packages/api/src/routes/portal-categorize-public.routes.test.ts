// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// PORTAL_CATEGORIZE_V1 — the client-facing router. What is under test is the
// guard stack and the redaction boundary, in this order: session cookie ->
// tenant flag -> per-contact categorize_access -> the NULL-company rule.
//
// The load-bearing assertions are negative ones: a client must not be able to
// aim a suggestion at another tenant's row, must not receive the AI's guess
// or the raw bank descriptor, must not pick a bank/system account as a
// "category", and must never cause anything to post.

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
  bankConnections, bankFeedItems, transactionClassificationState,
  clientCategorySuggestions, portalContacts, portalContactCompanies,
  portalContactSessions, tenantFeatureFlags, attachments,
} from '../db/schema/index.js';
import { portalCategorizePublicRouter } from './portal-categorize-public.routes.js';
import { errorHandler } from '../middleware/error-handler.js';

let server: Server | null = null;
let port = 0;
let tenantAId = '';
let tenantBId = '';
const ids: Record<string, string> = {};
const cookies: Record<string, string> = {};

function request(method: string, pathname: string, body?: unknown, cookie?: string): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : undefined;
    const req = http.request({
      hostname: '127.0.0.1', port, path: pathname, method,
      headers: {
        'Content-Type': 'application/json',
        ...(cookie ? { Cookie: `kisbooks_portal_session=${cookie}` } : {}),
        ...(data ? { 'Content-Length': String(data.length) } : {}),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        try { resolve({ status: res.statusCode ?? 0, json: raw ? JSON.parse(raw) : null }); }
        catch { resolve({ status: res.statusCode ?? 0, json: raw }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

/**
 * POST a multipart body. Hand-rolled rather than pulled in as a dependency:
 * the suite already speaks raw http, and one boundary is cheaper than a new
 * package on the upload path.
 */
function multipart(
  pathname: string,
  fields: Record<string, string>,
  files: Array<{ field: string; filename: string; contentType: string; body: Buffer }>,
  cookie?: string,
): Promise<{ status: number; json: any }> {
  const boundary = '----kisbooksTest' + crypto.randomBytes(8).toString('hex');
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`,
    ));
  }
  for (const f of files) {
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${f.field}"; ` +
      `filename="${f.filename}"\r\nContent-Type: ${f.contentType}\r\n\r\n`,
    ));
    parts.push(f.body);
    parts.push(Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  const data = Buffer.concat(parts);

  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port, path: pathname, method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': String(data.length),
        ...(cookie ? { Cookie: `kisbooks_portal_session=${cookie}` } : {}),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        try { resolve({ status: res.statusCode ?? 0, json: raw ? JSON.parse(raw) : null }); }
        catch { resolve({ status: res.statusCode ?? 0, json: raw }); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// A real 1x1 PNG. verifyAttachmentContent sniffs magic bytes, so a buffer of
// zeroes labelled image/png is correctly rejected — which is its own test.
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

async function startApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/portal/categorize', portalCategorizePublicRouter);
  app.use(errorHandler);
  return new Promise<void>((resolve) => {
    server = app.listen(0, () => { port = (server!.address() as AddressInfo).port; resolve(); });
  });
}

async function mkSession(key: string, tenantId: string, contactId: string) {
  const token = crypto.randomBytes(32).toString('hex');
  await db.insert(portalContactSessions).values({
    tenantId, contactId,
    tokenHash: crypto.createHash('sha256').update(token).digest('hex'),
    expiresAt: new Date(Date.now() + 3600_000),
  });
  cookies[key] = token;
}

async function setFlag(tenantId: string, enabled: boolean) {
  await db.insert(tenantFeatureFlags)
    .values({ tenantId, flagKey: 'PORTAL_CATEGORIZE_V1', enabled, rolloutPercent: enabled ? 100 : 0 })
    .onConflictDoUpdate({
      target: [tenantFeatureFlags.tenantId, tenantFeatureFlags.flagKey],
      set: { enabled },
    });
}

const suffix = () => Date.now() + '-' + Math.random().toString(36).slice(2, 6);

async function seed() {
  const [tA] = await db.insert(tenants).values({ name: 'Cat T A', slug: 'pcat-a-' + suffix() }).returning();
  const [tB] = await db.insert(tenants).values({ name: 'Cat T B', slug: 'pcat-b-' + suffix() }).returning();
  tenantAId = tA!.id; tenantBId = tB!.id;
  await setFlag(tenantAId, true);
  await setFlag(tenantBId, true);

  // Tenant A is MULTI-company, so its NULL-company rows must stay hidden.
  const [a1] = await db.insert(companies).values({ tenantId: tenantAId, businessName: 'A One' }).returning();
  const [a2] = await db.insert(companies).values({ tenantId: tenantAId, businessName: 'A Two' }).returning();
  // Tenant B is single-company, so its NULL-company rows are visible.
  const [b1] = await db.insert(companies).values({ tenantId: tenantBId, businessName: 'B One' }).returning();
  ids['a1'] = a1!.id; ids['a2'] = a2!.id; ids['b1'] = b1!.id;

  // Accounts on tenant A: two real categories, plus things a client must
  // never be offered.
  const mk = async (key: string, v: Partial<typeof accounts.$inferInsert> & { name: string; accountType: string }) => {
    const [row] = await db.insert(accounts).values({ tenantId: tenantAId, companyId: ids['a1'], ...v }).returning();
    ids[key] = row!.id;
  };
  await mk('rent', { name: 'Rent', accountType: 'expense', detailType: 'rent' });
  await mk('sales', { name: 'Sales', accountType: 'revenue' });
  await mk('bank', { name: 'Checking', accountType: 'asset', detailType: 'bank' });
  await mk('ar', { name: 'A/R', accountType: 'asset', detailType: 'accounts_receivable' });
  await mk('suspense', { name: 'Uncategorized', accountType: 'other_expense', detailType: 'other_expense', isSystem: true, systemTag: 'suspense' });
  await mk('inactive', { name: 'Old Category', accountType: 'expense', isActive: false });

  // An unclassified bank line on company A1.
  const [conn] = await db.insert(bankConnections).values({
    tenantId: tenantAId, accountId: ids['bank']!, institutionName: 'Test Bank',
  }).returning();
  const today = new Date().toISOString().split('T')[0]!;
  const [item] = await db.insert(bankFeedItems).values({
    tenantId: tenantAId, bankConnectionId: conn!.id, companyId: ids['a1'],
    feedDate: today,
    description: 'MYSTERY VENDOR',
    originalDescription: 'POS DEBIT 1234 MYSTERY VENDOR CARD 9876',
    amount: '42.5000', status: 'pending',
    suggestedAccountId: null, confidenceScore: '0.12', matchType: 'ai',
  }).returning();
  ids['feedItem'] = item!.id;
  await db.insert(transactionClassificationState).values({
    tenantId: tenantAId, companyId: ids['a1'], bankFeedItemId: item!.id,
    bucket: 'needs_review', confidenceScore: '0.120', suggestedAccountId: null,
    reasoningBlob: { secret: 'firm-only reasoning' } as never,
  });

  // An amount already posted to suspense on company A1.
  const [txn] = await db.insert(transactions).values({
    tenantId: tenantAId, companyId: ids['a1'], txnType: 'expense',
    txnDate: today, status: 'posted', memo: 'Unidentified payment',
  }).returning();
  await db.insert(journalLines).values([
    { tenantId: tenantAId, transactionId: txn!.id, accountId: ids['suspense']!, debit: '75.0000', credit: '0' },
    { tenantId: tenantAId, transactionId: txn!.id, accountId: ids['bank']!, debit: '0', credit: '75.0000' },
  ]);
  ids['suspenseTxn'] = txn!.id;

  // A row belonging to the OTHER company in the same tenant.
  const [otherItem] = await db.insert(bankFeedItems).values({
    tenantId: tenantAId, bankConnectionId: conn!.id, companyId: ids['a2'],
    feedDate: today, description: 'A2 ONLY', amount: '9.0000', status: 'pending',
  }).returning();
  ids['a2FeedItem'] = otherItem!.id;
  await db.insert(transactionClassificationState).values({
    tenantId: tenantAId, companyId: ids['a2'], bankFeedItemId: otherItem!.id,
    bucket: 'needs_review', confidenceScore: '0.100', suggestedAccountId: null,
  });

  const mkContact = async (key: string, tenantId: string, companyId: string, categorizeAccess: boolean) => {
    const [c] = await db.insert(portalContacts).values({
      tenantId, email: `${key}-${suffix()}@ex.com`, status: 'active', firstName: key,
    }).returning();
    await db.insert(portalContactCompanies).values({ contactId: c!.id, companyId, categorizeAccess });
    ids[key] = c!.id;
    await mkSession(key, tenantId, c!.id);
  };
  await mkContact('cGranted', tenantAId, ids['a1']!, true);
  await mkContact('cDenied', tenantAId, ids['a1']!, false);
  await mkContact('cTenantB', tenantBId, ids['b1']!, true);
}

async function cleanDb() {
  for (const id of [tenantAId, tenantBId].filter(Boolean)) {
    await db.delete(attachments).where(eq(attachments.tenantId, id));
    await db.delete(clientCategorySuggestions).where(eq(clientCategorySuggestions.tenantId, id));
    await db.delete(portalContactSessions).where(eq(portalContactSessions.tenantId, id));
    const cs = await db.select({ id: portalContacts.id }).from(portalContacts).where(eq(portalContacts.tenantId, id));
    for (const c of cs) await db.delete(portalContactCompanies).where(eq(portalContactCompanies.contactId, c.id));
    await db.delete(portalContacts).where(eq(portalContacts.tenantId, id));
    await db.delete(transactionClassificationState).where(eq(transactionClassificationState.tenantId, id));
    await db.delete(bankFeedItems).where(eq(bankFeedItems.tenantId, id));
    await db.delete(bankConnections).where(eq(bankConnections.tenantId, id));
    await db.delete(journalLines).where(eq(journalLines.tenantId, id));
    await db.delete(transactions).where(eq(transactions.tenantId, id));
    await db.delete(accounts).where(eq(accounts.tenantId, id));
    await db.delete(companies).where(eq(companies.tenantId, id));
    await db.delete(tenantFeatureFlags).where(eq(tenantFeatureFlags.tenantId, id));
    await db.delete(tenants).where(eq(tenants.id, id));
  }
  tenantAId = ''; tenantBId = '';
}

beforeEach(async () => { await cleanDb(); await seed(); await startApp(); });
afterEach(async () => {
  if (server) { await new Promise<void>((r) => server!.close(() => r())); server = null; }
  await cleanDb();
});

describe('portal categorize — access', () => {
  it('401s without a session cookie', async () => {
    const res = await request('GET', `/api/portal/categorize/queue?companyId=${ids['a1']}`);
    expect(res.status).toBe(401);
  });

  it('self-hides (featureEnabled:false) when the tenant flag is off', async () => {
    await setFlag(tenantAId, false);
    const res = await request('GET', `/api/portal/categorize/queue?companyId=${ids['a1']}`, undefined, cookies['cGranted']);
    expect(res.status).toBe(200);
    expect(res.json.featureEnabled).toBe(false);
    expect(res.json.items).toEqual([]);
  });

  it('refuses a WRITE outright when the flag is off, rather than silently dropping it', async () => {
    await setFlag(tenantAId, false);
    const res = await request('POST', '/api/portal/categorize/suggestions', {
      companyId: ids['a1'],
      items: [{ targetKind: 'bank_feed_item', targetId: ids['feedItem'], categoryId: ids['rent'] }],
    }, cookies['cGranted']);
    expect(res.status).toBe(403);
  });

  it('403s a contact without categorize_access', async () => {
    const res = await request('GET', `/api/portal/categorize/queue?companyId=${ids['a1']}`, undefined, cookies['cDenied']);
    expect(res.status).toBe(403);
  });

  it('403s a contact reaching for a company they are not linked to', async () => {
    const res = await request('GET', `/api/portal/categorize/queue?companyId=${ids['a2']}`, undefined, cookies['cGranted']);
    expect(res.status).toBe(403);
  });

  it('403s a cross-tenant company id', async () => {
    const res = await request('GET', `/api/portal/categorize/queue?companyId=${ids['b1']}`, undefined, cookies['cGranted']);
    expect(res.status).toBe(403);
  });

  it('400s without a companyId', async () => {
    const res = await request('GET', '/api/portal/categorize/queue', undefined, cookies['cGranted']);
    expect(res.status).toBe(400);
  });
});

describe('portal categorize — the queue payload', () => {
  it('lists the unclassified line and the suspense amount, and nothing else', async () => {
    const res = await request('GET', `/api/portal/categorize/queue?companyId=${ids['a1']}`, undefined, cookies['cGranted']);
    expect(res.status).toBe(200);
    expect(res.json.featureEnabled).toBe(true);
    const kinds = res.json.items.map((i: any) => i.targetKind).sort();
    expect(kinds).toEqual(['bank_feed_item', 'transaction']);

    // The other company's row in the same tenant is not visible.
    const targetIds = res.json.items.map((i: any) => i.targetId);
    expect(targetIds).not.toContain(ids['a2FeedItem']);
  });

  it('never leaks the raw bank descriptor, the AI guess, or its reasoning', async () => {
    const res = await request('GET', `/api/portal/categorize/queue?companyId=${ids['a1']}`, undefined, cookies['cGranted']);
    const blob = JSON.stringify(res.json);
    expect(blob).not.toContain('POS DEBIT');       // original_description
    expect(blob).not.toContain('firm-only reasoning'); // reasoning_blob
    expect(blob).not.toContain('confidence');
    expect(blob).not.toContain('suggestedAccountId');
    // The cleansed description IS shown — that is what the client recognises.
    expect(blob).toContain('MYSTERY VENDOR');
  });

  it('signs the amount so the client sees money out vs money in', async () => {
    const res = await request('GET', `/api/portal/categorize/queue?companyId=${ids['a1']}`, undefined, cookies['cGranted']);
    const feed = res.json.items.find((i: any) => i.targetKind === 'bank_feed_item');
    expect(feed.amount).toBe('42.50');
    expect(feed.direction).toBe('money_out');
  });
});

describe('portal categorize — the category list', () => {
  it('offers real categories only, with no balances or account numbers', async () => {
    const res = await request('GET', `/api/portal/categorize/categories?companyId=${ids['a1']}`, undefined, cookies['cGranted']);
    expect(res.status).toBe(200);
    const names = res.json.categories.map((c: any) => c.label).sort();
    expect(names).toEqual(['Rent', 'Sales']);

    // No bank, no A/R, no suspense, no inactive account.
    expect(names).not.toContain('Checking');
    expect(names).not.toContain('A/R');
    expect(names).not.toContain('Uncategorized');
    expect(names).not.toContain('Old Category');

    const blob = JSON.stringify(res.json);
    expect(blob).not.toContain('balance');
    expect(blob).not.toContain('accountNumber');
  });
});

describe('portal categorize — submitting', () => {
  it('records a suggestion as pending and posts nothing', async () => {
    const res = await request('POST', '/api/portal/categorize/suggestions', {
      companyId: ids['a1'],
      items: [{ targetKind: 'bank_feed_item', targetId: ids['feedItem'], categoryId: ids['rent'], note: 'office rent' }],
    }, cookies['cGranted']);
    expect(res.status).toBe(201);
    expect(res.json.accepted).toEqual([ids['feedItem']]);

    const [row] = await db.select().from(clientCategorySuggestions)
      .where(eq(clientCategorySuggestions.tenantId, tenantAId));
    expect(row!.status).toBe('pending');
    expect(row!.reviewedAt).toBeNull();
    expect(row!.suggestedLabel).toBe('Rent');
    // Snapshot captured for drift detection.
    expect(Number(row!.snapshotAmount)).toBe(42.5);

    // The bank line is untouched: nothing posted.
    const [item] = await db.select().from(bankFeedItems).where(eq(bankFeedItems.id, ids['feedItem']!));
    expect(item!.status).toBe('pending');
    expect(item!.matchedTransactionId).toBeNull();
  });

  it('refuses an account that is not in the sanitized category list', async () => {
    for (const bad of ['bank', 'ar', 'suspense', 'inactive']) {
      const res = await request('POST', '/api/portal/categorize/suggestions', {
        companyId: ids['a1'],
        items: [{ targetKind: 'bank_feed_item', targetId: ids['feedItem'], categoryId: ids[bad] }],
      }, cookies['cGranted']);
      expect(res.status).toBe(201);
      expect(res.json.accepted).toEqual([]);
      expect(res.json.failed[0].reason).toBe('invalid_category');
    }
  });

  it('reports not_found for another company\'s row instead of confirming it exists', async () => {
    const res = await request('POST', '/api/portal/categorize/suggestions', {
      companyId: ids['a1'],
      items: [{ targetKind: 'bank_feed_item', targetId: ids['a2FeedItem'], categoryId: ids['rent'] }],
    }, cookies['cGranted']);
    expect(res.status).toBe(201);
    expect(res.json.failed[0].reason).toBe('not_found');
  });

  it('requires a note when the client says "not sure"', async () => {
    const res = await request('POST', '/api/portal/categorize/suggestions', {
      companyId: ids['a1'],
      items: [{ targetKind: 'bank_feed_item', targetId: ids['feedItem'], categoryId: 'not_sure' }],
    }, cookies['cGranted']);
    expect(res.json.failed[0].reason).toBe('note_required');
  });

  it('accepts "personal" without exposing an equity account', async () => {
    const res = await request('POST', '/api/portal/categorize/suggestions', {
      companyId: ids['a1'],
      items: [{ targetKind: 'bank_feed_item', targetId: ids['feedItem'], categoryId: 'personal' }],
    }, cookies['cGranted']);
    expect(res.json.accepted).toEqual([ids['feedItem']]);
    const [row] = await db.select().from(clientCategorySuggestions)
      .where(eq(clientCategorySuggestions.tenantId, tenantAId));
    expect(row!.isPersonal).toBe(true);
    expect(row!.suggestedAccountId).toBeNull();
  });

  it('supersedes an earlier answer rather than duplicating it', async () => {
    const body = (cat: string) => ({
      companyId: ids['a1'],
      items: [{ targetKind: 'bank_feed_item', targetId: ids['feedItem'], categoryId: cat }],
    });
    await request('POST', '/api/portal/categorize/suggestions', body(ids['rent']!), cookies['cGranted']);
    await request('POST', '/api/portal/categorize/suggestions', body(ids['sales']!), cookies['cGranted']);

    const rows = await db.select().from(clientCategorySuggestions)
      .where(eq(clientCategorySuggestions.tenantId, tenantAId));
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.status === 'pending')).toHaveLength(1);
    expect(rows.filter((r) => r.status === 'superseded')).toHaveLength(1);
    expect(rows.find((r) => r.status === 'pending')!.suggestedLabel).toBe('Sales');
  });

  it('lets the client suggest against an amount already in suspense', async () => {
    const res = await request('POST', '/api/portal/categorize/suggestions', {
      companyId: ids['a1'],
      items: [{ targetKind: 'transaction', targetId: ids['suspenseTxn'], categoryId: ids['rent'] }],
    }, cookies['cGranted']);
    expect(res.json.accepted).toEqual([ids['suspenseTxn']]);
  });

  it('shows the client their own history with the outcome', async () => {
    await request('POST', '/api/portal/categorize/suggestions', {
      companyId: ids['a1'],
      items: [{ targetKind: 'bank_feed_item', targetId: ids['feedItem'], categoryId: ids['rent'] }],
    }, cookies['cGranted']);
    const res = await request('GET', `/api/portal/categorize/history?companyId=${ids['a1']}`, undefined, cookies['cGranted']);
    expect(res.status).toBe(200);
    expect(res.json.total).toBe(1);
    expect(res.json.rows[0].status).toBe('pending');
  });
});

// ── Attachments ─────────────────────────────────────────────────
//
// The load-bearing assertions here are the same negative ones as the rest of
// the file: a client must not attach to a row it was never shown, must not
// choose the storage key, and must not see or delete the firm's own files.

describe('portal categorize — attachments', () => {
  const upload = (targetKind: string, targetId: string, cookie: string, companyId = ids['a1']!) =>
    multipart('/api/portal/categorize/attachments',
      { companyId, targetKind, targetId },
      [{ field: 'files', filename: 'receipt.png', contentType: 'image/png', body: PNG_1PX }],
      cookie);

  it('files an upload under the key the STAFF screen reads for a bank line', async () => {
    const res = await upload('bank_feed_item', ids['feedItem']!, cookies['cGranted']!);
    expect(res.status).toBe(201);
    expect(res.json.attachments).toHaveLength(1);

    const [row] = await db.select().from(attachments)
      .where(eq(attachments.tenantId, tenantAId));
    // Plural, and exactly what uncategorized.routes.ts counts for /unposted.
    expect(row!.attachableType).toBe('bank_feed_items');
    expect(row!.attachableId).toBe(ids['feedItem']);
    expect(row!.uploadedByContactId).toBe(ids['cGranted']);
    expect(row!.companyId).toBe(ids['a1']);
    expect(row!.fileName).toBe('receipt.png');
  });

  it("files a suspense row's upload under the transaction's OWN txn_type", async () => {
    const res = await upload('transaction', ids['suspenseTxn']!, cookies['cGranted']!);
    expect(res.status).toBe(201);

    const [row] = await db.select().from(attachments)
      .where(eq(attachments.tenantId, tenantAId));
    // NOT the generic 'transaction' — that would hide it from the staff
    // screen, which matches on t.txn_type.
    expect(row!.attachableType).toBe('expense');
    expect(row!.attachableId).toBe(ids['suspenseTxn']);
  });

  it('refuses a target that is not in this client\'s queue', async () => {
    // Same tenant, the OTHER company's bank line.
    const res = await upload('bank_feed_item', ids['a2FeedItem']!, cookies['cGranted']!);
    expect(res.status).toBe(404);
    const rows = await db.select().from(attachments).where(eq(attachments.tenantId, tenantAId));
    expect(rows).toHaveLength(0);
  });

  it('refuses a contact without the categorize grant', async () => {
    const res = await upload('bank_feed_item', ids['feedItem']!, cookies['cDenied']!);
    expect(res.status).toBe(403);
  });

  it('refuses a contact from another tenant', async () => {
    const res = await upload('bank_feed_item', ids['feedItem']!, cookies['cTenantB']!);
    // Its own company id is required, so it cannot even name company a1.
    expect([403, 404]).toContain(res.status);
  });

  it('rejects a file whose bytes do not match its declared type', async () => {
    const res = await multipart('/api/portal/categorize/attachments',
      { companyId: ids['a1']!, targetKind: 'bank_feed_item', targetId: ids['feedItem']! },
      [{ field: 'files', filename: 'fake.png', contentType: 'image/png', body: Buffer.from('not a png at all') }],
      cookies['cGranted']!);
    expect(res.status).toBe(400);
    expect(String(res.json.error.message)).toContain('fake.png');
  });

  it('rejects a disallowed type with a 400, not a 500', async () => {
    const res = await multipart('/api/portal/categorize/attachments',
      { companyId: ids['a1']!, targetKind: 'bank_feed_item', targetId: ids['feedItem']! },
      [{ field: 'files', filename: 'sheet.xlsx', contentType: 'application/vnd.ms-excel', body: PNG_1PX }],
      cookies['cGranted']!);
    expect(res.status).toBe(400);
  });

  it('lists back only the CLIENT\'s files, never the firm\'s', async () => {
    await upload('bank_feed_item', ids['feedItem']!, cookies['cGranted']!);
    // A staff-uploaded file on the same row: uploaded_by_contact_id NULL.
    await db.insert(attachments).values({
      tenantId: tenantAId, fileName: 'FIRM-ONLY-audit-notice.pdf',
      filePath: '/uploads/x', attachableType: 'bank_feed_items',
      attachableId: ids['feedItem']!, mimeType: 'application/pdf',
    });

    const res = await request(
      'GET',
      `/api/portal/categorize/attachments?companyId=${ids['a1']}&targetKind=bank_feed_item&targetId=${ids['feedItem']}`,
      undefined, cookies['cGranted'],
    );
    expect(res.status).toBe(200);
    expect(res.json.attachments).toHaveLength(1);
    expect(JSON.stringify(res.json)).not.toContain('FIRM-ONLY');
    // No storage key or path ever reaches the client.
    expect(JSON.stringify(res.json)).not.toContain('storageKey');
    expect(JSON.stringify(res.json)).not.toContain('/uploads/');
  });

  it('counts the client\'s own files on the queue row', async () => {
    await upload('bank_feed_item', ids['feedItem']!, cookies['cGranted']!);
    const res = await request('GET', `/api/portal/categorize/queue?companyId=${ids['a1']}`, undefined, cookies['cGranted']);
    const feed = res.json.items.find((i: any) => i.targetKind === 'bank_feed_item');
    expect(feed.myAttachmentCount).toBe(1);
    const txn = res.json.items.find((i: any) => i.targetKind === 'transaction');
    expect(txn.myAttachmentCount).toBe(0);
  });

  it('lets a client remove its own file but not the firm\'s', async () => {
    const up = await upload('bank_feed_item', ids['feedItem']!, cookies['cGranted']!);
    const mine = up.json.attachments[0].id;

    const [firm] = await db.insert(attachments).values({
      tenantId: tenantAId, fileName: 'firm.pdf', filePath: '/uploads/y',
      attachableType: 'bank_feed_items', attachableId: ids['feedItem']!,
    }).returning();

    const bad = await request('DELETE', `/api/portal/categorize/attachments/${firm!.id}`, undefined, cookies['cGranted']);
    expect(bad.status).toBe(404);

    const ok = await request('DELETE', `/api/portal/categorize/attachments/${mine}`, undefined, cookies['cGranted']);
    expect(ok.status).toBe(200);

    const left = await db.select().from(attachments).where(eq(attachments.tenantId, tenantAId));
    expect(left).toHaveLength(1);
    expect(left[0]!.fileName).toBe('firm.pdf');
  });

  it('refuses uploads outright when the tenant flag is off', async () => {
    await setFlag(tenantAId, false);
    const res = await upload('bank_feed_item', ids['feedItem']!, cookies['cGranted']!);
    expect(res.status).toBe(403);
    expect(res.json.error.code).toBe('FEATURE_DISABLED');
  });
});
