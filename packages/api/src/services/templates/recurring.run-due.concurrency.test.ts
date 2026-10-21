// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// Concurrency of the recurring run (U-63): separate pool connections race.
//   - 8 parallel run-due calls: every (template, date) is posted exactly once;
//   - run-due ‖ PUT template ‖ "Enter now" ‖ web post-now: no deadlock
//     (5 s), every date at most once, the schedule consistent;
//   - 4 parallel "Enter now" of check templates on one bank account get
//     distinct check numbers.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { recurringSchedules, templateOccurrences, transactions } from '../../db/schema/index.js';
import * as recurringService from '../recurring.service.js';
import * as occurrences from './occurrences.service.js';
import { TestServer, makeCompany, cleanTenant, transferDraft, monthlyAuto, type Co } from './templates.test-helpers.js';

const srv = new TestServer();
const tenantIds: string[] = [];
let c: Co;

beforeEach(async () => {
  await srv.start();
  c = await makeCompany('conc', tenantIds);
});

afterEach(async () => {
  await srv.stop();
  while (tenantIds.length) await cleanTenant(tenantIds.pop()!);
});

const createTemplate = async (body: Record<string, unknown>) => {
  const r = await srv.request('POST', '/api/v1/templates', c.token, body, c.companyId);
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return r.json.template as { id: string; version: number };
};
const actor = () => ({ tenantId: c.tenantId, companyId: c.companyId, userId: c.userId });

function within<T>(ms: number, p: Promise<T>): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms} ms (deadlock?)`)), ms))]);
}

describe('run-due concurrency', () => {
  it('8 parallel runs post each date exactly once', async () => {
    const ids = [];
    for (let i = 0; i < 3; i++) {
      ids.push((await createTemplate({ name: `T${i}`, kind: 'transfer', draft: transferDraft(c, `${i + 1}.0000`), schedule: monthlyAuto('2026-01-31') })).id);
    }
    const results = await within(30_000, Promise.all(Array.from({ length: 8 }, () => occurrences.runDue(actor(), { asOf: '2026-04-30' }))));
    expect(results.every((r) => r.failed.length === 0)).toBe(true);
    const postedCount = results.reduce((n, r) => n + r.posted.length, 0);
    expect(postedCount).toBe(12);
    const txns = await db.select().from(transactions).where(eq(transactions.tenantId, c.tenantId));
    expect(txns).toHaveLength(12);
    const keys = txns.map((t) => `${t.sourceId}|${t.txnDate}`);
    expect(new Set(keys).size).toBe(12);
    for (const id of ids) {
      const occ = await db.select().from(templateOccurrences).where(eq(templateOccurrences.templateId, id));
      expect(occ.map((o) => o.occurrenceDate).sort()).toEqual(['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']);
    }
  });

  it('run-due ‖ PUT ‖ enter ‖ post-now: no deadlock, consistent', async () => {
    const t = await createTemplate({ name: 'Sweep', kind: 'transfer', draft: transferDraft(c), schedule: monthlyAuto('2026-01-31') });
    const [sched] = await db.select().from(recurringSchedules).where(eq(recurringSchedules.templateId, t.id));
    const settle = (p: Promise<unknown>) => p.then(() => 'ok', (e: { code?: string }) => e.code ?? 'error');
    const outcomes = await within(5_000, Promise.all([
      settle(occurrences.runDue(actor(), { asOf: '2026-03-31' })),
      settle(srv.request('PUT', `/api/v1/templates/${t.id}`, c.token, { version: 1, name: 'Sweep 2' }, c.companyId)),
      settle(occurrences.enterTemplate(actor(), t.id)),
      settle(recurringService.postNext(c.tenantId, sched!.id)),
      settle(occurrences.runDue(actor(), { asOf: '2026-03-31' })),
    ]));
    expect(outcomes.every((o) => ['ok', 'OCCURRENCE_TAKEN', 'OCCURRENCE_NOT_DUE', 'RECURRING_ALREADY_CLAIMED'].includes(o as string)), JSON.stringify(outcomes)).toBe(true);
    const occ = await db.select().from(templateOccurrences).where(eq(templateOccurrences.templateId, t.id));
    const dates = occ.map((o) => o.occurrenceDate);
    expect(new Set(dates).size).toBe(dates.length);
    const txns = await db.select().from(transactions).where(eq(transactions.tenantId, c.tenantId));
    expect(txns).toHaveLength(occ.length);
    expect(new Set(txns.map((x) => x.txnDate)).size).toBe(txns.length);
    // Whatever order they ran in, the next date follows the last handled one.
    const [after] = await db.select().from(recurringSchedules).where(eq(recurringSchedules.id, sched!.id));
    const last = [...dates].sort().at(-1)!;
    const expectedNext: Record<string, string> = { '2026-01-31': '2026-02-28', '2026-02-28': '2026-03-31', '2026-03-31': '2026-04-30', '2026-04-30': '2026-05-31' };
    expect(after!.nextOccurrence).toBe(expectedNext[last]);
  });

  it('4 parallel check enters get distinct numbers', async () => {
    const ids = [];
    for (let i = 0; i < 4; i++) {
      ids.push((await createTemplate({
        name: `Check ${i}`, kind: 'check',
        draft: { bankAccountId: c.bank, payeeNameOnCheck: `Payee ${i}`, amount: '10.0000', printLater: false, lines: [{ accountId: c.expense, amount: '10.0000' }] },
      })).id);
    }
    const results = await within(10_000, Promise.all(ids.map((id) => occurrences.enterTemplate(actor(), id, { occurrenceDate: '2026-05-01' }))));
    const txns = await db.select().from(transactions).where(eq(transactions.tenantId, c.tenantId));
    expect(txns).toHaveLength(4);
    const numbers = txns.map((t) => t.checkNumber);
    expect(new Set(numbers).size).toBe(4);
    expect(numbers.every((n) => typeof n === 'number')).toBe(true);
    expect(results.every((r) => r.occurrence === null)).toBe(true);
  });
});
