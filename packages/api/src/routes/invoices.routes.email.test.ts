// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// Invoice email and the Outbox (ClientLedger P20 E4, U-127 invoice-email-v1),
// through the HTTP routes and, for desktop mode, the service. nodemailer is
// replaced (vi.mock): no network, every message is captured, and a send can
// be made to fail. Covers: send + send event in one commit, nothing recorded
// on failure, SMTP_NOT_CONFIGURED / SMTP_SEND_FAILED, the session password in
// desktop mode, Idempotency-Key, the 10 MB PDF, void and other-tenant
// refusals, the Outbox (email-later, list, send with outboxId, delete),
// company scope, and that no address reaches a log line or an audit row.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  created: [] as Array<Record<string, any>>,
  sent: [] as Array<Record<string, any>>,
  fail: null as null | (Error & { code?: string }),
}));
vi.mock('nodemailer', () => ({
  default: {
    createTransport: (opts: Record<string, unknown>) => {
      mocks.created.push(opts);
      return {
        options: opts,
        verify: async () => true,
        sendMail: async (mail: Record<string, unknown>) => {
          if (mocks.fail) throw mocks.fail;
          mocks.sent.push(mail);
          return { messageId: 'm-' + mocks.sent.length };
        },
      };
    },
  },
}));

import 'express-async-errors';
import express from 'express';
import http from 'http';
import os from 'node:os';
import path from 'node:path';
import crypto from 'crypto';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  tenants, users, userTenantAccess, sessions, companies, accounts, auditLog, transactions, journalLines,
  contacts, userPermissions, idempotencyKeys, documentSendEvents, formEmailQueue, transactionTags,
} from '../db/schema/index.js';
import { invoicesRouter, invoiceEmailJson } from './invoices.routes.js';
import { formsRouter } from './forms.routes.js';
import { errorHandler } from '../middleware/error-handler.js';
import * as authService from '../services/auth.service.js';
import * as invoiceEmail from '../services/invoice-email.service.js';
import { DESKTOP_CAPABILITIES } from '../desktop/capabilities.js';
import { loadDesktopProfile, _resetDesktopProfileForTests } from '../desktop/profile.js';
import * as secrets from '../desktop/session-secrets.js';

let server: Server | null = null;
let port = 0;
const tenantIds: string[] = [];
const suffix = () => Date.now() + '-' + Math.random().toString(36).slice(2, 6);

interface Res { status: number; json: any; headers: http.IncomingHttpHeaders }

function request(method: string, pathname: string, token: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? Buffer.from(JSON.stringify(body)) : undefined;
    const req = http.request({
      hostname: '127.0.0.1', port, path: pathname, method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...(data ? { 'Content-Length': String(data.length) } : {}),
        ...headers,
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (ch) => chunks.push(ch));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json: any = null;
        try { json = text ? JSON.parse(text) : null; } catch { json = text; }
        resolve({ status: res.statusCode ?? 0, json, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function cleanTenant(tid: string) {
  await db.delete(formEmailQueue).where(eq(formEmailQueue.tenantId, tid));
  await db.delete(documentSendEvents).where(eq(documentSendEvents.tenantId, tid));
  await db.delete(idempotencyKeys).where(eq(idempotencyKeys.tenantId, tid));
  await db.delete(transactionTags).where(eq(transactionTags.tenantId, tid));
  await db.delete(auditLog).where(eq(auditLog.tenantId, tid));
  await db.delete(journalLines).where(eq(journalLines.tenantId, tid));
  await db.delete(transactions).where(eq(transactions.tenantId, tid));
  await db.delete(contacts).where(eq(contacts.tenantId, tid));
  await db.delete(accounts).where(eq(accounts.tenantId, tid));
  await db.delete(companies).where(eq(companies.tenantId, tid));
  const staff = await db.select({ id: users.id }).from(users).where(eq(users.tenantId, tid));
  if (staff.length) await db.delete(sessions).where(inArray(sessions.userId, staff.map((u) => u.id)));
  await db.delete(userPermissions).where(eq(userPermissions.tenantId, tid));
  await db.delete(userTenantAccess).where(eq(userTenantAccess.tenantId, tid));
  await db.delete(users).where(eq(users.tenantId, tid));
  await db.delete(tenants).where(eq(tenants.id, tid));
}

interface Co { tenantId: string; token: string; companyId: string; userId: string; revenue: string; customer: string }

const SMTP = { smtpHost: 'mail.example.test', smtpPort: 587, smtpUser: 'owner', smtpPass: 'stored-pass', smtpFrom: 'billing@example.test', smtpFromName: 'Monett Landscapes' };

async function makeCompany(smtp: Partial<typeof SMTP> | null = SMTP): Promise<Co> {
  const reg = await authService.register({
    email: `inv-email-${suffix()}@example.com`, password: 'password123', displayName: 'Owner', companyName: 'Monett Landscapes',
  });
  const tenantId = reg.user.tenantId;
  tenantIds.push(tenantId);
  const [company] = await db.select().from(companies).where(eq(companies.tenantId, tenantId)).limit(1);
  if (smtp) await db.update(companies).set(smtp).where(eq(companies.id, company!.id));
  const revenue = await db.query.accounts.findFirst({ where: and(eq(accounts.tenantId, tenantId), eq(accounts.accountType, 'revenue')) });
  const [customer] = await db.insert(contacts).values({ tenantId, contactType: 'customer', displayName: 'Hartley Residence' }).returning();
  return { tenantId, token: reg.tokens.accessToken, companyId: company!.id, userId: reg.user.id, revenue: revenue!.id, customer: customer!.id };
}

let c: Co;
let logged: string[] = [];
const spies: Array<ReturnType<typeof vi.spyOn>> = [];

beforeEach(async () => {
  mocks.created.length = 0;
  mocks.sent.length = 0;
  mocks.fail = null;
  logged = [];
  for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    spies.push(vi.spyOn(console, m).mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(' ')); }));
  }
  const app = express();
  app.use(invoiceEmailJson);
  app.use(express.json({ limit: '10mb' }));
  app.use('/api/v1/invoices', invoicesRouter);
  app.use('/api/v1/forms', formsRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => { port = (server!.address() as AddressInfo).port; resolve(); });
  });
  c = await makeCompany();
});

afterEach(async () => {
  while (spies.length) spies.pop()!.mockRestore();
  secrets.clearAllSessionSecrets();
  _resetDesktopProfileForTests();
  if (server) { await new Promise<void>((r) => server!.close(() => r())); server = null; }
  while (tenantIds.length) await cleanTenant(tenantIds.pop()!);
});

const key = () => crypto.randomBytes(12).toString('hex');
const pdfOf = (bytes: number) => Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(Math.max(0, bytes - 9), 0x20)]);
const PDF = pdfOf(2048);
const message = (extra: Record<string, unknown> = {}) => ({
  to: ['ap@hartley.example'], cc: ['owner2@hartley.example'], bcc: ['billing@example.test'],
  subject: 'Invoice 1042 from Monett\r\nBcc: evil@attacker.example', body: 'Hello,\n\nYour invoice is attached.\n', ...extra,
});
const emailBody = (extra: Record<string, unknown> = {}) => ({
  ...message(), pdfFileName: 'Invoice-1042.pdf', pdfBase64: PDF.toString('base64'), ...extra,
});

async function postInvoice(co: Co = c) {
  const r = await request('POST', '/api/v1/invoices', co.token, {
    contactId: co.customer, txnDate: '2026-11-03', lines: [{ accountId: co.revenue, quantity: '2', unitPrice: '125.00', isTaxable: false }],
  });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return r.json.invoice as { id: string; invoiceStatus: string };
}

async function events(invoiceId: string) {
  return db.select().from(documentSendEvents).where(eq(documentSendEvents.transactionId, invoiceId));
}

/** No log line and no audit row of the tenant carries an address. */
async function expectNoAddressLeak(tenantId: string) {
  for (const line of logged) expect(line).not.toMatch(/@/);
  const rows = await db.select({ before: auditLog.beforeData, after: auditLog.afterData }).from(auditLog).where(eq(auditLog.tenantId, tenantId));
  for (const r of rows) expect(JSON.stringify(r)).not.toMatch(/hartley\.example|billing@example|attacker/);
}

it('advertises invoice-email-v1', () => {
  expect(DESKTOP_CAPABILITIES).toContain('invoice-email-v1');
});

describe('POST /invoices/:id/email', () => {
  it('sends with the PDF attached and records an email send event in the same commit', async () => {
    const inv = await postInvoice();
    expect(inv.invoiceStatus).toBe('draft');
    const r = await request('POST', `/api/v1/invoices/${inv.id}/email`, c.token, emailBody(), { 'Idempotency-Key': key() });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.invoice.invoiceStatus).toBe('sent');
    expect(r.json.invoice.sendHistory).toHaveLength(1);
    expect(r.json.invoice.sendHistory[0]).toMatchObject({
      method: 'email', recipients: ['ap@hartley.example', 'owner2@hartley.example', 'billing@example.test'], userId: c.userId,
    });

    expect(mocks.sent).toHaveLength(1);
    const mail = mocks.sent[0]!;
    expect(mail['from']).toEqual({ name: 'Monett Landscapes', address: 'billing@example.test' });
    expect(mail['to']).toEqual(['ap@hartley.example']);
    expect(mail['cc']).toEqual(['owner2@hartley.example']);
    expect(mail['bcc']).toEqual(['billing@example.test']);
    expect(mail['subject']).toBe('Invoice 1042 from Monett Bcc: evil@attacker.example');
    expect(mail['text']).toBe('Hello,\n\nYour invoice is attached.\n');
    expect(mail['attachments']).toHaveLength(1);
    expect(mail['attachments'][0].filename).toBe('Invoice-1042.pdf');
    expect(mail['attachments'][0].contentType).toBe('application/pdf');
    expect(Buffer.compare(mail['attachments'][0].content, PDF)).toBe(0);
    // Server mode: the stored password, bounded timeouts.
    expect(mocks.created.at(-1)).toMatchObject({
      host: 'mail.example.test', port: 587, auth: { user: 'owner', pass: 'stored-pass' }, connectionTimeout: 15_000, socketTimeout: 60_000,
    });
    await expectNoAddressLeak(c.tenantId);
  });

  it('a retry with the same Idempotency-Key replays without sending again; another body is refused', async () => {
    const inv = await postInvoice();
    const k = key();
    const first = await request('POST', `/api/v1/invoices/${inv.id}/email`, c.token, emailBody(), { 'Idempotency-Key': k });
    expect(first.status).toBe(200);
    const again = await request('POST', `/api/v1/invoices/${inv.id}/email`, c.token, emailBody(), { 'Idempotency-Key': k });
    expect(again.status).toBe(200);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.json.invoice.id).toBe(inv.id);
    const other = await request('POST', `/api/v1/invoices/${inv.id}/email`, c.token, emailBody({ subject: 'x' }), { 'Idempotency-Key': k });
    expect(other.status).toBe(422);
    expect(other.json.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(mocks.sent).toHaveLength(1);
    expect(await events(inv.id)).toHaveLength(1);
  });

  it('a refused send is 400 SMTP_SEND_FAILED, records nothing, stores no outcome, and logs no address', async () => {
    const inv = await postInvoice();
    const k = key();
    mocks.fail = Object.assign(new Error('550 5.1.1 <ap@hartley.example>: Recipient address rejected'), { code: 'EENVELOPE' });
    const r = await request('POST', `/api/v1/invoices/${inv.id}/email`, c.token, emailBody(), { 'Idempotency-Key': k });
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe('SMTP_SEND_FAILED');
    expect(r.json.error.details).toEqual({ reason: 'send' });
    expect(JSON.stringify(r.json)).not.toMatch(/hartley/);
    expect(await events(inv.id)).toHaveLength(0);
    const [row] = await db.select({ s: transactions.invoiceStatus }).from(transactions).where(eq(transactions.id, inv.id));
    expect(row!.s).toBe('draft');
    expect(logged.some((l) => l.includes('[invoice-email] send failed (EENVELOPE)'))).toBe(true);

    mocks.fail = Object.assign(new Error('535 5.7.8 Authentication failed'), { code: 'EAUTH' });
    const auth = await request('POST', `/api/v1/invoices/${inv.id}/email`, c.token, emailBody(), { 'Idempotency-Key': k });
    expect(auth.status).toBe(400);
    expect(auth.json.error).toMatchObject({ code: 'SMTP_SEND_FAILED', details: { reason: 'auth' } });

    // The key was not used up: the retry sends.
    mocks.fail = null;
    const ok = await request('POST', `/api/v1/invoices/${inv.id}/email`, c.token, emailBody(), { 'Idempotency-Key': k });
    expect(ok.status).toBe(200);
    expect(await events(inv.id)).toHaveLength(1);
    await expectNoAddressLeak(c.tenantId);
  });

  it('400 SMTP_NOT_CONFIGURED without a mail server; nothing is sent or logged', async () => {
    const bare = await makeCompany({ smtpHost: null as unknown as string });
    const inv = await postInvoice(bare);
    const r = await request('POST', `/api/v1/invoices/${inv.id}/email`, bare.token, emailBody());
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe('SMTP_NOT_CONFIGURED');
    expect(mocks.sent).toHaveLength(0);
    expect(await events(inv.id)).toHaveLength(0);
    await expectNoAddressLeak(bare.tenantId);
  });

  it('checks the PDF: base64 of a PDF, at most 10 MB decoded (through the route\'s own body limit)', async () => {
    const inv = await postInvoice();
    const notPdf = await request('POST', `/api/v1/invoices/${inv.id}/email`, c.token, emailBody({ pdfBase64: Buffer.from('hello world').toString('base64') }));
    expect(notPdf.status).toBe(400);
    expect(notPdf.json.error.code).toBe('VALIDATION_ERROR');
    const badB64 = await request('POST', `/api/v1/invoices/${inv.id}/email`, c.token, emailBody({ pdfBase64: '%%%%' }));
    expect(badB64.status).toBe(400);
    const badName = await request('POST', `/api/v1/invoices/${inv.id}/email`, c.token, emailBody({ pdfFileName: '../evil.exe' }));
    expect(badName.status).toBe(400);
    const tooBig = await request('POST', `/api/v1/invoices/${inv.id}/email`, c.token, emailBody({ pdfBase64: pdfOf(10 * 1024 * 1024 + 1).toString('base64') }));
    expect(tooBig.status, JSON.stringify(tooBig.json).slice(0, 300)).toBe(400);
    expect(tooBig.json.error.code).toBe('ATTACHMENT_TOO_LARGE');
    expect(mocks.sent).toHaveLength(0);
    const max = await request('POST', `/api/v1/invoices/${inv.id}/email`, c.token, emailBody({ pdfBase64: pdfOf(10 * 1024 * 1024).toString('base64') }));
    expect(max.status, JSON.stringify(max.json).slice(0, 300)).toBe(200);
    expect(mocks.sent[0]!['attachments'][0].content.length).toBe(10 * 1024 * 1024);
    // The larger body limit is only for a signed-in caller (nit 4): without a
    // valid token the body meets the global 10 MB parser before auth runs.
    const anon = await request('POST', `/api/v1/invoices/${inv.id}/email`, 'not-a-token', emailBody({ pdfBase64: pdfOf(10 * 1024 * 1024).toString('base64') }));
    expect(anon.status).toBe(413);
    // A junk API key doesn't unlock it either (the key is looked up first).
    const junk = await request('POST', `/api/v1/invoices/${inv.id}/email`, 'not-a-token', emailBody({ pdfBase64: pdfOf(10 * 1024 * 1024).toString('base64') }), { 'X-Api-Key': 'kb_junk_' + 'x'.repeat(40) });
    expect(junk.status).toBe(413);
    expect(mocks.sent).toHaveLength(1);
  }, 60_000);

  it('validates recipients; a void invoice is 400 INVOICE_VOID; another tenant\'s invoice is 404; nothing is sent', async () => {
    const inv = await postInvoice();
    const noTo = await request('POST', `/api/v1/invoices/${inv.id}/email`, c.token, emailBody({ to: [] }));
    expect(noTo.status).toBe(400);
    const badCc = await request('POST', `/api/v1/invoices/${inv.id}/email`, c.token, emailBody({ cc: ['not-an-address'] }));
    expect(badCc.status).toBe(400);
    const other = await makeCompany();
    const foreign = await request('POST', `/api/v1/invoices/${inv.id}/email`, other.token, emailBody());
    expect(foreign.status).toBe(404);
    const v = await request('POST', `/api/v1/invoices/${inv.id}/void`, c.token, { reason: 'test' });
    expect(v.status, JSON.stringify(v.json)).toBe(200);
    const voided = await request('POST', `/api/v1/invoices/${inv.id}/email`, c.token, emailBody());
    expect(voided.status).toBe(400);
    expect(voided.json.error.code).toBe('INVOICE_VOID');
    const later = await request('POST', `/api/v1/invoices/${inv.id}/email-later`, c.token, message());
    expect(later.status).toBe(400);
    expect(later.json.error.code).toBe('INVOICE_VOID');
    expect(mocks.sent).toHaveLength(0);
  });
});

describe('desktop mode: the session password (smtp-session-v1)', () => {
  function desktop(): void {
    loadDesktopProfile({ CL_MODE: 'desktop', CL_TOKEN: 'mail_' + 'm'.repeat(44), CL_BIND: '127.0.0.1:0', CL_DATA_DIR: path.join(os.tmpdir(), 'cl-invoice-email-test'), CL_OFFLINE: 'off' });
  }

  it('SMTP_NOT_CONFIGURED without the session password; with it, sends using it (never the stored column)', async () => {
    const local = await makeCompany({ ...SMTP, smtpHost: '127.0.0.1', smtpPort: 2525 });
    const inv = await postInvoice(local);
    desktop();
    const input = { ...message(), pdfFileName: 'Invoice-1.pdf', pdfBase64: PDF.toString('base64') };
    await expect(invoiceEmail.emailInvoice(local.tenantId, inv.id, input, local.userId, local.companyId))
      .rejects.toMatchObject({ statusCode: 400, code: 'SMTP_NOT_CONFIGURED' });
    expect(await events(inv.id)).toHaveLength(0);

    secrets.setSmtpPassword('session-pass-xyz');
    await secrets.allowSmtpEgress({ host: '127.0.0.1', port: 2525 });
    const sent = await invoiceEmail.emailInvoice(local.tenantId, inv.id, input, local.userId, local.companyId);
    expect(sent.sendHistory).toHaveLength(1);
    expect(mocks.created.at(-1)).toMatchObject({ host: '127.0.0.1', port: 2525, auth: { user: 'owner', pass: 'session-pass-xyz' } });
    for (const line of logged) expect(line).not.toContain('session-pass-xyz');
  });

  it('a session password given for another server is SMTP_NOT_CONFIGURED', async () => {
    const local = await makeCompany({ ...SMTP, smtpHost: '127.0.0.1', smtpPort: 2525 });
    const inv = await postInvoice(local);
    desktop();
    secrets.setSmtpPassword('session-pass-xyz');
    await secrets.allowSmtpEgress({ host: '127.0.0.1', port: 587 });
    await expect(invoiceEmail.emailInvoice(local.tenantId, inv.id,
      { ...message(), pdfFileName: 'Invoice-1.pdf', pdfBase64: PDF.toString('base64') }, local.userId, local.companyId))
      .rejects.toMatchObject({ statusCode: 400, code: 'SMTP_NOT_CONFIGURED' });
    expect(mocks.sent).toHaveLength(0);
  });
});

describe('the Outbox', () => {
  it('email-later stores the message (201 {item}); GET lists it; email with outboxId sends it and removes it in the same commit', async () => {
    const inv = await postInvoice();
    const k = key();
    const r = await request('POST', `/api/v1/invoices/${inv.id}/email-later`, c.token, message(), { 'Idempotency-Key': k });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    const item = r.json.item;
    expect(item).toMatchObject({
      transactionId: inv.id, txnType: 'invoice', txnStatus: 'posted', contactName: 'Hartley Residence',
      to: ['ap@hartley.example'], cc: ['owner2@hartley.example'], bcc: ['billing@example.test'],
      subject: 'Invoice 1042 from Monett Bcc: evil@attacker.example', body: 'Hello,\n\nYour invoice is attached.\n', userId: c.userId,
    });
    expect(typeof item.createdAt).toBe('string');
    expect(mocks.sent).toHaveLength(0);

    const replay = await request('POST', `/api/v1/invoices/${inv.id}/email-later`, c.token, message(), { 'Idempotency-Key': k });
    expect(replay.status).toBe(201);
    expect(replay.json.item.id).toBe(item.id);

    const list = await request('GET', '/api/v1/forms/email-queue', c.token);
    expect(list.status).toBe(200);
    expect(list.json.data.map((d: any) => d.id)).toEqual([item.id]);
    const second = await request('POST', `/api/v1/invoices/${inv.id}/email-later`, c.token, message({ to: ['x@hartley.example'] }));
    expect(second.status).toBe(201);
    const secondId = second.json.item.id as string;
    const ordered = (await request('GET', '/api/v1/forms/email-queue', c.token)).json.data.map((d: any) => d.id);
    expect(ordered).toEqual([item.id, secondId]);

    const sent = await request('POST', `/api/v1/invoices/${inv.id}/email`, c.token, emailBody({ outboxId: item.id }));
    expect(sent.status, JSON.stringify(sent.json)).toBe(200);
    expect(sent.json.invoice.sendHistory).toHaveLength(1);
    expect((await request('GET', '/api/v1/forms/email-queue', c.token)).json.data.map((d: any) => d.id)).toEqual([secondId]);

    // Sent already (another Send all): 404, nothing sent again.
    const twice = await request('POST', `/api/v1/invoices/${inv.id}/email`, c.token, emailBody({ outboxId: item.id }));
    expect(twice.status).toBe(404);
    expect(twice.json.error.code).toBe('OUTBOX_ITEM_NOT_FOUND');
    expect(mocks.sent).toHaveLength(1);

    // A failed send keeps the message in the Outbox.
    mocks.fail = Object.assign(new Error('421 try later'), { code: 'ECONNECTION' });
    const failed = await request('POST', `/api/v1/invoices/${inv.id}/email`, c.token, emailBody({ outboxId: secondId }));
    expect(failed.json.error.code).toBe('SMTP_SEND_FAILED');
    expect((await request('GET', '/api/v1/forms/email-queue', c.token)).json.data).toHaveLength(1);

    const del = await request('DELETE', `/api/v1/forms/email-queue/${secondId}`, c.token);
    expect(del.status).toBe(204);
    const delAgain = await request('DELETE', `/api/v1/forms/email-queue/${secondId}`, c.token);
    expect(delAgain.status).toBe(404);
    expect(delAgain.json.error.code).toBe('OUTBOX_ITEM_NOT_FOUND');
    expect((await request('DELETE', '/api/v1/forms/email-queue/not-a-uuid', c.token)).status).toBe(404);
    expect((await request('GET', '/api/v1/forms/email-queue', c.token)).json.data).toEqual([]);

    const audits = await db.select({ action: auditLog.action, after: auditLog.afterData }).from(auditLog)
      .where(and(eq(auditLog.tenantId, c.tenantId), eq(auditLog.entityType, 'form_email_queue')));
    expect(audits.map((a) => a.action).sort()).toEqual(['create', 'create', 'delete', 'delete']);
    await expectNoAddressLeak(c.tenantId);
  });

  it('is scoped by tenant and company', async () => {
    const inv = await postInvoice();
    const item = (await request('POST', `/api/v1/invoices/${inv.id}/email-later`, c.token, message())).json.item;
    const other = await makeCompany();
    expect((await request('GET', '/api/v1/forms/email-queue', other.token)).json.data).toEqual([]);
    expect((await request('DELETE', `/api/v1/forms/email-queue/${item.id}`, other.token)).status).toBe(404);
    const foreignLater = await request('POST', `/api/v1/invoices/${inv.id}/email-later`, other.token, message());
    expect(foreignLater.status).toBe(404);
    // Another company of the same tenant sees none of it.
    const otherCompany = crypto.randomUUID();
    expect(await invoiceEmail.listEmailQueue(c.tenantId, otherCompany)).toEqual([]);
    await expect(invoiceEmail.deleteEmailQueueItem(c.tenantId, item.id, c.userId, otherCompany)).rejects.toMatchObject({ statusCode: 404 });
    expect(await invoiceEmail.listEmailQueue(c.tenantId, c.companyId)).toHaveLength(1);
  });
});
