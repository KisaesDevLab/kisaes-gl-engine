// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// U-144 (sales-doc-email-v1): emailing credit memos and sales receipts with
// the invoice email contract (U-127): send + send event, sendHistory on the
// record, email-later and the Outbox kinds, outboxId, Idempotency-Key
// replay, void, wrong type, another company / tenant, permissions, and no
// address in logs or audit rows. nodemailer is replaced (vi.mock): no
// network.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  sent: [] as Array<Record<string, any>>,
  fail: null as null | (Error & { code?: string }),
}));
vi.mock('nodemailer', () => ({
  default: {
    createTransport: (opts: Record<string, unknown>) => ({
      options: opts,
      verify: async () => true,
      sendMail: async (mail: Record<string, unknown>) => {
        if (mocks.fail) throw mocks.fail;
        mocks.sent.push(mail);
        return { messageId: 'm-' + mocks.sent.length };
      },
    }),
  },
}));

// First: it wraps only the route layers created after it loads.
import 'express-async-errors';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { companies, documentSendEvents, formEmailQueue, auditLog } from '../db/schema/index.js';
import { creditMemosRouter } from './credit-memos.routes.js';
import { salesReceiptsRouter } from './sales-receipts.routes.js';
import { transactionsRouter } from './transactions.routes.js';
import { invoicesRouter } from './invoices.routes.js';
import { formsRouter } from './forms.routes.js';
import { DESKTOP_CAPABILITIES } from '../desktop/capabilities.js';
import { Harness, type Co, key } from './receivables.test-support.js';

const h = new Harness();
let c: Co;
let logged: string[] = [];
const spies: Array<ReturnType<typeof vi.spyOn>> = [];
const SMTP = { smtpHost: 'mail.example.test', smtpPort: 587, smtpUser: 'owner', smtpPass: 'stored-pass', smtpFrom: 'billing@example.test', smtpFromName: 'Bluestem Books' };

beforeEach(async () => {
  mocks.sent.length = 0;
  mocks.fail = null;
  logged = [];
  for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    spies.push(vi.spyOn(console, m).mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(' ')); }));
  }
  h.extraCleanup = [async (tid) => { await db.delete(formEmailQueue).where(eq(formEmailQueue.tenantId, tid)); }];
  await h.start([
    ['/api/v1/credit-memos', creditMemosRouter], ['/api/v1/sales-receipts', salesReceiptsRouter],
    ['/api/v1/transactions', transactionsRouter], ['/api/v1/invoices', invoicesRouter], ['/api/v1/forms', formsRouter],
  ]);
  c = await h.company();
  await db.update(companies).set(SMTP).where(eq(companies.id, c.companyId));
});
afterEach(async () => {
  while (spies.length) spies.pop()!.mockRestore();
  await h.stop();
});

const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(2048, 0x20)]);
const message = (extra: Record<string, unknown> = {}) => ({
  to: ['ap@bluestem.example'], cc: ['vet@bluestem.example'], bcc: ['billing@example.test'],
  subject: 'Your document from Bluestem', body: 'Hello,\n\nIt is attached.\n', ...extra,
});
const emailBody = (file: string, extra: Record<string, unknown> = {}) => ({
  ...message(), pdfFileName: file, pdfBase64: PDF.toString('base64'), ...extra,
});
const events = (id: string) => db.select().from(documentSendEvents).where(eq(documentSendEvents.transactionId, id));

interface Kind {
  name: string; path: string; key: 'creditMemo' | 'salesReceipt'; kind: 'credit_memo' | 'sales_receipt'; txnType: string; file: string;
}
const KINDS: Kind[] = [
  { name: 'credit memo', path: 'credit-memos', key: 'creditMemo', kind: 'credit_memo', txnType: 'credit_memo', file: 'CreditMemo-1.pdf' },
  { name: 'sales receipt', path: 'sales-receipts', key: 'salesReceipt', kind: 'sales_receipt', txnType: 'cash_sale', file: 'SalesReceipt-1.pdf' },
];

async function create(k: Kind, co: Co = c): Promise<string> {
  const r = await h.request('POST', `/api/v1/${k.path}`, co.token, {
    txnDate: '2026-10-20', contactId: co.customer,
    lines: [{ accountId: co.roles['income'], description: 'Work', quantity: '1', unitPrice: '40.00', isTaxable: false }],
  });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return String(r.json[k.key].id);
}

/** No log line and no audit row of the tenant carries an address. */
async function expectNoAddressLeak(tenantId: string) {
  for (const line of logged) expect(line).not.toMatch(/bluestem\.example|billing@example/);
  const rows = await db.select({ before: auditLog.beforeData, after: auditLog.afterData }).from(auditLog).where(eq(auditLog.tenantId, tenantId));
  for (const r of rows) expect(JSON.stringify(r)).not.toMatch(/bluestem\.example|billing@example/);
}

it('advertises sales-doc-email-v1', () => {
  expect(DESKTOP_CAPABILITIES).toContain('sales-doc-email-v1');
});

describe.each(KINDS)('sales-doc-email-v1: $name', (k) => {
  it('GET has an empty sendHistory; email sends the PDF and records an email event; the record shows it', async () => {
    const id = await create(k);
    const g = await h.request('GET', `/api/v1/${k.path}/${id}`, c.token);
    expect(g.json[k.key].sendHistory).toEqual([]);
    const r = await h.request('POST', `/api/v1/${k.path}/${id}/email`, c.token, emailBody(k.file), { 'Idempotency-Key': key() });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json[k.key].id).toBe(id);
    expect(r.json[k.key].sendHistory).toHaveLength(1);
    expect(r.json[k.key].sendHistory[0]).toMatchObject({
      method: 'email', recipients: ['ap@bluestem.example', 'vet@bluestem.example', 'billing@example.test'], userId: c.userId,
    });
    expect(mocks.sent).toHaveLength(1);
    const mail = mocks.sent[0]!;
    expect(mail['to']).toEqual(['ap@bluestem.example']);
    expect(mail['attachments'][0].filename).toBe(k.file);
    expect(Buffer.compare(mail['attachments'][0].content, PDF)).toBe(0);
    const again = await h.request('GET', `/api/v1/${k.path}/${id}`, c.token);
    expect(again.json[k.key].sendHistory).toHaveLength(1);
    await expectNoAddressLeak(c.tenantId);
  });

  it('a retry with the same Idempotency-Key replays without sending again; another body is refused', async () => {
    const id = await create(k);
    const kk = key();
    const first = await h.request('POST', `/api/v1/${k.path}/${id}/email`, c.token, emailBody(k.file), { 'Idempotency-Key': kk });
    expect(first.status).toBe(200);
    const replay = await h.request('POST', `/api/v1/${k.path}/${id}/email`, c.token, emailBody(k.file), { 'Idempotency-Key': kk });
    expect(replay.status).toBe(200);
    expect(replay.json[k.key].id).toBe(id);
    expect(replay.json[k.key].sendHistory).toHaveLength(1);
    const other = await h.request('POST', `/api/v1/${k.path}/${id}/email`, c.token, emailBody(k.file, { subject: 'x' }), { 'Idempotency-Key': kk });
    expect([other.status, other.json['error']?.code]).toEqual([422, 'IDEMPOTENCY_KEY_REUSED']);
    expect(mocks.sent).toHaveLength(1);
    expect(await events(id)).toHaveLength(1);
  });

  it('a refused send records nothing; the key is not used up', async () => {
    const id = await create(k);
    const kk = key();
    mocks.fail = Object.assign(new Error('550 <ap@bluestem.example> rejected'), { code: 'EENVELOPE' });
    const r = await h.request('POST', `/api/v1/${k.path}/${id}/email`, c.token, emailBody(k.file), { 'Idempotency-Key': kk });
    expect([r.status, r.json['error']?.code]).toEqual([400, 'SMTP_SEND_FAILED']);
    expect(await events(id)).toHaveLength(0);
    mocks.fail = null;
    const ok = await h.request('POST', `/api/v1/${k.path}/${id}/email`, c.token, emailBody(k.file), { 'Idempotency-Key': kk });
    expect(ok.status).toBe(200);
    expect(await events(id)).toHaveLength(1);
    await expectNoAddressLeak(c.tenantId);
  });

  it(`email-later puts it in the Outbox with kind ${k.kind}; email with outboxId sends and removes it; replay returns the same row`, async () => {
    const id = await create(k);
    const kk = key();
    const r = await h.request('POST', `/api/v1/${k.path}/${id}/email-later`, c.token, message(), { 'Idempotency-Key': kk });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    const item = r.json['item'];
    expect(item).toMatchObject({
      transactionId: id, kind: k.kind, txnType: k.txnType, txnStatus: 'posted', customerStatementId: null,
      contactName: 'Bluestem Veterinary Clinic', to: ['ap@bluestem.example'], subject: 'Your document from Bluestem', userId: c.userId,
    });
    expect(mocks.sent).toHaveLength(0);
    const replay = await h.request('POST', `/api/v1/${k.path}/${id}/email-later`, c.token, message(), { 'Idempotency-Key': kk });
    expect([replay.status, replay.json['item'].id]).toEqual([201, item.id]);

    const list = await h.request('GET', '/api/v1/forms/email-queue', c.token);
    expect(list.json['data'].map((d: any) => [d.id, d.kind])).toEqual([[item.id, k.kind]]);

    const sent = await h.request('POST', `/api/v1/${k.path}/${id}/email`, c.token, emailBody(k.file, { outboxId: item.id }));
    expect(sent.status, JSON.stringify(sent.json)).toBe(200);
    expect(sent.json[k.key].sendHistory).toHaveLength(1);
    expect((await h.request('GET', '/api/v1/forms/email-queue', c.token)).json['data']).toEqual([]);
    const twice = await h.request('POST', `/api/v1/${k.path}/${id}/email`, c.token, emailBody(k.file, { outboxId: item.id }));
    expect([twice.status, twice.json['error']?.code]).toEqual([404, 'OUTBOX_ITEM_NOT_FOUND']);
    expect(mocks.sent).toHaveLength(1);

    // DELETE removes a row of the new kinds too.
    const later = (await h.request('POST', `/api/v1/${k.path}/${id}/email-later`, c.token, message())).json['item'];
    expect((await h.request('DELETE', `/api/v1/forms/email-queue/${later.id}`, c.token)).status).toBe(204);
    await expectNoAddressLeak(c.tenantId);
  });

  it('another company or tenant is 404 and nothing is sent or queued; a void document is 400 DOCUMENT_VOID', async () => {
    const id = await create(k);
    const b = await h.secondCompany(c);
    // The mail server is checked first (as for invoices): give the second company one.
    await db.update(companies).set(SMTP).where(eq(companies.id, b['X-Company-Id']!));
    const send = await h.request('POST', `/api/v1/${k.path}/${id}/email`, c.token, emailBody(k.file), { ...b, 'Idempotency-Key': key() });
    expect(send.status, JSON.stringify(send.json)).toBe(404);
    const later = await h.request('POST', `/api/v1/${k.path}/${id}/email-later`, c.token, message(), b);
    expect(later.status).toBe(404);
    const other = await h.company();
    await db.update(companies).set(SMTP).where(eq(companies.id, other.companyId));
    expect((await h.request('POST', `/api/v1/${k.path}/${id}/email`, other.token, emailBody(k.file))).status).toBe(404);
    expect((await h.request('POST', `/api/v1/${k.path}/${id}/email-later`, other.token, message())).status).toBe(404);
    expect((await h.request('POST', `/api/v1/${k.path}/not-a-uuid/email-later`, c.token, message())).status).toBe(404);
    expect(mocks.sent).toHaveLength(0);
    expect(await db.select().from(formEmailQueue).where(eq(formEmailQueue.tenantId, c.tenantId))).toEqual([]);

    const v = await h.request('POST', `/api/v1/transactions/${id}/void`, c.token, { reason: 'test' });
    expect(v.status, JSON.stringify(v.json)).toBe(200);
    const voided = await h.request('POST', `/api/v1/${k.path}/${id}/email`, c.token, emailBody(k.file));
    expect([voided.status, voided.json['error']?.code]).toEqual([400, 'DOCUMENT_VOID']);
    const voidLater = await h.request('POST', `/api/v1/${k.path}/${id}/email-later`, c.token, message());
    expect([voidLater.status, voidLater.json['error']?.code]).toEqual([400, 'DOCUMENT_VOID']);
    expect(mocks.sent).toHaveLength(0);
  });

  it('a document of another type is 404 on this route', async () => {
    const otherKind = KINDS.find((x) => x !== k)!;
    const otherId = await create(otherKind);
    const inv = await h.invoice(c, { date: '2026-10-20', total: '25.00' });
    for (const id of [otherId, inv]) {
      expect((await h.request('POST', `/api/v1/${k.path}/${id}/email`, c.token, emailBody(k.file))).status).toBe(404);
      expect((await h.request('POST', `/api/v1/${k.path}/${id}/email-later`, c.token, message())).status).toBe(404);
    }
    expect(mocks.sent).toHaveLength(0);
  });
});

describe('permissions', () => {
  it('credit memos need invoices, sales receipts need transactions', async () => {
    const memo = await create(KINDS[0]!);
    const receipt = await create(KINDS[1]!);
    const bankingOnly = await h.staffToken(c, { banking: 'full' });
    for (const [path, id] of [['credit-memos', memo], ['sales-receipts', receipt]] as const) {
      const r = await h.request('POST', `/api/v1/${path}/${id}/email-later`, bankingOnly, message());
      expect([r.status, r.json['error']?.code], path).toEqual([403, 'PERMISSION_DENIED']);
    }
    const invoicesOnly = await h.staffToken(c, { invoices: 'full' });
    const memoOk = await h.request('POST', `/api/v1/credit-memos/${memo}/email-later`, invoicesOnly, message());
    expect(memoOk.status, JSON.stringify(memoOk.json)).toBe(201);
    const receiptNo = await h.request('POST', `/api/v1/sales-receipts/${receipt}/email-later`, invoicesOnly, message());
    expect([receiptNo.status, receiptNo.json['error']?.code]).toEqual([403, 'PERMISSION_DENIED']);
    expect(mocks.sent).toHaveLength(0);
    const rows = await db.select().from(formEmailQueue).where(and(eq(formEmailQueue.tenantId, c.tenantId), eq(formEmailQueue.transactionId, memo)));
    expect(rows).toHaveLength(1);
  });
});
