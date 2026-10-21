// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// The recurring catch-up run (ClientLedger U-63, recurring-run-due-v1) and
// the occurrence actions (U-62 enter / skip / resolve). Past dates are the
// simulated clock (asOf).
//   - monthly auto from Jan 31: asOf Apr 30 posts Jan 31, Feb 28, Mar 31,
//     Apr 30; again posts nothing; a NEW PROCESS on the same database posts
//     nothing; asOf Jun 30 posts two more; provenance on every posting; the
//     GL is exactly 6 × the amount;
//   - remainingCount and endDate stop the schedule; remind mode is listed,
//     never posted or advanced; limit / more; the same runId returns the
//     earlier posts; asOf in the future and a closingPassword are 400;
//   - closed period: dates on or before the lock date are skipped
//     CLOSED_PERIOD, later ones post; enter with the closing password posts
//     and writes the override audit row; skip, resolve, OCCURRENCE_TAKEN,
//     OCCURRENCE_NOT_DUE, enter early;
//   - failure paths: an inactive account is skipped with no money moved; an
//     error after the posting (simulated crash between claim and post)
//     leaves nothing and the next run posts once;
//   - legacy and compatibility: POST /recurring from an invoice, post-now,
//     processAllDue, the stale claim listed as NEEDS_CHECK;
//   - no float arithmetic on money in the templates code.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq, sql } from 'drizzle-orm';
import DecimalLib from 'decimal.js';
import { db } from '../../db/index.js';
import {
  accounts, auditLog, companies, journalLines, recurringSchedules, templateOccurrences, transactions,
} from '../../db/schema/index.js';
import * as ledger from '../ledger.service.js';
import * as recurringService from '../recurring.service.js';
import { hashClosingPassword } from '../closing-password.service.js';
import * as occurrences from './occurrences.service.js';
import { TestServer, makeCompany, cleanTenant, transferDraft, monthlyAuto, type Co } from './templates.test-helpers.js';

const Decimal = DecimalLib.default || DecimalLib;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const srv = new TestServer();
const tenantIds: string[] = [];
let c: Co;

beforeEach(async () => {
  await srv.start();
  c = await makeCompany('run', tenantIds);
});

afterEach(async () => {
  occurrences.__testHooks.afterReplay = undefined;
  await srv.stop();
  while (tenantIds.length) await cleanTenant(tenantIds.pop()!);
});

const createTemplate = async (body: Record<string, unknown>, co = c.companyId) => {
  const r = await srv.request('POST', '/api/v1/templates', c.token, body, co);
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return r.json.template as { id: string; version: number };
};
const runDue = (body: Record<string, unknown>, co = c.companyId) => srv.request('POST', '/api/v1/recurring/run-due', c.token, body, co);
const actor = () => ({ tenantId: c.tenantId, companyId: c.companyId, userId: c.userId });

async function schedOf(templateId: string) {
  const [s] = await db.select().from(recurringSchedules).where(eq(recurringSchedules.templateId, templateId));
  return s!;
}

async function balance(accountId: string) {
  return (await db.query.accounts.findFirst({ where: eq(accounts.id, accountId) }))!.balance;
}

async function txnsOf(tenantId = c.tenantId) {
  return db.select().from(transactions).where(eq(transactions.tenantId, tenantId)).orderBy(transactions.txnDate);
}

/** Runs runDue in a new Node process on the same database (an engine restart). */
function runDueInNewProcess(asOf: string): Promise<{ posted: unknown[]; skipped: unknown[] }> {
  const file = path.join(HERE, 'occurrences.service.ts').replace(/\\/g, '/');
  const code = `
    const m = await import(${JSON.stringify(`file:///${file.replace(/^\//, '')}`)});
    const r = await m.runDue({ tenantId: ${JSON.stringify(c.tenantId)}, companyId: ${JSON.stringify(c.companyId)} }, { asOf: ${JSON.stringify(asOf)} });
    process.stdout.write('RESULT' + JSON.stringify({ posted: r.posted, skipped: r.skipped }));
    process.exit(0);
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
      cwd: path.resolve(HERE, '..', '..', '..'), env: process.env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += String(d); });
    child.stderr.on('data', (d) => { err += String(d); });
    child.on('exit', (code) => {
      const i = out.indexOf('RESULT');
      if (code !== 0 || i < 0) reject(new Error(`child exited ${code}: ${err.slice(0, 2000)}`));
      else resolve(JSON.parse(out.slice(i + 'RESULT'.length)));
    });
  });
}

describe('run-due: exactly once, month-end anchoring, provenance', () => {
  it('Jan 31 monthly: 4 posts by Apr 30, none again (also from a new process), 2 more by Jun 30', { timeout: 120_000 }, async () => {
    const t = await createTemplate({ name: 'Sweep', kind: 'transfer', draft: transferDraft(c, '49.0000'), schedule: monthlyAuto('2026-01-31') });
    const r1 = await runDue({ asOf: '2026-04-30' });
    expect(r1.status, JSON.stringify(r1.json)).toBe(200);
    expect(r1.json.posted.map((p: { occurrenceDate: string }) => p.occurrenceDate)).toEqual(['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']);
    expect(r1.json.posted[0]).toMatchObject({ templateId: t.id, templateName: 'Sweep', kind: 'transfer', total: '49.0000' });
    expect(r1.json).toMatchObject({ asOf: '2026-04-30', more: false, skipped: [], failed: [], reminders: [] });
    expect((await schedOf(t.id)).nextOccurrence).toBe('2026-05-31');

    const r2 = await runDue({ asOf: '2026-04-30' });
    expect(r2.json.posted).toEqual([]);
    const fromNewProcess = await runDueInNewProcess('2026-04-30');
    expect(fromNewProcess.posted).toEqual([]);

    const r3 = await runDue({ asOf: '2026-06-30' });
    expect(r3.json.posted.map((p: { occurrenceDate: string }) => p.occurrenceDate)).toEqual(['2026-05-31', '2026-06-30']);

    const posted = await txnsOf();
    expect(posted.map((x) => x.txnDate)).toEqual(['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31', '2026-06-30']);
    const sched = await schedOf(t.id);
    for (const x of posted) {
      expect(x).toMatchObject({ source: 'recurring', sourceId: t.id, recurringScheduleId: sched.id, isRecurring: true, companyId: c.companyId });
    }
    // Exactly 6 × 49.0000 moved, to the cent and beyond.
    expect(new Decimal(await balance(c.savings) ?? '0').toFixed(4)).toBe('294.0000');
    const sums = await db.execute(sql`SELECT SUM(debit)::text AS d, SUM(credit)::text AS cr FROM journal_lines WHERE tenant_id = ${c.tenantId}`);
    expect(sums.rows[0]).toEqual({ d: '294.0000', cr: '294.0000' });
    const occ = await db.select().from(templateOccurrences).where(eq(templateOccurrences.templateId, t.id));
    expect(occ).toHaveLength(6);
    expect(occ.every((o) => o.status === 'posted' && o.transactionId)).toBe(true);
  });

  it('remainingCount and endDate stop the schedule', async () => {
    const a = await createTemplate({ name: 'Two', kind: 'transfer', draft: transferDraft(c), schedule: monthlyAuto('2026-01-15', { remainingCount: 2 }) });
    const b = await createTemplate({ name: 'Ends', kind: 'transfer', draft: transferDraft(c), schedule: monthlyAuto('2026-01-15', { endDate: '2026-03-01' }) });
    const r = await runDue({ asOf: '2026-06-30' });
    const dates = (id: string) => r.json.posted.filter((p: { templateId: string }) => p.templateId === id).map((p: { occurrenceDate: string }) => p.occurrenceDate);
    expect(dates(a.id)).toEqual(['2026-01-15', '2026-02-15']);
    expect(dates(b.id)).toEqual(['2026-01-15', '2026-02-15']);
    expect(await schedOf(a.id)).toMatchObject({ isActive: false, remainingCount: 0 });
    expect(await schedOf(b.id)).toMatchObject({ isActive: false });
  });

  it('remind mode: listed with its due dates, never posted or advanced', async () => {
    const t = await createTemplate({ name: 'Rent', kind: 'transfer', draft: transferDraft(c), schedule: monthlyAuto('2026-01-31', { mode: 'remind' }) });
    const r = await runDue({ asOf: '2026-04-30' });
    expect(r.json.posted).toEqual([]);
    expect(r.json.reminders).toEqual([{
      templateId: t.id, templateName: 'Rent', kind: 'transfer', clientForm: null,
      dueDates: ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30'], dueCount: 4, total: '49.0000',
    }]);
    expect((await schedOf(t.id)).nextOccurrence).toBe('2026-01-31');
    expect(await txnsOf()).toHaveLength(0);
    const att = await srv.request('GET', '/api/v1/recurring/attention?asOf=2026-04-30', c.token, undefined, c.companyId);
    expect(att.json.reminders[0].dueCount).toBe(4);
  });

  it('limit and more; the same runId returns the earlier posts', async () => {
    await createTemplate({ name: 'Daily', kind: 'transfer', draft: transferDraft(c, '1.0000'), schedule: { mode: 'auto', frequency: 'daily', nextDate: '2026-01-01' } });
    const runId = '5a4a8f6e-3c51-4a0b-9d0e-2f1c3b4a5d6e';
    const a = await runDue({ asOf: '2026-03-01', limit: 20, runId });
    expect(a.json.posted).toHaveLength(20);
    expect(a.json.more).toBe(true);
    const again = await runDue({ asOf: '2026-03-01', limit: 20, runId });
    expect(again.json.posted).toHaveLength(40);
    const b = await runDue({ asOf: '2026-03-01', limit: 20 });
    expect(b.json.more).toBe(false);
    expect(b.json.posted).toHaveLength(20);
    expect(await txnsOf()).toHaveLength(60);
  });

  it('asOf in the future and a closingPassword in the body are 400', async () => {
    const future = await runDue({ asOf: '2999-01-01' });
    expect(future.status).toBe(400);
    expect(future.json.error.code).toBe('RUN_DUE_FUTURE');
    const pw = await runDue({ asOf: '2026-01-01', closingPassword: 'x' });
    expect(pw.status).toBe(400);
    expect(pw.json.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('closed period and occurrence actions', () => {
  it('skips closed dates, enters one with the password, skip / resolve / taken / not due', async () => {
    await db.update(companies).set({
      lockDate: '2026-02-28', closingPasswordHash: await hashClosingPassword('closing-pass-123'),
    }).where(eq(companies.id, c.companyId));
    const t = await createTemplate({ name: 'Sweep', kind: 'transfer', draft: transferDraft(c), schedule: monthlyAuto('2026-01-31') });
    const r = await runDue({ asOf: '2026-03-31' });
    expect(r.json.posted.map((p: { occurrenceDate: string }) => p.occurrenceDate)).toEqual(['2026-03-31']);
    expect(r.json.skipped).toEqual([
      { templateId: t.id, templateName: 'Sweep', kind: 'transfer', clientForm: null, occurrenceDate: '2026-01-31', reason: 'CLOSED_PERIOD', new: true },
      { templateId: t.id, templateName: 'Sweep', kind: 'transfer', clientForm: null, occurrenceDate: '2026-02-28', reason: 'CLOSED_PERIOD', new: true },
    ]);
    // A later run lists them again, not new.
    expect((await runDue({ asOf: '2026-03-31' })).json.skipped.map((s: { new: boolean }) => s.new)).toEqual([false, false]);

    // Enter a skipped date with the closing-date password.
    const noPw = await srv.request('POST', `/api/v1/templates/${t.id}/enter`, c.token, { occurrenceDate: '2026-02-28' }, c.companyId);
    expect(noPw.status).toBe(423);
    const withPw = await srv.request('POST', `/api/v1/templates/${t.id}/enter`, c.token,
      { occurrenceDate: '2026-01-31', closingPassword: 'closing-pass-123' }, c.companyId);
    expect(withPw.status, JSON.stringify(withPw.json)).toBe(201);
    expect(withPw.json.occurrence).toMatchObject({ occurrenceDate: '2026-01-31', status: 'entered' });
    expect(withPw.json.transaction).toMatchObject({ txnDate: '2026-01-31', source: 'recurring', sourceId: t.id });
    const override = await db.select().from(auditLog).where(and(eq(auditLog.tenantId, c.tenantId), eq(auditLog.entityType, 'closing_date_override')));
    expect(override.length).toBe(1);

    // Skip the other one; taken dates and dates that aren't due.
    const skip = await srv.request('POST', `/api/v1/templates/${t.id}/occurrences/2026-02-28/skip`, c.token, {}, c.companyId);
    expect(skip.json.occurrence.status).toBe('dismissed');
    expect((await srv.request('POST', `/api/v1/templates/${t.id}/enter`, c.token, { occurrenceDate: '2026-03-31' }, c.companyId)).json.error.code).toBe('OCCURRENCE_TAKEN');
    expect((await srv.request('POST', `/api/v1/templates/${t.id}/enter`, c.token, { occurrenceDate: '2026-02-28' }, c.companyId)).json.error.code).toBe('OCCURRENCE_TAKEN');
    const notDue = await srv.request('POST', `/api/v1/templates/${t.id}/enter`, c.token, { occurrenceDate: '2026-06-15' }, c.companyId);
    expect(notDue.status).toBe(400);
    expect(notDue.json.error.code).toBe('OCCURRENCE_NOT_DUE');
    expect((await srv.request('GET', '/api/v1/recurring/attention?asOf=2026-03-31', c.token, undefined, c.companyId)).json.skipped).toEqual([]);

    // Resolve the next date (Apr 30) with a transfer saved through the form.
    const saved = await srv.request('POST', '/api/v1/transactions', c.token,
      { txnType: 'transfer', txnDate: '2026-04-30', fromAccountId: c.bank, toAccountId: c.savings, amount: '49.0000' }, c.companyId);
    const deposit = await ledger.postTransaction(c.tenantId, {
      txnType: 'deposit', txnDate: '2026-04-30', total: '1.0000',
      lines: [{ accountId: c.bank, debit: '1.0000', credit: '0' }, { accountId: c.income, debit: '0', credit: '1.0000' }],
    }, c.userId, c.companyId);
    const wrongKind = await srv.request('POST', `/api/v1/templates/${t.id}/occurrences/2026-04-30/resolve`, c.token, { transactionId: deposit.id }, c.companyId);
    expect(wrongKind.json.error.code).toBe('OCCURRENCE_RESOLVE_INVALID');
    const resolved = await srv.request('POST', `/api/v1/templates/${t.id}/occurrences/2026-04-30/resolve`, c.token, { transactionId: saved.json.transaction.id }, c.companyId);
    expect(resolved.status, JSON.stringify(resolved.json)).toBe(200);
    expect(resolved.json.occurrence.status).toBe('entered');
    expect((await schedOf(t.id)).nextOccurrence).toBe('2026-05-31');
    const again = await srv.request('POST', `/api/v1/templates/${t.id}/occurrences/2026-04-30/resolve`, c.token, { transactionId: saved.json.transaction.id }, c.companyId);
    expect(again.status).toBe(400);

    // Enter early: the next date may be entered before it is due.
    const early = await srv.request('POST', `/api/v1/templates/${t.id}/enter`, c.token, {}, c.companyId);
    expect(early.status, JSON.stringify(early.json)).toBe(201);
    expect(early.json.occurrence.occurrenceDate).toBe('2026-05-31');
    expect((await schedOf(t.id)).nextOccurrence).toBe('2026-06-30');
  });
});

describe('failure paths', () => {
  it('an inactive account: skipped, nothing posted, balances unchanged', async () => {
    const t = await createTemplate({
      name: 'Phone', kind: 'expense', draft: { payFromAccountId: c.bank, lines: [{ expenseAccountId: c.expense, amount: '89.9900' }] },
      schedule: monthlyAuto('2026-01-10'),
    });
    await db.update(accounts).set({ isActive: false }).where(eq(accounts.id, c.expense));
    const before = { bank: await balance(c.bank), exp: await balance(c.expense) };
    const r = await runDue({ asOf: '2026-01-31' });
    expect(r.json.posted).toEqual([]);
    expect(r.json.skipped).toMatchObject([{ templateId: t.id, occurrenceDate: '2026-01-10', reason: 'INVALID_ACCOUNT', new: true }]);
    expect({ bank: await balance(c.bank), exp: await balance(c.expense) }).toEqual(before);
    expect(await txnsOf()).toHaveLength(0);
    expect(await db.select().from(journalLines).where(eq(journalLines.tenantId, c.tenantId))).toHaveLength(0);
  });

  it('a crash between claim and post leaves nothing; the next run posts once', async () => {
    const t = await createTemplate({
      name: 'Rent', kind: 'check',
      draft: { bankAccountId: c.bank, payeeNameOnCheck: 'Landlord', amount: '1500.0000', printLater: false, lines: [{ accountId: c.expense, amount: '1500.0000' }] },
      schedule: monthlyAuto('2026-01-01'),
    });
    const [co] = await db.select({ s: companies.checkSettings }).from(companies).where(eq(companies.id, c.companyId));
    const bankBefore = await balance(c.bank);
    occurrences.__testHooks.afterReplay = () => { throw new Error('simulated crash after posting'); };
    const crashed = await runDue({ asOf: '2026-01-31' });
    expect(crashed.status).toBe(200);
    expect(crashed.json.failed).toEqual([{ templateId: t.id, reason: 'INTERNAL' }]);
    expect(crashed.json.posted).toEqual([]);
    expect(await txnsOf()).toHaveLength(0);
    expect(await db.select().from(templateOccurrences).where(eq(templateOccurrences.templateId, t.id))).toHaveLength(0);
    expect((await schedOf(t.id)).nextOccurrence).toBe('2026-01-01');
    expect(await balance(c.bank)).toBe(bankBefore);
    const [coAfter] = await db.select({ s: companies.checkSettings }).from(companies).where(eq(companies.id, c.companyId));
    expect(coAfter!.s).toEqual(co!.s);

    occurrences.__testHooks.afterReplay = undefined;
    const ok = await runDue({ asOf: '2026-01-31' });
    expect(ok.json.posted.map((p: { occurrenceDate: string }) => p.occurrenceDate)).toEqual(['2026-01-01']);
    const posted = await txnsOf();
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ checkNumber: 1001, printStatus: 'hand_written', total: '1500.0000' });
    expect((await runDue({ asOf: '2026-01-31' })).json.posted).toEqual([]);
  });
});

describe('legacy schedules and the web / server paths', () => {
  it('POST /recurring from an invoice: legacy template, post-now, claims recorded', async () => {
    const invoice = await ledger.postTransaction(c.tenantId, {
      txnType: 'invoice', txnDate: '2026-01-05', contactId: c.customer, total: '10.0000',
      lines: [{ accountId: c.ar, debit: '10.0000', credit: '0' }, { accountId: c.income, debit: '0', credit: '10.0000' }],
    }, c.userId, c.companyId);
    const created = await srv.request('POST', '/api/v1/recurring', c.token,
      { templateTransactionId: invoice.id, frequency: 'monthly', startDate: '2026-02-05', mode: 'auto' });
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    expect(created.json.schedule).toMatchObject({ templateTransactionId: invoice.id, nextOccurrence: '2026-02-05' });
    expect(created.json.schedule.templateId).toBeTruthy();
    const list = await srv.request('GET', '/api/v1/recurring', c.token);
    expect(list.json.schedules[0]).toMatchObject({ templateId: created.json.schedule.templateId, templateName: expect.stringMatching(/^Recurring /) });

    const now = await srv.request('POST', `/api/v1/recurring/${created.json.schedule.id}/post-now`, c.token, {});
    expect(now.status, JSON.stringify(now.json)).toBe(201);
    expect(now.json.transaction).toMatchObject({ txnType: 'invoice', txnDate: '2026-02-05', source: 'recurring' });
    const occ = await db.select().from(templateOccurrences).where(eq(templateOccurrences.templateId, created.json.schedule.templateId));
    expect(occ).toMatchObject([{ occurrenceDate: '2026-02-05', status: 'entered', transactionId: now.json.transaction.id }]);
    expect((await db.select().from(recurringSchedules).where(eq(recurringSchedules.id, created.json.schedule.id)))[0]!.nextOccurrence).toBe('2026-03-05');

    // The catch-up run posts the legacy schedule through the old clone path too.
    const r = await runDue({ asOf: '2026-04-05' });
    expect(r.json.posted.map((p: { occurrenceDate: string; kind: string }) => [p.occurrenceDate, p.kind]))
      .toEqual([['2026-03-05', 'legacy'], ['2026-04-05', 'legacy']]);
    expect((await txnsOf()).filter((x) => x.txnType === 'invoice')).toHaveLength(4);

    // A claim a crash left behind is listed as NEEDS_CHECK, never re-posted.
    await db.insert(templateOccurrences).values({
      tenantId: c.tenantId, companyId: c.companyId, templateId: created.json.schedule.templateId, occurrenceDate: '2026-01-05',
      status: 'claiming', createdAt: new Date(Date.now() - 20 * 60_000),
    });
    const att = await srv.request('GET', '/api/v1/recurring/attention?asOf=2026-04-05', c.token, undefined, c.companyId);
    expect(att.json.skipped).toMatchObject([{ occurrenceDate: '2026-01-05', reason: 'NEEDS_CHECK' }]);
    const dismissed = await srv.request('POST', `/api/v1/templates/${created.json.schedule.templateId}/occurrences/2026-01-05/skip`, c.token, {}, c.companyId);
    expect(dismissed.json.occurrence.status).toBe('dismissed');
  });

  it('a web schedule of an expense converts to a draft; processAllDue posts it once', async () => {
    const exp = await ledger.postTransaction(c.tenantId, {
      txnType: 'expense', txnDate: '2026-01-05', total: '12.3456',
      lines: [{ accountId: c.expense, debit: '12.3456', credit: '0' }, { accountId: c.bank, debit: '0', credit: '12.3456' }],
    }, c.userId, c.companyId);
    const sched = await recurringService.create(c.tenantId, exp.id, { frequency: 'monthly', startDate: '2026-02-05', name: 'Supplies' }, c.userId);
    expect(sched!.templateName).toBe('Supplies');
    const tpl = await srv.request('GET', `/api/v1/templates/${sched!.templateId}`, c.token, undefined, c.companyId);
    expect(tpl.json.template).toMatchObject({ kind: 'expense', total: '12.3456', sourceTransactionId: exp.id });
    await db.update(recurringSchedules).set({ nextOccurrence: '2020-01-05', startDate: '2020-01-05', endDate: '2020-02-05' })
      .where(eq(recurringSchedules.id, sched!.id));
    const result = await recurringService.processAllDue();
    expect(result.processed).toBeGreaterThanOrEqual(2);
    const mine = (await txnsOf()).filter((x) => x.sourceId === sched!.templateId);
    expect(mine.map((x) => [x.txnDate, x.total])).toEqual([['2020-01-05', '12.3456'], ['2020-02-05', '12.3456']]);
    expect((await recurringService.processAllDue()).processed).toBe(0);
  });
});

describe('schedules without a template (archive older than 0225)', () => {
  it('are adopted as legacy templates and posted by the run', async () => {
    const exp = await ledger.postTransaction(c.tenantId, {
      txnType: 'expense', txnDate: '2026-01-05', total: '7.0000',
      lines: [{ accountId: c.expense, debit: '7.0000', credit: '0' }, { accountId: c.bank, debit: '0', credit: '7.0000' }],
    }, c.userId, c.companyId);
    const [orphan] = await db.insert(recurringSchedules).values({
      tenantId: c.tenantId, templateTransactionId: exp.id, name: 'Imported', frequency: 'monthly',
      startDate: '2026-02-05', nextOccurrence: '2026-02-05', mode: 'auto', isActive: true,
    }).returning();
    const r = await runDue({ asOf: '2026-02-28' });
    expect(r.json.posted).toMatchObject([{ templateName: 'Imported', occurrenceDate: '2026-02-05', total: '7.0000' }]);
    const [after] = await db.select().from(recurringSchedules).where(eq(recurringSchedules.id, orphan!.id));
    expect(after!.templateId).toBeTruthy();
  });
});

describe('money', () => {
  it('the templates code never converts money to a float', () => {
    const files = [
      ...readdirSync(HERE).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts')).map((f) => path.join(HERE, f)),
      path.resolve(HERE, '..', '..', 'routes', 'templates.routes.ts'),
    ];
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      expect(text, f).not.toMatch(/parseFloat\(|Number\(\s*[a-zA-Z_.]*(amount|debit|credit|total|balance)/i);
    }
  });
});
