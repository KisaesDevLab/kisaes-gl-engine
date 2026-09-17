// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Route-level coverage for AP Bill Capture (/api/v1/bill-captures). AI is
// off in the test environment, so every upload lands `ready` with
// extraction_skipped_reason 'ai_disabled' — which is exactly the manual
// queue path — and the tests exercise upload, dedupe, list, detail, file
// streaming, enter (new vendor + duplicate + already-entered), discard and
// tenant isolation without touching an OCR engine.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import 'express-async-errors';
import express from 'express';
import http from 'http';
import type { AddressInfo, Server } from 'net';
import { and, eq, sql } from 'drizzle-orm';
import { db, pool } from '../db/index.js';
import { attachments, billCaptures, contacts, transactions } from '../db/schema/index.js';
import * as authService from '../services/auth.service.js';
import * as flags from '../services/feature-flags.service.js';
import { billCapturesRouter } from './bill-captures.routes.js';
import { errorHandler } from '../middleware/error-handler.js';

let server: Server | null = null;
let port = 0;
let token = '';
let otherToken = '';
let tenantId = '';
let otherTenantId = '';
let expenseAccountId = '';

const PDF_A = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n');
const PDF_B = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n%%EOF\n');
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);

async function cleanDb() {
  await db.execute(sql`TRUNCATE
    audit_log, journal_lines, transaction_tags, payment_applications, deposit_lines,
    bill_captures, attachments, ai_jobs,
    transactions, contacts, items, tags, tag_groups, api_keys, sessions,
    tenant_feature_flags, accounts, companies, users, tenants
    CASCADE`);
}

interface Resp { status: number; headers: http.IncomingHttpHeaders; body: string; json: any }

function raw(method: string, path: string, opts: { bearer?: string; body?: Buffer; contentType?: string } = {}): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      method, hostname: '127.0.0.1', port, path: `/api/v1/bill-captures${path}`,
      headers: {
        Authorization: `Bearer ${opts.bearer ?? token}`,
        ...(opts.body ? { 'Content-Type': opts.contentType ?? 'application/json', 'Content-Length': opts.body.length } : {}),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        let json: any = null;
        try { json = body ? JSON.parse(body) : null; } catch { /* not json */ }
        resolve({ status: res.statusCode!, headers: res.headers, body, json });
      });
    });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

const get = (path: string, bearer?: string) => raw('GET', path, { bearer });
const post = (path: string, body?: unknown, bearer?: string) =>
  raw('POST', path, { bearer, body: body === undefined ? undefined : Buffer.from(JSON.stringify(body)) });

function multipart(files: Array<{ name: string; type: string; data: Buffer }>): { body: Buffer; contentType: string } {
  const boundary = `----vitest${Date.now()}`;
  const parts: Buffer[] = [];
  for (const f of files) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${f.name}"\r\nContent-Type: ${f.type}\r\n\r\n`));
    parts.push(f.data);
    parts.push(Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

const upload = (files: Array<{ name: string; type: string; data: Buffer }>, bearer?: string) => {
  const m = multipart(files);
  return raw('POST', '', { bearer, body: m.body, contentType: m.contentType });
};

beforeAll(async () => {
  await cleanDb();
  const app = express();
  app.use(express.json());
  app.use('/api/v1/bill-captures', billCapturesRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => { port = (server!.address() as AddressInfo).port; resolve(); });
  });

  const stamp = Date.now();
  const me = await authService.register({
    email: `capture-${stamp}@example.com`, password: 'password123456', displayName: 'Capture Test', companyName: 'Capture Co',
  });
  token = me.tokens.accessToken;
  tenantId = me.user.tenantId;
  const other = await authService.register({
    email: `capture-other-${stamp}@example.com`, password: 'password123456', displayName: 'Other', companyName: 'Other Co',
  });
  otherToken = other.tokens.accessToken;
  otherTenantId = other.user.tenantId;
  await flags.setFlag(otherTenantId, 'AP_BILL_CAPTURE_V1', { enabled: true });

  const acct = await db.query.accounts.findFirst({ where: (a, { eq: e, and: a2 }) => a2(e(a.tenantId, tenantId), e(a.accountType, 'expense')) });
  expenseAccountId = acct!.id;
}, 30000);

afterAll(async () => {
  await new Promise<void>((r) => server?.close(() => r()));
  await cleanDb();
  await pool.end();
});

describe('feature flag gate', () => {
  it('404s every route while AP_BILL_CAPTURE_V1 is off', async () => {
    expect((await get('')).status).toBe(404);
    expect((await upload([{ name: 'a.pdf', type: 'application/pdf', data: PDF_A }])).status).toBe(404);
    await flags.setFlag(tenantId, 'AP_BILL_CAPTURE_V1', { enabled: true });
    expect((await get('')).status).toBe(200);
  });
});

describe('upload + queue', () => {
  let firstId = '';
  let secondId = '';

  it('creates one capture per file, ready for manual keying when AI is off', async () => {
    const r = await upload([
      { name: 'acme-1001.pdf', type: 'application/pdf', data: PDF_A },
      { name: 'photo.png', type: 'image/png', data: PNG },
    ]);
    expect(r.status).toBe(201);
    expect(r.json.captures).toHaveLength(2);
    expect(r.json.captures.every((c: any) => c.duplicate === false)).toBe(true);
    firstId = r.json.captures[0].id;
    secondId = r.json.captures[1].id;

    const list = await get('');
    expect(list.json.total).toBe(2);
    expect(list.json.counts.ready).toBe(2);
    const row = list.json.captures.find((c: any) => c.id === firstId);
    expect(row.status).toBe('ready');
    expect(row.extractionSkippedReason).toBe('ai_disabled');
    expect(row.source).toBe('staff');
    expect(row.uploadedByName).toBe('Capture Test');
    expect(row.mimeType).toBe('application/pdf');

    // The file is filed under the capture, not the receipts inbox.
    const att = await db.query.attachments.findFirst({ where: and(eq(attachments.tenantId, tenantId), eq(attachments.attachableId, firstId)) });
    expect(att?.attachableType).toBe('bill_capture');
  });

  it('returns the existing capture for the same bytes instead of a second row', async () => {
    const r = await upload([{ name: 'acme-1001-again.pdf', type: 'application/pdf', data: PDF_A }]);
    expect(r.status).toBe(201);
    expect(r.json.captures[0]).toMatchObject({ id: firstId, duplicate: true });
    expect((await get('')).json.total).toBe(2);
  });

  it('rejects unsupported types and empty uploads', async () => {
    const bad = await upload([{ name: 'x.csv', type: 'text/csv', data: Buffer.from('a,b\n') }]);
    expect(bad.status).toBe(400);
    expect((await upload([])).status).toBe(400);
  });

  it('filters by status and honours pagination', async () => {
    const r = await get('?status=entered');
    expect(r.json.total).toBe(0);
    const page = await get('?limit=1&offset=1');
    expect(page.json.captures).toHaveLength(1);
    expect(page.json.total).toBe(2);
    expect((await get('?status=bogus')).status).toBe(400);
  });

  it('detail carries nextReadyId and no vendor defaults when nothing was read', async () => {
    const r = await get(`/${firstId}`);
    expect(r.status).toBe(200);
    expect(r.json.capture.extraction).toBeNull();
    expect(r.json.capture.vendorDefaults).toBeNull();
    expect(r.json.capture.vendorCandidates).toEqual([]);
    expect(r.json.nextReadyId).toBe(secondId);
    expect((await get('/00000000-0000-0000-0000-000000000000')).status).toBe(404);
  });

  it('streams the document inline', async () => {
    const r = await get(`/${firstId}/file`);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toContain('application/pdf');
    expect(r.headers['content-disposition']).toContain('inline');
    expect(r.body.startsWith('%PDF-1.4')).toBe(true);
  });

  it('is invisible to another tenant', async () => {
    expect((await get('', otherToken)).json.total).toBe(0);
    expect((await get(`/${firstId}`, otherToken)).status).toBe(404);
    expect((await get(`/${firstId}/file`, otherToken)).status).toBe(404);
  });

  it('reprocess is refused while AI is off (nothing to re-read with)', async () => {
    const r = await post(`/${firstId}/reprocess`);
    expect(r.status).toBe(400);
  });
});

describe('enter', () => {
  let captureA = '';
  let captureB = '';
  let vendorId = '';
  let billId = '';

  beforeAll(async () => {
    const r = await upload([
      { name: 'enter-a.pdf', type: 'application/pdf', data: Buffer.concat([PDF_B, Buffer.from('A')]) },
      { name: 'enter-b.pdf', type: 'application/pdf', data: Buffer.concat([PDF_B, Buffer.from('B')]) },
    ]);
    captureA = r.json.captures[0].id;
    captureB = r.json.captures[1].id;
  });

  it('rejects a body with neither contactId nor newVendor', async () => {
    const r = await post(`/${captureA}/enter`, {
      txnDate: '2026-09-01', linesMode: 'single',
      lines: [{ accountId: expenseAccountId, amount: '120.00' }],
    });
    expect(r.status).toBe(400);
  });

  it('creates the vendor, posts the bill, relinks the file and remembers the lines mode', async () => {
    const r = await post(`/${captureA}/enter`, {
      newVendor: { displayName: 'Acme Supplies', billingLine1: '1 Main St', billingCity: 'Springfield', billingState: 'IL', billingZip: '62701' },
      txnDate: '2026-09-01',
      paymentTerms: 'net_30',
      vendorInvoiceNumber: 'INV-1001',
      linesMode: 'single',
      lines: [{ accountId: expenseAccountId, description: 'Supplies', amount: '120.00' }],
    });
    expect(r.status).toBe(201);
    billId = r.json.bill.id;
    vendorId = r.json.createdVendorId;
    expect(r.json.capture.status).toBe('entered');
    expect(r.json.capture.billId).toBe(billId);

    const vendor = await db.query.contacts.findFirst({ where: and(eq(contacts.tenantId, tenantId), eq(contacts.id, vendorId)) });
    expect(vendor).toMatchObject({ displayName: 'Acme Supplies', contactType: 'vendor', billingCity: 'Springfield', billLinesMode: 'single' });

    const bill = await db.query.transactions.findFirst({ where: and(eq(transactions.tenantId, tenantId), eq(transactions.id, billId)) });
    expect(bill).toMatchObject({ txnType: 'bill', contactId: vendorId, vendorInvoiceNumber: 'INV-1001' });
    expect(Number(bill!.total)).toBeCloseTo(120, 2);
    expect(bill!.dueDate).toBe('2026-10-01');

    const att = await db.query.attachments.findFirst({ where: and(eq(attachments.tenantId, tenantId), eq(attachments.attachableId, billId)) });
    expect(att?.attachableType).toBe('bill');

    const cap = await db.query.billCaptures.findFirst({ where: eq(billCaptures.id, captureA) });
    expect(cap?.enteredAt).toBeTruthy();
  });

  it('refuses to enter the same capture twice', async () => {
    const r = await post(`/${captureA}/enter`, {
      contactId: vendorId, txnDate: '2026-09-01', linesMode: 'detailed',
      lines: [{ accountId: expenseAccountId, amount: '1.00' }],
    });
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe('BILL_CAPTURE_ALREADY_ENTERED');
    expect(r.json.error.details.billId).toBe(billId);
  });

  it('flags a duplicate invoice number and posts when overridden', async () => {
    const body = {
      contactId: vendorId, txnDate: '2026-09-02', vendorInvoiceNumber: 'inv-1001 ', linesMode: 'detailed',
      lines: [{ accountId: expenseAccountId, amount: '50.00' }, { accountId: expenseAccountId, amount: '25.00' }],
    };
    const dup = await post(`/${captureB}/enter`, body);
    expect(dup.status).toBe(409);
    expect(dup.json.error.code).toBe('BILL_CAPTURE_DUPLICATE');
    expect(dup.json.error.details).toMatchObject({ transactionId: billId, matchedOn: 'invoice_number' });

    const ok = await post(`/${captureB}/enter`, { ...body, overrideDuplicate: true });
    expect(ok.status).toBe(201);
    const vendor = await db.query.contacts.findFirst({ where: eq(contacts.id, vendorId) });
    expect(vendor?.billLinesMode).toBe('detailed');
    const list = await get('?status=entered');
    expect(list.json.total).toBe(2);
    expect(list.json.captures.every((c: any) => c.billTxnNumber)).toBe(true);
  });

  it('matches a duplicate on total + date when the invoice number differs', async () => {
    const r = await upload([{ name: 'enter-c.pdf', type: 'application/pdf', data: Buffer.concat([PDF_B, Buffer.from('C')]) }]);
    const captureC = r.json.captures[0].id;
    const dup = await post(`/${captureC}/enter`, {
      contactId: vendorId, txnDate: '2026-09-01', vendorInvoiceNumber: 'OTHER', linesMode: 'single',
      lines: [{ accountId: expenseAccountId, amount: '120.00' }],
    });
    expect(dup.status).toBe(409);
    expect(dup.json.error.details.matchedOn).toBe('total_date');
  });
});

describe('discard', () => {
  it('refuses an entered capture, soft-discards a fresh one, and allows the same file again afterwards', async () => {
    const entered = (await get('?status=entered')).json.captures[0].id;
    expect((await post(`/${entered}/discard`)).status).toBe(409);

    const up = await upload([{ name: 'discard-me.pdf', type: 'application/pdf', data: Buffer.concat([PDF_B, Buffer.from('D')]) }]);
    const id = up.json.captures[0].id;
    const r = await post(`/${id}/discard`);
    expect(r.status).toBe(200);
    expect(r.json.capture.status).toBe('discarded');
    expect((await get(`/${id}/file`)).status).toBe(200); // file kept

    const again = await upload([{ name: 'discard-me.pdf', type: 'application/pdf', data: Buffer.concat([PDF_B, Buffer.from('D')]) }]);
    expect(again.json.captures[0].duplicate).toBe(false);
    expect(again.json.captures[0].id).not.toBe(id);
  });
});
