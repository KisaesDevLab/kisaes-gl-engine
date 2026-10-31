// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Server appliance: payment reminders and payment confirmations log in to
// the company's mail server with the STORED SMTP password (they used the
// masked read shape and sent ''), while no read API returns that password:
// GET /company/smtp masks it and GET/PUT /company omit it. nodemailer is
// mocked; the shared test database is used.

import 'express-async-errors';
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { eq, inArray } from 'drizzle-orm';

const mocks = vi.hoisted(() => ({
  created: [] as Array<Record<string, unknown>>,
  sent: [] as Array<Record<string, unknown>>,
}));
vi.mock('nodemailer', () => ({
  default: {
    createTransport: (opts: Record<string, unknown>) => {
      mocks.created.push(opts);
      return {
        options: opts,
        verify: async () => true,
        sendMail: async (mail: Record<string, unknown>) => { mocks.sent.push(mail); return { messageId: 'm' }; },
      };
    },
  },
}));

import { db } from '../db/index.js';
import {
  tenants, users, userTenantAccess, sessions, companies, contacts, transactions, auditLog, accounts, userPermissions,
} from '../db/schema/index.js';
import { companyRouter } from '../routes/company.routes.js';
import { errorHandler } from '../middleware/error-handler.js';
import * as authService from './auth.service.js';
import * as companyService from './company.service.js';
import { sendPaymentReminder, sendPaymentConfirmation } from './email.service.js';

const PASSWORD = 'stored-smtp-pw-' + Math.random().toString(36).slice(2, 10);
const SETTINGS = { smtpHost: '10.0.0.25', smtpPort: 587, smtpUser: 'mailer', smtpFrom: 'billing@example.test', smtpFromName: 'Billing' };

let server: Server | null = null;
let port = 0;
let tenantId = '';
let companyId = '';
let token = '';
let invoiceId = '';
let paymentId = '';

interface Res { status: number; json: any; raw: string }

function send(method: string, pathname: string, body?: unknown): Promise<Res> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = http.request({
      hostname: '127.0.0.1', port, path: pathname, method,
      headers: {
        Authorization: `Bearer ${token}`,
        'X-Company-Id': companyId,
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': String(data.length) } : {}),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (ch) => chunks.push(ch));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json: unknown = null;
        try { json = raw ? JSON.parse(raw) : null; } catch { json = raw; }
        resolve({ status: res.statusCode ?? 0, json, raw });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function cleanTenant(tid: string) {
  await db.delete(transactions).where(eq(transactions.tenantId, tid));
  await db.delete(contacts).where(eq(contacts.tenantId, tid));
  await db.delete(auditLog).where(eq(auditLog.tenantId, tid));
  await db.delete(accounts).where(eq(accounts.tenantId, tid));
  const staff = await db.select({ id: users.id }).from(users).where(eq(users.tenantId, tid));
  if (staff.length) await db.delete(sessions).where(inArray(sessions.userId, staff.map((u) => u.id)));
  await db.delete(companies).where(eq(companies.tenantId, tid));
  await db.delete(userPermissions).where(eq(userPermissions.tenantId, tid));
  await db.delete(userTenantAccess).where(eq(userTenantAccess.tenantId, tid));
  await db.delete(users).where(eq(users.tenantId, tid));
  await db.delete(tenants).where(eq(tenants.id, tid));
}

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/company', companyRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => { port = (server!.address() as AddressInfo).port; resolve(); });
  });
  const reg = await authService.register({
    email: `smtp-pw-${Date.now()}@example.com`, password: 'password123', displayName: 'Owner', companyName: 'Mail Co',
  });
  tenantId = reg.user.tenantId;
  token = reg.tokens.accessToken;
  const [company] = await db.select({ id: companies.id }).from(companies).where(eq(companies.tenantId, tenantId)).limit(1);
  companyId = company!.id;
  await companyService.updateSmtpSettings(tenantId, companyId, { ...SETTINGS, smtpPass: PASSWORD });

  const [customer] = await db.insert(contacts).values({
    tenantId, companyId, contactType: 'customer', displayName: 'Pat Customer', email: 'pat@example.test',
  }).returning();
  const [invoice] = await db.insert(transactions).values({
    tenantId, txnType: 'invoice', txnDate: '2026-10-01', dueDate: '2026-10-31', status: 'draft',
    contactId: customer!.id, txnNumber: 'INV-1', total: '125.0000', balanceDue: '125.0000',
  } as never).returning();
  invoiceId = invoice!.id;
  const [payment] = await db.insert(transactions).values({
    tenantId, txnType: 'customer_payment', txnDate: '2026-10-15', status: 'draft',
    contactId: customer!.id, total: '125.0000',
  } as never).returning();
  paymentId = payment!.id;
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  if (tenantId) await cleanTenant(tenantId);
});

beforeEach(() => { mocks.created.length = 0; mocks.sent.length = 0; });

describe('company SMTP sends use the stored password (server)', () => {
  it('a payment reminder authenticates with the stored password', async () => {
    await sendPaymentReminder(tenantId, invoiceId);
    expect(mocks.created).toHaveLength(1);
    expect(mocks.created[0]).toMatchObject({ host: '10.0.0.25', port: 587, auth: { user: 'mailer', pass: PASSWORD } });
    expect(mocks.sent).toHaveLength(1);
    expect(mocks.sent[0]).toMatchObject({ to: 'pat@example.test', from: { name: 'Billing', address: 'billing@example.test' } });
  });

  it('a payment confirmation authenticates with the stored password', async () => {
    await sendPaymentConfirmation(tenantId, paymentId);
    expect(mocks.created).toHaveLength(1);
    expect(mocks.created[0]).toMatchObject({ host: '10.0.0.25', auth: { user: 'mailer', pass: PASSWORD } });
    expect(mocks.sent).toHaveLength(1);
  });
});

describe('no read API returns the stored SMTP password', () => {
  it('GET /company/smtp masks it and reports it is configured', async () => {
    const r = await send('GET', '/api/v1/company/smtp');
    expect(r.status, r.raw).toBe(200);
    expect(r.json).toMatchObject({ smtpHost: '10.0.0.25', smtpUser: 'mailer', smtpPass: '', passwordConfigured: true });
    expect(r.raw).not.toContain(PASSWORD);
  });

  it('GET /company and PUT /company omit it', async () => {
    const g = await send('GET', '/api/v1/company');
    expect(g.status, g.raw).toBe(200);
    expect(g.json.company.smtpHost).toBe('10.0.0.25');
    expect(g.json.company).not.toHaveProperty('smtpPass');
    expect(g.raw).not.toContain(PASSWORD);

    const p = await send('PUT', '/api/v1/company', { businessName: 'Mail Co' });
    expect(p.status, p.raw).toBe(200);
    expect(p.json.company).not.toHaveProperty('smtpPass');
    expect(p.raw).not.toContain(PASSWORD);
  });

  it('the service read shapes omit it', async () => {
    expect(await companyService.getCompany(tenantId, companyId)).not.toHaveProperty('smtpPass');
    expect((await companyService.getSmtpSettings(tenantId, companyId)).smtpPass).toBe('');
    const saved = await companyService.updateSmtpSettings(tenantId, companyId, { ...SETTINGS, smtpPass: '' });
    expect(saved).not.toHaveProperty('smtpPass');
    // '' kept the stored password.
    const [row] = await db.select({ pass: companies.smtpPass }).from(companies).where(eq(companies.id, companyId));
    expect(row!.pass).toBe(PASSWORD);
  });
});
