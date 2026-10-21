// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// Security review of templates-v1 / recurring-run-due-v1 (engine PR #161):
//   H1  the kind's own permission on top of 'recurring' (create, from-
//       transaction, read, draft, update, enter, resolve; legacy templates
//       use the source transaction's); an auto run posts only while the
//       template's owner (last editor, else creator) holds it, else the
//       date is skipped PERMISSION; ownerless (pre-0225) templates post.
//   M2  an auto next date more than 366 days back is refused; one run
//       handles at most 31 dates per schedule (CATCH_UP_CAPPED, left due);
//       open skipped dates are listed up to 200 with a total.
//   L3  resolve: the transaction's date must be the occurrence date and its
//       company the template's; provenance is audited and left alone in a
//       closed period.
//   L4  from-transaction refuses a company-less transaction.
//   L5  reminder dates are counted up to 400 per schedule (truncated).
//   L6  test hooks are ignored outside NODE_ENV=test.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db } from '../../db/index.js';
import {
  auditLog, companies, recurringSchedules, templateOccurrences, templateTransactions, transactions, userPermissions, users, userTenantAccess,
} from '../../db/schema/index.js';
import * as authService from '../auth.service.js';
import * as ledger from '../ledger.service.js';
import * as checkService from '../check.service.js';
import * as recurringService from '../recurring.service.js';
import * as occurrences from './occurrences.service.js';
import { TestServer, makeCompany, cleanTenant, transferDraft, monthlyAuto, suffix, PINNED_TODAY, type Co } from './templates.test-helpers.js';

const srv = new TestServer();
const tenantIds: string[] = [];
let c: Co;

beforeEach(async () => {
  await srv.start();
  c = await makeCompany('sec', tenantIds);
});

afterEach(async () => {
  occurrences.__testHooks.afterReplay = undefined;
  occurrences.__testHooks.inReplay = undefined;
  await srv.stop();
  while (tenantIds.length) await cleanTenant(tenantIds.pop()!);
});

/** A bookkeeper of c's tenant with exactly these permissions. */
async function bookkeeper(overrides: Record<string, string>) {
  const [u] = await db.insert(users).values({
    tenantId: c.tenantId, email: `bk-${suffix()}@example.com`, passwordHash: 'x', displayName: 'Bookkeeper', role: 'bookkeeper',
  }).returning();
  await db.insert(userTenantAccess).values({ userId: u!.id, tenantId: c.tenantId, role: 'bookkeeper' });
  await db.insert(userPermissions).values({ tenantId: c.tenantId, userId: u!.id, overrides: overrides as never });
  const token = (await authService.issueSession({ userId: u!.id, tenantId: c.tenantId, role: 'bookkeeper', email: u!.email } as never)).accessToken;
  return { id: u!.id, token };
}

async function setPermissions(userId: string, overrides: Record<string, string>) {
  await db.update(userPermissions).set({ overrides: overrides as never })
    .where(and(eq(userPermissions.tenantId, c.tenantId), eq(userPermissions.userId, userId)));
}

const req = (method: string, path: string, token: string, body?: unknown) => srv.request(method, `/api/v1${path}`, token, body, c.companyId);

const checkDraft = () => ({
  bankAccountId: c.bank, payeeNameOnCheck: 'Cosmos Granite', amount: '10.0000', lines: [{ accountId: c.expense, amount: '10.0000' }],
});

async function createAs(token: string, body: Record<string, unknown>) {
  const r = await req('POST', '/templates', token, body);
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return r.json.template as { id: string; version: number };
}

async function txnCount() {
  return (await db.select({ id: transactions.id }).from(transactions).where(eq(transactions.tenantId, c.tenantId))).length;
}

describe('H1: the kind’s own permission', () => {
  it('create, read, draft, update, enter and from-transaction need the kind’s permission', async () => {
    const bk = await bookkeeper({ recurring: 'full', transactions: 'full' });
    const denied = (r: { status: number; json: { error: { code: string } } }) => {
      expect(r.status, JSON.stringify(r.json)).toBe(403);
      expect(r.json.error.code).toBe('PERMISSION_DENIED');
    };

    // A transfer is 'transactions': allowed. A check is 'checks': refused.
    await createAs(bk.token, { name: 'Sweep', kind: 'transfer', draft: transferDraft(c) });
    denied(await req('POST', '/templates', bk.token, { name: 'Rent', kind: 'check', draft: checkDraft() }));
    denied(await req('POST', '/templates', bk.token, { name: 'In', kind: 'deposit', draft: { depositToAccountId: c.bank, lines: [{ accountId: c.income, amount: '5' }] } }));

    // A check template the owner made: no read, draft, update or enter.
    const check = await createAs(c.token, { name: 'Rent', kind: 'check', draft: checkDraft() });
    denied(await req('GET', `/templates/${check.id}`, bk.token));
    denied(await req('GET', `/templates/${check.id}/draft`, bk.token));
    denied(await req('PUT', `/templates/${check.id}`, bk.token, { version: 1, name: 'Mine' }));
    denied(await req('POST', `/templates/${check.id}/enter`, bk.token, {}));
    expect(await txnCount()).toBe(0);
    // Another company's template is still 404, not 403.
    expect((await srv.request('GET', `/api/v1/templates/${check.id}`, bk.token, undefined, c.companyB)).status).toBe(404);

    // checks: view reads it but can't change or post it.
    await setPermissions(bk.id, { recurring: 'full', transactions: 'full', checks: 'view' });
    expect((await req('GET', `/templates/${check.id}/draft`, bk.token)).status).toBe(200);
    expect((await req('GET', `/templates/${check.id}`, bk.token)).status).toBe(200);
    denied(await req('POST', `/templates/${check.id}/enter`, bk.token, {}));

    // from-transaction: the source's permission (check -> checks; invoice -> invoices).
    const posted = await checkService.createCheck(c.tenantId, {
      bankAccountId: c.bank, payeeNameOnCheck: 'Cosmos Granite', txnDate: '2026-01-15', amount: '10.0000',
      printLater: false, lines: [{ accountId: c.expense, amount: '10.0000' }],
    }, c.userId, c.companyId);
    denied(await req('POST', '/templates/from-transaction', bk.token, { transactionId: posted.id, name: 'From check' }));
    const invoice = await ledger.postTransaction(c.tenantId, {
      txnType: 'invoice', txnDate: '2026-01-15', contactId: c.customer, total: '10.0000',
      lines: [{ accountId: c.ar, debit: '10.0000', credit: '0' }, { accountId: c.income, debit: '0', credit: '10.0000' }],
    }, c.userId, c.companyId);
    denied(await req('POST', '/templates/from-transaction', bk.token, { transactionId: invoice.id, name: 'Retainer' }));
    // A legacy (invoice) template: enter needs invoices.
    const legacy = (await req('POST', '/templates/from-transaction', c.token, { transactionId: invoice.id, name: 'Retainer' })).json.template;
    expect(legacy.kind).toBe('legacy');
    denied(await req('POST', `/templates/${legacy.id}/enter`, bk.token, {}));
    await setPermissions(bk.id, { recurring: 'full', invoices: 'full' });
    const entered = await req('POST', `/templates/${legacy.id}/enter`, bk.token, {});
    expect(entered.status, JSON.stringify(entered.json)).toBe(201);
    expect(entered.json.transaction.txnType).toBe('invoice');
    // An unknown transaction is 404 whatever the permissions.
    expect((await req('POST', '/templates/from-transaction', bk.token, { transactionId: c.bank, name: 'X' })).status).toBe(404);
  });

  it('an auto run posts only while the owner holds the kind’s permission', async () => {
    const bk = await bookkeeper({ recurring: 'full', transactions: 'full' });
    const t = await createAs(bk.token, { name: 'Sweep', kind: 'transfer', draft: transferDraft(c), schedule: monthlyAuto('2026-01-31') });
    const [row] = await db.select().from(templateTransactions).where(eq(templateTransactions.id, t.id));
    expect(row!.createdBy).toBe(bk.id);

    await setPermissions(bk.id, { recurring: 'full', transactions: 'view' });
    // The run itself is triggered by the owner of the company (full access).
    const r = await req('POST', '/recurring/run-due', c.token, { asOf: '2026-01-31' });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.posted).toEqual([]);
    expect(r.json.skipped).toMatchObject([{ templateId: t.id, occurrenceDate: '2026-01-31', reason: 'PERMISSION', new: true }]);
    expect(await txnCount()).toBe(0);

    await setPermissions(bk.id, { recurring: 'full', transactions: 'full' });
    const ok = await req('POST', '/recurring/run-due', c.token, { asOf: '2026-02-28' });
    expect(ok.json.posted.map((p: { occurrenceDate: string }) => p.occurrenceDate)).toEqual(['2026-02-28']);

    // A deactivated owner: skipped.
    await db.update(users).set({ isActive: false }).where(eq(users.id, bk.id));
    const off = await req('POST', '/recurring/run-due', c.token, { asOf: '2026-03-31' });
    expect(off.json.posted).toEqual([]);
    expect(off.json.skipped.map((s: { reason: string }) => s.reason)).toEqual(['PERMISSION', 'PERMISSION']);
  });

  it('the last editor owns the runs (templates and /recurring); ownerless templates post as before', async () => {
    const t = await createAs(c.token, { name: 'Sweep', kind: 'transfer', draft: transferDraft(c), schedule: monthlyAuto('2026-01-31') });
    const bk = await bookkeeper({ recurring: 'full', transactions: 'full' });
    const put = await req('PUT', `/templates/${t.id}`, bk.token, { version: 1, name: 'Sweep 2' });
    expect(put.status, JSON.stringify(put.json)).toBe(200);
    expect((await db.select().from(templateTransactions).where(eq(templateTransactions.id, t.id)))[0]!.updatedBy).toBe(bk.id);
    await setPermissions(bk.id, { recurring: 'full' });
    expect((await req('POST', '/recurring/run-due', c.token, { asOf: '2026-01-31' })).json.skipped[0].reason).toBe('PERMISSION');

    // A schedule edited through /recurring hands the runs to that user too.
    const t2 = await createAs(c.token, { name: 'Two', kind: 'transfer', draft: transferDraft(c), schedule: monthlyAuto('2026-01-31', { mode: 'remind' }) });
    const [s2] = await db.select().from(recurringSchedules).where(eq(recurringSchedules.templateId, t2.id));
    await recurringService.update(c.tenantId, s2!.id, { mode: 'auto' }, bk.id);
    expect((await db.select().from(templateTransactions).where(eq(templateTransactions.id, t2.id)))[0]!.updatedBy).toBe(bk.id);

    // Ownerless (made by 0225 from an older schedule): posts.
    await db.update(templateTransactions).set({ createdBy: null, updatedBy: null }).where(eq(templateTransactions.id, t.id));
    const r = await req('POST', '/recurring/run-due', c.token, { asOf: '2026-02-28' });
    expect(r.json.posted.map((p: { templateId: string }) => p.templateId)).toEqual([t.id]);
    expect(r.json.skipped.filter((s: { templateId: string; new: boolean }) => s.templateId === t2.id && s.new)).toHaveLength(2);
  });
});

describe('M2: bounded catch-up', () => {
  it('an auto next date more than 366 days back is refused; a reminder is not', async () => {
    const day = (offset: number) => {
      const d = new Date(`${PINNED_TODAY}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() - offset);
      return d.toISOString().slice(0, 10);
    };
    const old = await req('POST', '/templates', c.token, { name: 'Old', kind: 'transfer', draft: transferDraft(c), schedule: monthlyAuto(day(367)) });
    expect(old.status).toBe(400);
    expect(old.json.error).toMatchObject({ code: 'VALIDATION_ERROR', details: { field: 'schedule.nextDate', earliest: day(366) } });
    const edge = await createAs(c.token, { name: 'Edge', kind: 'transfer', draft: transferDraft(c), schedule: monthlyAuto(day(366)) });
    const remind = await createAs(c.token, { name: 'Remind', kind: 'transfer', draft: transferDraft(c), schedule: monthlyAuto(day(400), { mode: 'remind' }) });
    // Switching that reminder to auto is refused; an edit that keeps an auto date is fine.
    const toAuto = await req('PUT', `/templates/${remind.id}`, c.token, { version: 1, schedule: monthlyAuto(day(400)) });
    expect(toAuto.status).toBe(400);
    const keep = await req('PUT', `/templates/${edge.id}`, c.token, { version: 1, name: 'Edge 2', schedule: monthlyAuto(day(366)) });
    expect(keep.status, JSON.stringify(keep.json)).toBe(200);
  });

  it('31 dates per schedule per run; the rest stay due and are listed CATCH_UP_CAPPED', async () => {
    const t = await createAs(c.token, { name: 'Daily', kind: 'transfer', draft: transferDraft(c, '1.0000'), schedule: { mode: 'auto', frequency: 'daily', nextDate: '2026-01-01' } });
    const a = await req('POST', '/recurring/run-due', c.token, { asOf: '2026-03-31' });
    expect(a.json.posted).toHaveLength(31);
    expect(a.json.more).toBe(false);
    expect(a.json.skipped).toEqual([
      { templateId: t.id, templateName: 'Daily', kind: 'transfer', clientForm: null, occurrenceDate: '2026-02-01', reason: 'CATCH_UP_CAPPED', new: true },
    ]);
    expect(a.json.skippedTotal).toBe(1);
    // Nothing recorded for the capped dates: the next run posts them.
    const capped = await db.select().from(templateOccurrences).where(and(eq(templateOccurrences.templateId, t.id), eq(templateOccurrences.status, 'skipped')));
    expect(capped).toEqual([]);
    const b = await req('POST', '/recurring/run-due', c.token, { asOf: '2026-03-31' });
    expect(b.json.posted[0].occurrenceDate).toBe('2026-02-01');
    expect(b.json.posted).toHaveLength(31);
    const third = await req('POST', '/recurring/run-due', c.token, { asOf: '2026-03-31' });
    expect(third.json.posted).toHaveLength(28);
    expect(third.json.skipped).toEqual([]);
    expect(await txnCount()).toBe(90);
  });

  it('open skipped dates: at most 200 listed, with the total', async () => {
    const t = await createAs(c.token, { name: 'Sweep', kind: 'transfer', draft: transferDraft(c) });
    const base = new Date('2025-01-01T00:00:00Z');
    await db.insert(templateOccurrences).values(Array.from({ length: 205 }, (_, i) => {
      const d = new Date(base);
      d.setUTCDate(d.getUTCDate() + i);
      return { tenantId: c.tenantId, companyId: c.companyId, templateId: t.id, occurrenceDate: d.toISOString().slice(0, 10), status: 'skipped' as const, reason: 'VALIDATION' };
    }));
    const att = await req('GET', '/recurring/attention?asOf=2026-01-01', c.token);
    expect(att.json.skipped).toHaveLength(200);
    expect(att.json.skippedTotal).toBe(205);
    expect(att.json.skipped[0].occurrenceDate).toBe('2025-01-01');
  });
});

describe('L3: resolve', () => {
  it('the date must match, the company must match; provenance is audited, not written in a closed period', async () => {
    const t = await createAs(c.token, { name: 'Sweep', kind: 'transfer', draft: transferDraft(c), schedule: monthlyAuto('2026-04-30', { mode: 'remind' }) });
    const form = (date: string, co = c.companyId) => srv.request('POST', '/api/v1/transactions', c.token,
      { txnType: 'transfer', txnDate: date, fromAccountId: c.bank, toAccountId: c.savings, amount: '49.0000' }, co);
    const resolve = (txnId: string, date = '2026-04-30') => req('POST', `/templates/${t.id}/occurrences/${date}/resolve`, c.token, { transactionId: txnId });

    const wrongDate = await form('2026-04-29');
    const r1 = await resolve(wrongDate.json.transaction.id);
    expect(r1.status).toBe(400);
    expect(r1.json.error.code).toBe('OCCURRENCE_RESOLVE_INVALID');

    // A company-less transaction is not the company's.
    const right = await form('2026-04-30');
    await db.update(transactions).set({ companyId: null }).where(eq(transactions.id, right.json.transaction.id));
    expect((await resolve(right.json.transaction.id)).json.error.code).toBe('OCCURRENCE_RESOLVE_INVALID');
    await db.update(transactions).set({ companyId: c.companyId }).where(eq(transactions.id, right.json.transaction.id));

    const ok = await resolve(right.json.transaction.id);
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    const [marked] = await db.select().from(transactions).where(eq(transactions.id, right.json.transaction.id));
    expect(marked).toMatchObject({ source: 'recurring', sourceId: t.id });
    const audit = await db.select().from(auditLog).where(and(
      eq(auditLog.tenantId, c.tenantId), eq(auditLog.entityType, 'transaction'), eq(auditLog.entityId, right.json.transaction.id), eq(auditLog.action, 'update'),
    ));
    expect(audit).toHaveLength(1);
    expect(audit[0]!.afterData).toMatchObject({ source: 'recurring', sourceId: t.id });

    // Closed period: linked, but the posting is not changed.
    const closedTxn = await form('2026-05-30');
    await db.update(companies).set({ lockDate: '2026-06-30' }).where(eq(companies.id, c.companyId));
    const closed = await resolve(closedTxn.json.transaction.id, '2026-05-30');
    expect(closed.status, JSON.stringify(closed.json)).toBe(200);
    expect(closed.json.occurrence.status).toBe('entered');
    const [untouched] = await db.select().from(transactions).where(eq(transactions.id, closedTxn.json.transaction.id));
    expect(untouched!.sourceId).not.toBe(t.id);
  });
});

describe('L4: from-transaction', () => {
  it('refuses a company-less transaction for a company caller', async () => {
    const posted = await checkService.createCheck(c.tenantId, {
      bankAccountId: c.bank, payeeNameOnCheck: 'Cosmos Granite', txnDate: '2026-01-15', amount: '10.0000',
      printLater: false, lines: [{ accountId: c.expense, amount: '10.0000' }],
    }, c.userId, c.companyId);
    await db.update(transactions).set({ companyId: null }).where(eq(transactions.id, posted.id));
    const r = await req('POST', '/templates/from-transaction', c.token, { transactionId: posted.id, name: 'Orphan' });
    expect(r.status).toBe(404);
  });
});

describe('L5: reminder bounds', () => {
  it('counts at most 400 due dates per schedule and says so', async () => {
    await createAs(c.token, { name: 'Daily', kind: 'transfer', draft: transferDraft(c), schedule: { mode: 'remind', frequency: 'daily', nextDate: '2025-01-01' } });
    const att = await req('GET', '/recurring/attention?asOf=2026-03-31', c.token);
    expect(att.json.reminders).toHaveLength(1);
    expect(att.json.reminders[0]).toMatchObject({ dueCount: 400, truncated: true });
    expect(att.json.reminders[0].dueDates).toHaveLength(24);
    expect(att.json.remindersTruncated).toBe(false);
  });
});

describe('L6: test hooks', () => {
  it('are ignored outside NODE_ENV=test', async () => {
    await createAs(c.token, { name: 'Sweep', kind: 'transfer', draft: transferDraft(c), schedule: monthlyAuto('2026-01-31') });
    occurrences.__testHooks.afterReplay = () => { throw new Error('hook ran'); };
    const prev = process.env['NODE_ENV'];
    process.env['NODE_ENV'] = 'production';
    try {
      const r = await occurrences.runDue({ tenantId: c.tenantId, companyId: c.companyId, userId: c.userId }, { asOf: '2026-01-31' });
      expect(r.failed).toEqual([]);
      expect(r.posted).toHaveLength(1);
    } finally {
      process.env['NODE_ENV'] = prev;
    }
  });
});
