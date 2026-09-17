// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Portal side of AP Bill Capture: the per-contact bill_upload_access grant,
// the tenant flag, the coarse amount-free list, the staff email on upload,
// and isolation between contacts. Seeding mirrors portal-bills-public.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import 'express-async-errors';
import express from 'express';
import http from 'http';
import crypto from 'crypto';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { eq, inArray } from 'drizzle-orm';
import { db, pool } from '../db/index.js';
import {
  tenants, users, companies, portalContacts, portalContactCompanies,
  portalContactSessions, portalSettingsPerCompany, tenantFeatureFlags,
  billCaptures, attachments, auditLog as auditLogTable,
} from '../db/schema/index.js';
import { portalBillCapturesPublicRouter } from './portal-bill-captures-public.routes.js';
import { errorHandler } from '../middleware/error-handler.js';
import * as systemEmail from '../services/system-email.service.js';

vi.mock('../services/system-email.service.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../services/system-email.service.js')>();
  return { ...mod, sendActionEmail: vi.fn(async () => {}) };
});
const sendActionEmailMock = vi.mocked(systemEmail.sendActionEmail);

let server: Server | null = null;
let port = 0;
let tenantId = '';
const ids: Record<string, string> = {};
const cookies: Record<string, string> = {};
const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n');

interface Resp { status: number; json: any }

function request(method: string, pathname: string, cookie?: string, body?: Buffer, contentType = 'application/json'): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port, path: pathname, method,
      headers: {
        ...(body ? { 'Content-Type': contentType, 'Content-Length': body.length } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
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
    if (body) req.write(body);
    req.end();
  });
}

function multipart(companyId: string, files: Array<{ name: string; data: Buffer }>): { body: Buffer; contentType: string } {
  const boundary = `----vitest${Date.now()}`;
  const parts: Buffer[] = [Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="companyId"\r\n\r\n${companyId}\r\n`)];
  for (const f of files) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${f.name}"\r\nContent-Type: application/pdf\r\n\r\n`));
    parts.push(f.data, Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

const cookie = (key: string) => `kisbooks_portal_session=${cookies[key]}`;
const list = (key: string, companyId = ids['co']!) => request('GET', `/api/portal/bill-captures?companyId=${companyId}`, cookie(key));
const upload = (key: string, files: Array<{ name: string; data: Buffer }>, companyId = ids['co']!) => {
  const m = multipart(companyId, files);
  return request('POST', '/api/portal/bill-captures/upload', cookie(key), m.body, m.contentType);
};

async function setFlag(enabled: boolean) {
  await db.insert(tenantFeatureFlags)
    .values({ tenantId, flagKey: 'AP_BILL_CAPTURE_V1', enabled, rolloutPercent: enabled ? 100 : 0 })
    .onConflictDoUpdate({ target: [tenantFeatureFlags.tenantId, tenantFeatureFlags.flagKey], set: { enabled } });
}

async function seed() {
  const suffix = () => Date.now() + '-' + Math.random().toString(36).slice(2, 6);
  const [t] = await db.insert(tenants).values({ name: 'Capture T', slug: 'pcap-' + suffix() }).returning();
  tenantId = t!.id;
  const [co] = await db.insert(companies).values({ tenantId, businessName: 'Capture Co' }).returning();
  ids['co'] = co!.id;
  const mkUser = async (key: string, role: string) => {
    const [u] = await db.insert(users).values({
      tenantId, email: `${key}-${suffix()}@ex.com`, passwordHash: 'x', displayName: key, role, isActive: true, isSuperAdmin: false,
    }).returning();
    ids[key] = u!.id;
  };
  await mkUser('owner', 'owner');
  await mkUser('staff', 'bookkeeper');
  const mkContact = async (key: string, billUploadAccess: boolean) => {
    const [c] = await db.insert(portalContacts).values({
      tenantId, email: `${key}-${suffix()}@ex.com`, firstName: 'Pat', lastName: key, status: 'active',
    }).returning();
    await db.insert(portalContactCompanies).values({ contactId: c!.id, companyId: ids['co']!, billUploadAccess });
    ids[key] = c!.id;
    const token = crypto.randomBytes(32).toString('hex');
    await db.insert(portalContactSessions).values({
      tenantId, contactId: c!.id,
      tokenHash: crypto.createHash('sha256').update(token).digest('hex'),
      expiresAt: new Date(Date.now() + 3600_000),
    });
    cookies[key] = token;
  };
  await mkContact('granted', true);
  await mkContact('granted2', true);
  await mkContact('denied', false);
  await db.insert(portalSettingsPerCompany).values({ companyId: ids['co']!, billPayNotifyUserId: ids['staff'] });
}

async function cleanDb() {
  if (!tenantId) return;
  await db.delete(billCaptures).where(eq(billCaptures.tenantId, tenantId));
  await db.delete(attachments).where(eq(attachments.tenantId, tenantId));
  await db.delete(portalContactSessions).where(eq(portalContactSessions.tenantId, tenantId));
  const contactRows = await db.select({ id: portalContacts.id }).from(portalContacts).where(eq(portalContacts.tenantId, tenantId));
  if (contactRows.length) await db.delete(portalContactCompanies).where(inArray(portalContactCompanies.contactId, contactRows.map((c) => c.id)));
  await db.delete(portalContacts).where(eq(portalContacts.tenantId, tenantId));
  await db.delete(portalSettingsPerCompany).where(eq(portalSettingsPerCompany.companyId, ids['co']!));
  await db.delete(auditLogTable).where(eq(auditLogTable.tenantId, tenantId));
  await db.delete(tenantFeatureFlags).where(eq(tenantFeatureFlags.tenantId, tenantId));
  await db.delete(users).where(eq(users.tenantId, tenantId));
  await db.delete(companies).where(eq(companies.tenantId, tenantId));
  await db.delete(tenants).where(eq(tenants.id, tenantId));
}

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/portal/bill-captures', portalBillCapturesPublicRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => { port = (server!.address() as AddressInfo).port; resolve(); });
  });
  await seed();
}, 30000);

afterAll(async () => {
  await new Promise<void>((r) => server?.close(() => r()));
  await cleanDb();
  await pool.end();
});

describe('portal bill captures', () => {
  it('reports featureEnabled=false (not 403) while the flag is off, and refuses uploads', async () => {
    await setFlag(false);
    const r = await list('granted');
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ featureEnabled: false, captures: [] });
    const up = await upload('granted', [{ name: 'a.pdf', data: PDF }]);
    expect(up.status).toBe(403);
  });

  it('403s a contact without the grant once the flag is on', async () => {
    await setFlag(true);
    expect((await list('denied')).status).toBe(403);
    expect((await list('denied')).json.error.code).toBe('BILL_UPLOAD_NOT_ENABLED');
    expect((await upload('denied', [{ name: 'a.pdf', data: PDF }])).status).toBe(403);
  });

  it('401s without a session', async () => {
    expect((await request('GET', `/api/portal/bill-captures?companyId=${ids['co']}`)).status).toBe(401);
  });

  it('uploads, emails the bill-pay notify user once, and lists a coarse amount-free row', async () => {
    sendActionEmailMock.mockClear();
    const up = await upload('granted', [{ name: 'water-bill.pdf', data: PDF }, { name: 'power.pdf', data: Buffer.concat([PDF, Buffer.from('2')]) }]);
    expect(up.status).toBe(201);
    expect(up.json.captures).toHaveLength(2);
    expect(up.json.captures.every((c: any) => c.status === 'received' && c.duplicate === false)).toBe(true);
    // Notification is fire-and-forget; give it a tick.
    await new Promise((r) => setTimeout(r, 50));
    expect(sendActionEmailMock).toHaveBeenCalledTimes(1);
    const call = sendActionEmailMock.mock.calls[0]![0] as { to: string; subject: string };
    expect(call.subject).toContain('2 bills uploaded');

    const r = await list('granted');
    expect(r.json.featureEnabled).toBe(true);
    expect(r.json.captures).toHaveLength(2);
    const row = r.json.captures[0];
    expect(Object.keys(row).sort()).toEqual(['createdAt', 'enteredAt', 'fileName', 'id', 'status']);
    // AI is off in tests, so the row is 'ready' internally — the client only sees "processing".
    expect(['received', 'processing']).toContain(row.status);

    const staffRow = await db.query.billCaptures.findFirst({ where: eq(billCaptures.id, row.id) });
    expect(staffRow).toMatchObject({ source: 'portal', uploadedByContactId: ids['granted'], companyId: ids['co'] });
  });

  it('re-uploading the same file reports duplicate and sends no second email', async () => {
    sendActionEmailMock.mockClear();
    const up = await upload('granted', [{ name: 'water-bill.pdf', data: PDF }]);
    expect(up.status).toBe(201);
    expect(up.json.captures[0].duplicate).toBe(true);
    await new Promise((r) => setTimeout(r, 50));
    expect(sendActionEmailMock).not.toHaveBeenCalled();
  });

  it('shows each contact only their own uploads', async () => {
    expect((await list('granted2')).json.captures).toHaveLength(0);
  });

  it('rejects an upload for a company the contact is not linked to', async () => {
    const [other] = await db.insert(companies).values({ tenantId, businessName: 'Unlinked Co' }).returning();
    const r = await upload('granted', [{ name: 'x.pdf', data: PDF }], other!.id);
    expect(r.status).toBe(403);
    await db.delete(companies).where(eq(companies.id, other!.id));
  });
});
