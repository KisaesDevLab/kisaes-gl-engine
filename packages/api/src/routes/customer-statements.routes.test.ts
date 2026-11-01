// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// U-112 / U-140 (customer-statement-v1, customer-statement-send-v1,
// idempotency-customer-statements-v1): statements from the open-items
// helper, golden case 5, numbered id-free snapshots, sending, the Outbox,
// portability registration and the 0250 rollback.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ sent: [] as Array<Record<string, unknown>> }));
vi.mock('nodemailer', () => ({
  default: {
    createTransport: () => ({
      verify: async () => true,
      sendMail: async (mail: Record<string, unknown>) => { mocks.sent.push(mail); return { messageId: 'm-' + mocks.sent.length }; },
    }),
  },
}));

// First: it wraps only the route layers created after it loads.
import 'express-async-errors';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { companies, contacts, customerStatementEmailQueue, customerStatementSendEvents, customerStatements, customerStatementRuns, formEmailQueue } from '../db/schema/index.js';
import { paymentsRouter } from './payments.routes.js';
import { transactionsRouter } from './transactions.routes.js';
import { formsRouter } from './forms.routes.js';
import { customerStatementReportsRouter, customerStatementRunsRouter, customerStatementsRouter } from './customer-statements.routes.js';
import { DESKTOP_CAPABILITIES } from '../desktop/capabilities.js';
import { SOFT_REFS } from '../services/tenant-portability/plan.js';
import { buildARAgingSummary } from '../services/report.service.js';
import { Harness, type Co, golden, key, contactAR } from './receivables.test-support.js';

const h = new Harness();
let c: Co;
type Step = Record<string, any>;
const steps = (golden['cases'] as Array<{ id: number; steps: Step[] }>).find((x) => x.id === 5)!.steps;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const PDF = Buffer.from('%PDF-1.4\n% statement\n').toString('base64');

beforeEach(async () => {
  mocks.sent.length = 0;
  h.extraCleanup = [async (tid) => {
    await db.delete(customerStatementEmailQueue).where(eq(customerStatementEmailQueue.tenantId, tid));
    await db.delete(customerStatementSendEvents).where(eq(customerStatementSendEvents.tenantId, tid));
    await db.delete(customerStatements).where(eq(customerStatements.tenantId, tid));
    await db.delete(customerStatementRuns).where(eq(customerStatementRuns.tenantId, tid));
    await db.delete(formEmailQueue).where(eq(formEmailQueue.tenantId, tid));
  }];
  await h.start([
    ['/api/v1/payments', paymentsRouter], ['/api/v1/transactions', transactionsRouter], ['/api/v1/forms', formsRouter],
    ['/api/v1/reports', customerStatementReportsRouter], ['/api/v1/customer-statement-runs', customerStatementRunsRouter],
    ['/api/v1/customer-statements', customerStatementsRouter],
  ]);
  c = await h.company();
  await db.update(contacts).set({ email: 'ap@bluestem.example', billingLine1: '400 Bluestem Rd', billingCity: 'Neosho', billingState: 'MO', billingZip: '64850' })
    .where(eq(contacts.id, c.customer));
  await db.update(companies).set({ smtpHost: 'mail.example.test', smtpPort: 587, smtpFrom: 'billing@example.test' }).where(eq(companies.id, c.companyId));
  await h.seed(c);
  await h.legacyMemo(c, '2026-11-02', '399.75');
  await h.receive(c, { date: '2026-11-30', amount: '50.00' });
});
afterEach(async () => { await h.stop(); });

const statement = (q: string) => h.request('GET', `/api/v1/reports/customer-statement?contactId=${c.customer}&${q}`, c.token);

describe('customer-statement-v1 (U-112)', () => {
  it('advertises the capabilities', () => {
    for (const cap of ['customer-statement-v1', 'customer-statement-send-v1', 'idempotency-customer-statements-v1']) {
      expect(DESKTOP_CAPABILITIES).toContain(cap);
    }
  });

  it('golden 5: open item aging = A/R aging row = GL; a later payment changes nothing as of 11/30; balance forward', async () => {
    const e = steps[2]!['expect'];
    const check = async () => {
      const r = await statement('asOf=2026-11-30&format=open_item');
      expect(r.status, JSON.stringify(r.json)).toBe(200);
      const st = r.json['statement'];
      expect(st.lines.map((l: Step) => l['open'])).toEqual((e.items as Step[]).map((i) => i['open']));
      expect(st.aging).toEqual(e.aging);
      expect([st.amountDue, st.difference]).toEqual([e.amountDue, e.difference]);
      const summary = await buildARAgingSummary(c.tenantId, '2026-11-30', c.companyId);
      const row = summary.customers.find((x) => x.contactId === c.customer)!;
      expect({ ...row.buckets, total: row.total }).toEqual(st.aging);
      expect(await contactAR(c, c.customer, '2026-11-30')).toBe(e.contactBalance);
      expect(st.contact.address).toEqual(['400 Bluestem Rd', 'Neosho, MO 64850']);
    };
    await check();
    await h.receive(c, { date: '2026-12-03', amount: '100.00' });
    await check();
    const bf = steps[5]!['request'];
    const r = await statement(`asOf=${bf.asOf}&format=${bf.format}&start=${bf.start}`);
    const st = r.json['statement'];
    expect(st.openingBalance).toBe(steps[5]!['expect'].openingBalance);
    expect(st.lines.map((l: Step) => ({ date: l['date'], amount: l['amount'], balance: l['balance'] }))).toEqual(steps[5]!['expect'].lines);
    expect(st.amountDue).toBe(steps[5]!['expect'].amountDue);
  });

  it('the batch picker lists clients with a balance', async () => {
    const r = await h.request('GET', '/api/v1/reports/customer-statements?asOf=2026-11-30', c.token);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json['data']).toEqual([{ contactId: c.customer, name: 'Bluestem Veterinary Clinic', amountDue: '300.25', oldestDaysOverdue: 46, hasEmail: true }]);
    const r2 = await h.request('GET', '/api/v1/reports/customer-statements?asOf=2026-11-30&minDaysOverdue=60', c.token);
    expect(r2.json['data']).toEqual([]);
  });
});

describe('customer-statement-send-v1 (U-140)', () => {
  async function run(k = key()) {
    return h.request('POST', '/api/v1/customer-statement-runs', c.token, { asOf: '2026-11-30', contactIds: [c.customer] }, { 'Idempotency-Key': k });
  }

  it('a run issues numbered id-free snapshots; replay rebuilds it; a later payment leaves the snapshot alone', async () => {
    const k = key();
    const r = await run(k);
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    expect(r.json['statements']).toEqual([expect.objectContaining({ contactId: c.customer, amountDue: '300.25' })]);
    const again = await run(k);
    expect(again.json).toEqual(r.json);
    const id = r.json['statements'][0].statementId;
    const before = (await h.request('GET', `/api/v1/customer-statements/${id}`, c.token)).json['statement'];
    expect(JSON.stringify(before.snapshot)).not.toMatch(UUID);
    expect(before.snapshot.amountDue).toBe('300.25');
    await h.receive(c, { date: '2026-11-15', amount: '20.00' });
    const after = (await h.request('GET', `/api/v1/customer-statements/${id}`, c.token)).json['statement'];
    expect(after.snapshot).toEqual(before.snapshot);
    const second = await run();
    expect(second.json['statements'][0].number).not.toBe(r.json['statements'][0].number);
    const list = await h.request('GET', `/api/v1/customer-statements?contactId=${c.customer}`, c.token);
    expect(list.json['data'].length).toBe(2);
    const many = await h.request('POST', '/api/v1/customer-statement-runs', c.token,
      { asOf: '2026-11-30', contactIds: Array.from({ length: 501 }, () => c.customer) });
    expect([many.status, many.json['error'].code]).toEqual([400, 'TOO_MANY_CONTACTS']);
  });

  it('mark sent, email with a fake transport, the Outbox lists and sends a statement', async () => {
    const id = (await run()).json['statements'][0].statementId;
    let r = await h.request('POST', `/api/v1/customer-statements/${id}/sent`, c.token, { method: 'printed' }, { 'Idempotency-Key': key() });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json['statement'].sendHistory.map((x: Step) => x['method'])).toEqual(['printed']);
    const msg = { to: ['ap@bluestem.example'], cc: [], bcc: [], subject: 'Statement', body: 'Attached.' };
    r = await h.request('POST', `/api/v1/customer-statements/${id}/email-later`, c.token, msg, { 'Idempotency-Key': key() });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    expect(r.json['item']).toMatchObject({ kind: 'customer_statement', customerStatementId: id, transactionId: null });
    const outboxId = r.json['item'].id;
    const q = await h.request('GET', '/api/v1/forms/email-queue', c.token);
    expect(JSON.stringify(q.json)).toContain(outboxId);
    r = await h.request('POST', `/api/v1/customer-statements/${id}/email`, c.token,
      { ...msg, pdfFileName: 'Statement.pdf', pdfBase64: PDF, outboxId }, { 'Idempotency-Key': key() });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(mocks.sent.length).toBe(1);
    expect(r.json['statement'].sendHistory.map((x: Step) => x['method'])).toEqual(['printed', 'email']);
    const q2 = await h.request('GET', '/api/v1/forms/email-queue', c.token);
    expect(JSON.stringify(q2.json)).not.toContain(outboxId);
    const other = await h.company();
    const x = await h.request('GET', `/api/v1/customer-statements/${id}`, other.token);
    expect(x.status).toBe(404);
  });

  it('every new uuid column is registered for tenant portability', () => {
    for (const col of ['customer_statement_runs.company_id', 'customer_statements.contact_id', 'customer_statements.run_id',
      'customer_statement_send_events.customer_statement_id', 'customer_statement_email_queue.customer_statement_id']) {
      expect(SOFT_REFS[col], col).toBeDefined();
    }
  });

  it('0250 rolls back with statement send history present, and applies again', async () => {
    const id = (await run()).json['statements'][0].statementId;
    await h.request('POST', `/api/v1/customer-statements/${id}/sent`, c.token, { method: 'pdf' });
    await h.request('POST', `/api/v1/customer-statements/${id}/email-later`, c.token, { to: ['ap@bluestem.example'], cc: [], bcc: [], subject: 's', body: 'b' });
    const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../db/migrations');
    const run_ = async (file: string) => {
      for (const stmt of readFileSync(path.join(dir, file), 'utf8').split('--> statement-breakpoint')) {
        const body = stmt.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').trim();
        if (body) await db.execute(sql.raw(body));
      }
    };
    await run_('0250_customer_statements.rollback.sql');
    const gone = await db.execute(sql`SELECT to_regclass('public.customer_statements') AS t`);
    expect((gone.rows[0] as { t: string | null }).t).toBeNull();
    await run_('0250_customer_statements.sql');
    const back = await db.execute(sql`SELECT to_regclass('public.customer_statements') AS t`);
    expect((back.rows[0] as { t: string | null }).t).not.toBeNull();
  });
});

describe('P22 review fixes (E4)', () => {
  const runIn = (headers: Record<string, string> = {}, token = c.token) => h.request('POST', '/api/v1/customer-statement-runs', token,
    { asOf: '2026-11-30', contactIds: [c.customer] }, { 'Idempotency-Key': key(), ...headers });

  it("another company's client and statements are 404 on every statement route", async () => {
    const r = await runIn();
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    const id = r.json['statements'][0].statementId;
    const b = await h.secondCompany(c);
    const other = await runIn(b);
    expect(other.status, JSON.stringify(other.json)).toBe(404);
    const rep = await h.request('GET', `/api/v1/reports/customer-statement?contactId=${c.customer}&asOf=2026-11-30`, c.token, undefined, b);
    expect(rep.status).toBe(404);
    expect((await h.request('GET', `/api/v1/customer-statements/${id}`, c.token, undefined, b)).status).toBe(404);
    const list = await h.request('GET', `/api/v1/customer-statements?contactId=${c.customer}`, c.token, undefined, b);
    expect([list.status, list.json['data']]).toEqual([200, []]);
    const msg = { to: ['ap@bluestem.example'], cc: [], bcc: [], subject: 's', body: 'b' };
    for (const [p, body] of [[`/${id}/sent`, { method: 'printed' }], [`/${id}/email-later`, msg],
      [`/${id}/email`, { ...msg, pdfFileName: 'Statement.pdf', pdfBase64: PDF }]] as const) {
      const x = await h.request('POST', `/api/v1/customer-statements${p}`, c.token, body, { 'Idempotency-Key': key(), ...b });
      expect(x.status, `${p} ${JSON.stringify(x.json)}`).toBe(404);
    }
    expect(mocks.sent.length).toBe(0);
    const mine = (await h.request('GET', `/api/v1/customer-statements/${id}`, c.token)).json['statement'];
    expect(mine.sendHistory).toEqual([]);
  });

  it('roles without invoices (runs, statements) or reports (statement report) are 403', async () => {
    const bankingOnly = await h.staffToken(c, { banking: 'full' });
    const r = await runIn({}, bankingOnly);
    expect([r.status, r.json['error']?.code]).toEqual([403, 'PERMISSION_DENIED']);
    for (const path of ['/api/v1/customer-statements', `/api/v1/reports/customer-statement?contactId=${c.customer}&asOf=2026-11-30`,
      '/api/v1/reports/customer-statements?asOf=2026-11-30']) {
      const x = await h.request('GET', path, bankingOnly);
      expect([x.status, x.json['error']?.code], path).toEqual([403, 'PERMISSION_DENIED']);
    }
  });
});
