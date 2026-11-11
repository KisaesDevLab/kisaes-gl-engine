// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.
//
// U-204 (closing-exceptions-v1, audit-filters-v1) and U-207
// (reports-email-v1), ClientLedger P28 PR-E:
//   - Closing Date Exceptions: an edit in the closed period with the
//     password is listed with exact before/after amounts and the method; a
//     change made before any closing date was set is not; moving the closing
//     date later applies the new date to later changes only; the timeline
//     reads both closing-date audit shapes; filters on the change day.
//   - GET /audit-log: user_id, entity_id, company filters and userName.
//   - POST /reports/email through a stub SMTP: attachment, audit row,
//     INVALID_RECIPIENT, SMTP_NOT_CONFIGURED, file checks, Idempotency-Key.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ sent: [] as Array<Record<string, any>> }));
vi.mock('nodemailer', () => ({
  default: {
    createTransport: () => ({
      verify: async () => true,
      sendMail: async (mail: Record<string, unknown>) => { mocks.sent.push(mail); return { messageId: 'm-' + mocks.sent.length }; },
    }),
  },
}));

import 'express-async-errors';
import bcrypt from 'bcrypt';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { auditLog as auditLogTable, companies } from '../db/schema/index.js';
import { auditLog } from '../middleware/audit.js';
import { transactionsRouter } from './transactions.routes.js';
import { reportsRouter } from './reports.routes.js';
import { auditRouter } from './audit.routes.js';
import { companyRouter } from './company.routes.js';
import { DESKTOP_CAPABILITIES } from '../desktop/capabilities.js';
import { decodeReportAttachment } from '../services/report-email.service.js';
import { Harness, type Co, key } from './receivables.test-support.js';

const PASSWORD = 'closing-exceptions-pass-1';
const PDF = Buffer.from('%PDF-1.4\n% report\n').toString('base64');
const h = new Harness();
let c: Co;

beforeEach(async () => {
  mocks.sent.length = 0;
  await h.start([
    ['/api/v1/transactions', transactionsRouter], ['/api/v1/reports', reportsRouter],
    ['/api/v1/audit-log', auditRouter], ['/api/v1/company', companyRouter],
  ]);
  c = await h.company();
});

afterEach(async () => {
  await h.stop();
});

function expenseBody(date: string, amount: string, extra: Record<string, unknown> = {}) {
  return {
    txnType: 'expense', txnDate: date, payFromAccountId: c.roles['checking'],
    lines: [{ expenseAccountId: c.roles['expense'], amount, description: 'Supplies' }], ...extra,
  };
}

async function expense(date: string, amount: string, extra: Record<string, unknown> = {}) {
  const r = await h.request('POST', '/api/v1/transactions', c.token, expenseBody(date, amount, extra));
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return String(r.json['transaction'].id);
}

/** PUT /tb/closing-date's audit shape (that router needs TRIAL_BALANCE_V1; the write is the same). */
async function tbClosingDate(closingDate: string) {
  const [before] = await db.select({ lockDate: companies.lockDate }).from(companies).where(eq(companies.id, c.companyId));
  await db.transaction(async (tx) => {
    await tx.update(companies).set({ lockDate: closingDate, lockDateSetBy: c.userId, lockDateSetAt: new Date() })
      .where(eq(companies.id, c.companyId));
    await auditLog(c.tenantId, 'update', 'closing_date', c.companyId, { closingDate: before!.lockDate }, { closingDate }, c.userId, tx);
  });
}

async function exceptions(query = '') {
  const r = await h.request('GET', `/api/v1/reports/closing-date-exceptions${query}`, c.token);
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return r.json as any;
}

describe('Closing Date Exceptions (closing-exceptions-v1)', () => {
  it('lists closed-period changes made after the closing date was set, with the closing date in effect', async () => {
    expect(DESKTOP_CAPABILITIES).toEqual(expect.arrayContaining(['closing-exceptions-v1', 'audit-filters-v1', 'reports-email-v1']));
    expect((await exceptions()).data).toEqual([]);

    // Before any closing date: not listed.
    const jan = await expense('2026-01-15', '12.50');

    // Closing date 2026-03-31 through the company settings ('company' audit shape), then a password.
    let r = await h.request('PUT', '/api/v1/company/settings', c.token, { lockDate: '2026-03-31' });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    await db.update(companies).set({ closingPasswordHash: await bcrypt.hash(PASSWORD, 4) }).where(eq(companies.id, c.companyId));

    // Edit in the closed period with the password: listed, exact amounts.
    r = await h.request('PUT', `/api/v1/transactions/${jan}`, c.token, { ...expenseBody('2026-01-15', '20.005'), closingPassword: PASSWORD });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    // Created in the closed period with the password.
    const feb = await expense('2026-02-01', '7.25', { closingPassword: PASSWORD });
    // In the open period: not listed.
    const apr = await expense('2026-04-10', '30.00');

    // The closing date moves later (PUT /tb/closing-date shape); the April expense is now closed.
    await tbClosingDate('2026-04-30');
    r = await h.request('POST', `/api/v1/transactions/${apr}/void`, c.token, { reason: 'dup', closingPassword: PASSWORD });
    expect(r.status, JSON.stringify(r.json)).toBe(200);

    const rep = await exceptions();
    expect(rep.closingDate).toBe('2026-04-30');
    expect(rep.timeline.map((t: any) => t.closingDate)).toEqual(['2026-03-31', '2026-04-30']);
    expect(rep.total).toBe(3);
    const rows = rep.data.map((x: any) => ({ ...x, at: typeof x.at }));
    expect(rows[0]).toMatchObject({
      action: 'update', transactionId: jan, txnType: 'expense', txnDateBefore: '2026-01-15', txnDateAfter: '2026-01-15',
      closingDate: '2026-03-31', method: 'password', amountBeforeExact: '12.5000', amountAfterExact: '20.0050',
      userId: c.userId, userName: 'Owner', at: 'string',
    });
    expect(rows[1]).toMatchObject({
      action: 'create', transactionId: feb, txnDateBefore: null, txnDateAfter: '2026-02-01', closingDate: '2026-03-31',
      method: 'password', amountBeforeExact: null, amountAfterExact: '7.2500',
    });
    expect(rows[2]).toMatchObject({
      action: 'void', transactionId: apr, txnDateBefore: '2026-04-10', txnDateAfter: '2026-04-10', closingDate: '2026-04-30',
      method: 'password', amountBeforeExact: '30.0000', amountAfterExact: null,
    });
    // Ids are audit row ids; every override was paired with its change.
    expect(rows.every((x: any) => Number.isInteger(x.auditId))).toBe(true);
    expect(rows.some((x: any) => x.action === 'override')).toBe(false);

    // Dates filter the day of the change.
    expect((await exceptions('?end_date=2000-01-01')).data).toEqual([]);
    expect((await exceptions('?start_date=2000-01-01&limit=1'))).toMatchObject({ total: 3, truncated: true });
    r = await h.request('GET', '/api/v1/reports/closing-date-exceptions?start_date=2026-13-01', c.token);
    expect(r.status).toBe(400);
  });

  it('an override row with no transaction row is listed on its own', async () => {
    await tbClosingDate('2026-03-31');
    await auditLog(c.tenantId, 'override', 'closing_date_override', c.companyId,
      { lockDate: '2026-03-31', lockDateSetBy: c.userId, lockDateSetAt: null },
      { txnDate: '2026-02-02', method: 'confirmed', overrideConfirmed: true, transactionId: null, oldDate: '2026-02-02', newDate: '2026-02-02', companyId: c.companyId },
      c.userId);
    const rep = await exceptions();
    expect(rep.data).toHaveLength(1);
    expect(rep.data[0]).toMatchObject({
      action: 'override', transactionId: null, method: 'confirmed', closingDate: '2026-03-31',
      txnDateBefore: '2026-02-02', txnDateAfter: '2026-02-02', amountBeforeExact: null, amountAfterExact: null,
    });
  });
});

describe('GET /audit-log filters (audit-filters-v1)', () => {
  it('filters by user, entity and company and names the user', async () => {
    const a = await expense('2026-05-01', '10.00');
    const b = await expense('2026-05-02', '11.00');

    let r = await h.request('GET', `/api/v1/audit-log?entity_id=${a}`, c.token);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json['data'].length).toBeGreaterThan(0);
    expect(r.json['data'].every((x: any) => x.entity_id === a)).toBe(true);
    expect(r.json['data'][0].userName).toBe('Owner');

    r = await h.request('GET', `/api/v1/audit-log?user_id=${c.userId}&entity_type=transaction&limit=500`, c.token);
    expect(r.json['data'].map((x: any) => x.entity_id)).toEqual(expect.arrayContaining([a, b]));
    expect(r.json['data'].every((x: any) => x.user_id === c.userId)).toBe(true);

    r = await h.request('GET', `/api/v1/audit-log?user_id=00000000-0000-4000-8000-000000000000`, c.token);
    expect(r.json).toMatchObject({ data: [], total: 0 });

    r = await h.request('GET', '/api/v1/audit-log?company=current&entity_type=transaction', c.token);
    expect(r.json['total']).toBe(2);
    r = await h.request('GET', `/api/v1/audit-log?company=${c.companyId}&entity_type=transaction`, c.token);
    expect(r.json['total']).toBe(2);
    // Another company of the tenant: these transactions are not its rows.
    const other = (await h.secondCompany(c))['X-Company-Id']!;
    r = await h.request('GET', `/api/v1/audit-log?company=${other}&entity_type=transaction`, c.token);
    expect(r.status).toBe(200);
    expect(r.json['total']).toBe(0);
    r = await h.request('GET', `/api/v1/audit-log/export?company=${other}&entity_type=transaction`, c.token);
    expect(r.status).toBe(200);

    for (const q of ['user_id=nope', 'entity_id=1', 'company=other']) {
      r = await h.request('GET', `/api/v1/audit-log?${q}`, c.token);
      expect(r.status, q).toBe(400);
      expect(r.json.error.code).toBe('VALIDATION_ERROR');
    }
    r = await h.request('GET', '/api/v1/audit-log?company=00000000-0000-4000-8000-000000000000', c.token);
    expect(r.status).toBe(403);

    // Without the new filters the response keeps its shape.
    r = await h.request('GET', '/api/v1/audit-log', c.token);
    expect(Object.keys(r.json['data'][0])).toEqual(expect.arrayContaining(['id', 'user_id', 'userName', 'action', 'entity_type', 'entity_id', 'before_data', 'after_data', 'created_at']));
  });
});

describe('POST /reports/email (reports-email-v1)', () => {
  const msg = { to: ['owner@example.test'], subject: 'October P&L', body: 'Attached.' };

  it('sends the file through the company mail server once and audits it', async () => {
    let r = await h.request('POST', '/api/v1/reports/email', c.token, { ...msg, filename: 'pl.pdf', pdfBase64: PDF });
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe('SMTP_NOT_CONFIGURED');

    await db.update(companies).set({ smtpHost: 'mail.example.test', smtpPort: 587, smtpFrom: 'books@example.test' }).where(eq(companies.id, c.companyId));
    const k = key();
    const body = { ...msg, cc: ['cpa@example.test'], filename: 'Profit and Loss.pdf', fileBase64: PDF, reportKey: 'profit_loss' };
    r = await h.request('POST', '/api/v1/reports/email', c.token, body, { 'Idempotency-Key': k });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json).toEqual({ sent: true, filename: 'Profit and Loss.pdf', recipientCount: 2 });
    r = await h.request('POST', '/api/v1/reports/email', c.token, body, { 'Idempotency-Key': k });
    expect(r.status).toBe(200);
    expect(mocks.sent).toHaveLength(1);
    const mail = mocks.sent[0]!;
    expect(mail['to']).toEqual(['owner@example.test']);
    expect(mail['cc']).toEqual(['cpa@example.test']);
    expect(mail['attachments'][0]).toMatchObject({ filename: 'Profit and Loss.pdf', contentType: 'application/pdf' });
    expect(Buffer.compare(mail['attachments'][0].content, Buffer.from(PDF, 'base64'))).toBe(0);

    const rows = await db.select().from(auditLogTable).where(and(eq(auditLogTable.tenantId, c.tenantId), eq(auditLogTable.entityType, 'report_email')));
    expect(rows).toHaveLength(1);
    const after = typeof rows[0]!.afterData === 'string' ? JSON.parse(rows[0]!.afterData as string) : rows[0]!.afterData;
    expect(after).toEqual({
      filename: 'Profit and Loss.pdf', contentType: 'application/pdf', bytes: Buffer.from(PDF, 'base64').length,
      recipients: ['owner@example.test', 'cpa@example.test'], reportKey: 'profit_loss', companyId: c.companyId,
    });
    expect(JSON.stringify(after)).not.toContain('October');

    // CSV and xlsx files.
    r = await h.request('POST', '/api/v1/reports/email', c.token,
      { ...msg, filename: 'tb.csv', fileBase64: Buffer.from('Account,Debit\nCash,1234.56\n').toString('base64') });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(mocks.sent[1]!['attachments'][0].contentType).toMatch(/^text\/csv/);
    r = await h.request('POST', '/api/v1/reports/email', c.token,
      { ...msg, filename: 'tb.xlsx', fileBase64: Buffer.from('PK\u0003\u0004rest').toString('base64') });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
  });

  it('refuses bad recipients and files before sending', async () => {
    await db.update(companies).set({ smtpHost: 'mail.example.test', smtpPort: 587, smtpFrom: 'books@example.test' }).where(eq(companies.id, c.companyId));
    let r = await h.request('POST', '/api/v1/reports/email', c.token, { ...msg, bcc: ['ok@example.test', 'not an address'], filename: 'a.pdf', fileBase64: PDF });
    expect(r.status).toBe(400);
    expect(r.json.error).toMatchObject({ code: 'INVALID_RECIPIENT', details: { field: 'bcc', index: 1 } });
    for (const bad of [
      { filename: 'a.exe', fileBase64: PDF },
      { filename: '../a.pdf', fileBase64: PDF },
      { filename: 'a.xlsx', fileBase64: PDF },
      { filename: 'a.pdf', fileBase64: 'not base64!' },
      { filename: 'a.pdf', fileBase64: PDF, pdfBase64: PDF },
      { filename: 'a.pdf' },
    ]) {
      r = await h.request('POST', '/api/v1/reports/email', c.token, { ...msg, ...bad });
      expect(r.status, JSON.stringify(bad)).toBe(400);
      expect(r.json.error.code).toBe('VALIDATION_ERROR');
    }
    // Over 10 MB decoded (checked on the decoder: the test app's body limit is 12 MB).
    expect(() => decodeReportAttachment('big.pdf', Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(10 * 1024 * 1024)]).toString('base64')))
      .toThrow(expect.objectContaining({ code: 'ATTACHMENT_TOO_LARGE' }));
    expect(mocks.sent).toHaveLength(0);
  });
});
