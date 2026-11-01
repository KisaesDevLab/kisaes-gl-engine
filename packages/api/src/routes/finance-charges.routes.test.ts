// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// U-141 (finance-charges-v1, idempotency-finance-charges-v1): golden case 6
// (formula, minimum, grace, open credits, period guard, charged-through,
// backdated assessment, void frees the days; compounding variant), the
// assess race, not-set-up, a payment between preview and assess, rollback.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
// First: it wraps only the route layers created after it loads.
import 'express-async-errors';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { companies, contacts, financeChargeRuns, financeChargeAssessments, financeChargeSources } from '../db/schema/index.js';
import { paymentsRouter } from './payments.routes.js';
import { transactionsRouter } from './transactions.routes.js';
import { financeChargesRouter } from './finance-charges.routes.js';
import { invoicesRouter } from './invoices.routes.js';
import { assertAssessmentDateNotFuture } from '../services/finance-charge.service.js';
import * as ledger from '../services/ledger.service.js';
import { DESKTOP_CAPABILITIES } from '../desktop/capabilities.js';
import { Harness, type Co, golden, key, txn, m2 } from './receivables.test-support.js';

const h = new Harness();
let c: Co;
type Step = Record<string, any>;
const gcase = (golden['cases'] as Array<{ id: number; steps: Step[]; variants?: Step[] }>).find((x) => x.id === 6)!;
const seed = golden['seeds'].financeCharges;
const clientIds = new Map<string, string>();

beforeEach(async () => {
  clientIds.clear();
  h.extraCleanup = [async (tid) => {
    await db.delete(financeChargeSources).where(eq(financeChargeSources.tenantId, tid));
    await db.delete(financeChargeAssessments).where(eq(financeChargeAssessments.tenantId, tid));
    await db.delete(financeChargeRuns).where(eq(financeChargeRuns.tenantId, tid));
  }];
  await h.start([['/api/v1/payments', paymentsRouter], ['/api/v1/transactions', transactionsRouter], ['/api/v1/finance-charges', financeChargesRouter],
    ['/api/v1/invoices', invoicesRouter]]);
  c = await h.company();
  for (const cl of seed.clients as Step[]) {
    const [row] = await db.insert(contacts).values({ tenantId: c.tenantId, companyId: c.companyId, contactType: 'customer', displayName: cl['client'] }).returning();
    clientIds.set(cl['client'], row!.id);
    for (const inv of cl['invoices'] as Step[]) await h.invoice(c, inv as never, row!.id);
    for (const m of (cl['creditMemos'] ?? []) as Step[]) c.docs.set(m['name'], await h.legacyMemo(c, m['date'], m['total'], {}, row!.id));
  }
});
afterEach(async () => { await h.stop(); });

async function settings(over: Step = {}) {
  const s = { ...seed.settings, ...over };
  await db.update(companies).set({
    financeChargeAnnualRate: s.annualRate, financeChargeGraceDays: s.graceDays, financeChargeMinimum: s.minimum,
    financeChargeOnFinanceCharges: s.onFinanceCharges, financeChargeIncomeAccountId: c.roles['income'],
  }).where(eq(companies.id, c.companyId));
}

const nameOf = (id: string) => [...c.docs.entries()].find(([, v]) => v === id)?.[0] ?? id;
const keys = new Map<string, string>();
const results = new Map<string, Step>();

async function runStep(step: Step) {
  const e = step['expect'] ?? {};
  const r = step['request'] ?? {};
  switch (step['op']) {
    case 'financeChargePreview': {
      const res = await h.request('POST', '/api/v1/finance-charges/preview', c.token, {
        assessmentDate: r.assessmentDate, ...(r.clients ? { contactIds: (r.clients as string[]).map((n) => clientIds.get(n)) } : {}),
      });
      expect(res.status, JSON.stringify(res.json)).toBe(200);
      if (e.period) expect(res.json['period']).toBe(e.period);
      for (const want of (e.rows ?? []) as Step[]) {
        const got = (res.json['rows'] as Step[]).find((x) => x['contactId'] === clientIds.get(want['client']));
        expect(got, want['client']).toBeDefined();
        expect([want['client'], got!['charge']]).toEqual([want['client'], want['charge']]);
        if (want['ticked'] !== undefined) expect(got!['ticked']).toBe(want['ticked']);
        if (want['hasOpenCredits'] !== undefined) expect(got!['hasOpenCredits']).toBe(want['hasOpenCredits']);
        if (want['minimumAdjustment'] !== undefined) expect(got!['minimumAdjustment']).toBe(want['minimumAdjustment']);
        expect((got!['sources'] as Step[]).map((s) => ({ invoice: nameOf(s['invoiceId']), days: s['days'], amount: s['amount'], open: s['open'] })))
          .toEqual((want['sources'] as Step[]).map((s) => ({ invoice: s['invoice'], days: s['days'], amount: s['amount'], open: s['open'] ?? expect.any(String) })));
      }
      return;
    }
    case 'financeChargeAssess': {
      if (!keys.has(r.key)) keys.set(r.key, key());
      const res = await h.request('POST', '/api/v1/finance-charges/assess', c.token, {
        assessmentDate: r.assessmentDate,
        contacts: (r.contacts as Step[]).map((x) => ({ contactId: clientIds.get(x['client']), expectedCharge: x['expectedCharge'] })),
      }, { 'Idempotency-Key': keys.get(r.key)! });
      if (e.error) { expect([res.status, res.json['error']?.code]).toEqual([e.error.status, e.error.code]); return; }
      expect(res.status, JSON.stringify(res.json)).toBe(201);
      if (e.replay) expect(res.json).toEqual(results.get(r.key));
      results.set(r.key, res.json);
      for (const want of e.invoices as Step[]) {
        const got = (res.json['invoices'] as Step[]).find((x) => x['contactId'] === clientIds.get(want['client']))!;
        expect(got['total']).toBe(want['total']);
        c.docs.set(want['name'], got['invoiceId']);
        const row = await txn(got['invoiceId']);
        if (want['date']) expect([row.txnDate, row.dueDate]).toEqual([want['date'], want['dueDate']]);
        expect(row.isFinanceCharge).toBe(true);
      }
      return;
    }
    case 'void': {
      const res = await h.request('POST', `/api/v1/transactions/${c.docs.get(r.txn)}/void`, c.token, { reason: 'golden' });
      expect(res.status, JSON.stringify(res.json)).toBe(200);
      return;
    }
    default: throw new Error(`unknown op ${step['op']}`);
  }
}

describe('finance-charges-v1 (U-141)', () => {
  it('advertises the capabilities', () => {
    expect(DESKTOP_CAPABILITIES).toContain('finance-charges-v1');
    expect(DESKTOP_CAPABILITIES).toContain('idempotency-finance-charges-v1');
  });

  it('golden 6: formula, minimum, open credits, period guard, replay, charged-through, backdated, void frees the days', async () => {
    await settings();
    keys.clear(); results.clear();
    for (const [i, step] of gcase.steps.entries()) {
      try { await runStep(step); } catch (err) { (err as Error).message = `step ${i + 1} (${step['op']}): ${(err as Error).message}`; throw err; }
    }
  });

  it('golden 6 variant: compounding on charges the October finance-charge invoice in November', async () => {
    for (const v of gcase.variants ?? []) {
      await settings(v['settings']);
      keys.clear(); results.clear();
      for (const step of v['steps'] as Step[]) await runStep(step);
    }
  });

  it('not set up: preview problem, assess 400; a payment between preview and assess is FINANCE_CHARGE_CHANGED', async () => {
    const pf = clientIds.get('Prairie Fork Kennels')!;
    let p = await h.request('POST', '/api/v1/finance-charges/preview', c.token, { assessmentDate: '2026-10-31' });
    expect(p.json['problems']).toEqual([{ code: 'RATE_NOT_SET' }, { code: 'INCOME_ACCOUNT_NOT_SET' }]);
    let a = await h.request('POST', '/api/v1/finance-charges/assess', c.token, { assessmentDate: '2026-10-31', contacts: [{ contactId: pf, expectedCharge: '15.68' }] });
    expect([a.status, a.json['error'].code]).toEqual([400, 'FINANCE_CHARGE_NOT_SET_UP']);
    await settings();
    p = await h.request('POST', '/api/v1/finance-charges/preview', c.token, { assessmentDate: '2026-10-31', contactIds: [pf] });
    expect(p.json['rows'][0].charge).toBe('15.68');
    const r = await h.request('POST', '/api/v1/payments/receive', c.token, { customerId: pf, date: '2026-10-20', amount: '50.00',
      depositTo: c.roles['payments_clearing'], applications: [{ invoiceId: c.docs.get('PF2'), amount: '50.00' }] });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    a = await h.request('POST', '/api/v1/finance-charges/assess', c.token, { assessmentDate: '2026-10-31', contacts: [{ contactId: pf, expectedCharge: '15.68' }] });
    expect([a.status, a.json['error'].code, a.json['error'].details]).toEqual([409, 'FINANCE_CHARGE_CHANGED', { contactId: pf, charge: '15.29' }]);
  });

  it('two concurrent assess calls for one month: exactly one posts', async () => {
    await settings();
    const pf = clientIds.get('Prairie Fork Kennels')!;
    const body = { assessmentDate: '2026-10-31', contacts: [{ contactId: pf, expectedCharge: '15.68' }] };
    const res = await Promise.all([1, 2].map(() => h.request('POST', '/api/v1/finance-charges/assess', c.token, body, { 'Idempotency-Key': key() })));
    expect(res.map((x) => x.status).sort()).toEqual([201, 409]);
    expect(res.find((x) => x.status === 409)!.json['error'].code).toBe('FINANCE_CHARGE_ASSESSED');
    const list = await h.request('GET', '/api/v1/finance-charges?period=2026-10', c.token);
    expect(list.json['data'].length).toBe(1);
    expect(m2(list.json['data'][0].total)).toBe('15.68');
  });

  it('a client in credit is skipped; the closing date needs the password', async () => {
    await settings();
    const cg = clientIds.get('Cedar Gap Outfitters')!;
    await h.legacyMemo(c, '2026-10-02', '300.00', {}, cg);
    const p = await h.request('POST', '/api/v1/finance-charges/preview', c.token, { assessmentDate: '2026-10-31', contactIds: [cg] });
    expect(p.json['rows'][0]).toMatchObject({ skippedReason: 'in_credit', charge: '0.00', ticked: false });
    await db.update(companies).set({ lockDate: '2026-10-31' }).where(eq(companies.id, c.companyId));
    const a = await h.request('POST', '/api/v1/finance-charges/assess', c.token,
      { assessmentDate: '2026-10-31', contacts: [{ contactId: clientIds.get('Prairie Fork Kennels'), expectedCharge: '15.68' }] });
    expect(a.status).toBeGreaterThanOrEqual(400);
    expect(a.status).not.toBe(201);
  });

  it('0251 rolls back and applies again', async () => {
    const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../db/migrations');
    const run = async (file: string) => {
      for (const stmt of readFileSync(path.join(dir, file), 'utf8').split('--> statement-breakpoint')) {
        const body = stmt.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').trim();
        if (body) await db.execute(sql.raw(body));
      }
    };
    await run('0251_finance_charges.rollback.sql');
    expect(((await db.execute(sql`SELECT to_regclass('public.finance_charge_runs') AS t`)).rows[0] as { t: string | null }).t).toBeNull();
    await run('0251_finance_charges.sql');
    expect(((await db.execute(sql`SELECT to_regclass('public.finance_charge_runs') AS t`)).rows[0] as { t: string | null }).t).not.toBeNull();
  });
});

describe('P22 review fixes (E5)', () => {
  const pfId = () => clientIds.get('Prairie Fork Kennels')!;
  const assess = (headers: Record<string, string> = {}, token = c.token) => h.request('POST', '/api/v1/finance-charges/assess', token,
    { assessmentDate: '2026-10-31', contacts: [{ contactId: pfId(), expectedCharge: '15.68' }] }, { 'Idempotency-Key': key(), ...headers });

  it('an assessment date in a later month is 400 on preview and assess; a later day of this month is allowed', async () => {
    await settings();
    const now = new Date();
    const later = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 2, 1)).toISOString().slice(0, 10);
    const p = await h.request('POST', '/api/v1/finance-charges/preview', c.token, { assessmentDate: later });
    expect([p.status, p.json['error']?.code, p.json['error']?.details?.field]).toEqual([400, 'FINANCE_CHARGE_DATE_IN_FUTURE', 'assessmentDate']);
    const a = await h.request('POST', '/api/v1/finance-charges/assess', c.token,
      { assessmentDate: later, contacts: [{ contactId: pfId(), expectedCharge: '15.68' }] }, { 'Idempotency-Key': key() });
    expect([a.status, a.json['error']?.code]).toEqual([400, 'FINANCE_CHARGE_DATE_IN_FUTURE']);
    expect(() => assertAssessmentDateNotFuture('2026-11-30', new Date('2026-11-01T00:00:00Z'))).not.toThrow();
    expect(() => assertAssessmentDateNotFuture('2026-12-01', new Date('2026-11-30T12:00:00Z'))).not.toThrow();
    expect(() => assertAssessmentDateNotFuture('2026-12-01', new Date('2026-11-15T00:00:00Z'))).toThrow();
  });

  it("another company's client is 404 on assess and absent from preview; a role without invoices is 403", async () => {
    await settings();
    const b = await h.secondCompany(c);
    await db.update(companies).set({ financeChargeAnnualRate: '18.00', financeChargeIncomeAccountId: c.roles['income'] })
      .where(eq(companies.id, b['X-Company-Id']!));
    const a = await assess(b);
    expect(a.status, JSON.stringify(a.json)).toBe(404);
    const p = await h.request('POST', '/api/v1/finance-charges/preview', c.token, { assessmentDate: '2026-10-31', contactIds: [pfId()] }, b);
    expect([p.status, p.json['rows']]).toEqual([200, []]);
    expect((await h.request('GET', '/api/v1/finance-charges?period=2026-10', c.token)).json['data']).toEqual([]);
    const bankingOnly = await h.staffToken(c, { banking: 'full' });
    for (const [method, path, body] of [['POST', '/api/v1/finance-charges/preview', { assessmentDate: '2026-10-31' }],
      ['POST', '/api/v1/finance-charges/assess', { assessmentDate: '2026-10-31', contacts: [{ contactId: pfId(), expectedCharge: '15.68' }] }],
      ['GET', '/api/v1/finance-charges', undefined]] as const) {
      const x = await h.request(method, path, bankingOnly, body);
      expect([x.status, x.json['error']?.code], `${method} ${path}`).toEqual([403, 'PERMISSION_DENIED']);
    }
  });

  it('editing a finance-charge invoice is allowed (plan 2.7): the flag, the assessment and its sources stay; the month stays charged', async () => {
    await settings();
    const a = await assess();
    expect(a.status, JSON.stringify(a.json)).toBe(201);
    const id = a.json['invoices'][0].invoiceId as string;
    const sources = async () => (await db.select().from(financeChargeSources).where(eq(financeChargeSources.tenantId, c.tenantId)))
      .map((x) => [x.invoiceId, x.open, x.fromDate, x.throughDate, x.days, x.amount].join('|')).sort();
    const before = await sources();
    const inv = await txn(id);
    const put = await h.request('PUT', `/api/v1/invoices/${id}`, c.token, {
      contactId: pfId(), txnDate: '2026-10-31', expectedUpdatedAt: inv.updatedAt!.toISOString(),
      lines: [{ accountId: c.roles['income'], description: 'Finance charge', quantity: '1', unitPrice: '10.00', isTaxable: false }],
    });
    expect(put.status, JSON.stringify(put.json)).toBe(200);
    const after = await txn(id);
    expect([after.isFinanceCharge, m2(after.total)]).toEqual([true, '10.00']);
    expect(await sources()).toEqual(before);
    const live = await db.select().from(financeChargeAssessments).where(eq(financeChargeAssessments.invoiceId, id));
    expect(live.map((x) => x.voidedAt)).toEqual([null]);
    const again = await assess();
    expect([again.status, again.json['error']?.code]).toEqual([409, 'FINANCE_CHARGE_ASSESSED']);
  });

  it('U-145: changing the client of a finance-charge invoice is 409 FINANCE_CHARGE_CLIENT_CHANGE on every edit path; nothing changes', async () => {
    await settings();
    const a = await assess();
    expect(a.status, JSON.stringify(a.json)).toBe(201);
    const id = a.json['invoices'][0].invoiceId as string;
    const before = await txn(id);
    const body = (contactId: string, extra: Record<string, unknown> = {}) => ({
      contactId, txnDate: '2026-10-31',
      lines: [{ accountId: c.roles['income'], description: 'Finance charge', quantity: '1', unitPrice: '15.68', isTaxable: false }], ...extra,
    });
    const moved = await h.request('PUT', `/api/v1/invoices/${id}`, c.token, body(c.customer, { expectedUpdatedAt: before.updatedAt!.toISOString() }),
      { 'Idempotency-Key': key() });
    expect([moved.status, moved.json['error']?.code]).toEqual([409, 'FINANCE_CHARGE_CLIENT_CHANGE']);
    expect(moved.json['error'].message).toContain('Void it and assess again for the right client');
    // The generic edit path refuses it too (ledger.updateTransaction).
    await expect(ledger.updateTransaction(c.tenantId, id, {
      txnType: 'invoice', txnDate: '2026-10-31', contactId: c.customer,
      lines: [{ accountId: c.roles['accounts_receivable']!, debit: '15.68', credit: '0' }, { accountId: c.roles['income']!, debit: '0', credit: '15.68' }],
    } as never, c.userId, c.companyId)).rejects.toMatchObject({ statusCode: 409, code: 'FINANCE_CHARGE_CLIENT_CHANGE' });
    const after = await txn(id);
    expect([after.contactId, after.updatedAt?.toISOString(), m2(after.total)]).toEqual([pfId(), before.updatedAt?.toISOString(), m2(before.total)]);
    // Same client: an amount and date edit stays allowed.
    const ok = await h.request('PUT', `/api/v1/invoices/${id}`, c.token, body(pfId(), {
      txnDate: '2026-10-30', expectedUpdatedAt: before.updatedAt!.toISOString(),
      lines: [{ accountId: c.roles['income'], description: 'Finance charge', quantity: '1', unitPrice: '12.00', isTaxable: false }],
    }));
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    const edited = await txn(id);
    expect([edited.contactId, edited.txnDate, m2(edited.total), edited.isFinanceCharge]).toEqual([pfId(), '2026-10-30', '12.00', true]);
    // An ordinary invoice can still change its client.
    const plain = await h.invoice(c, { date: '2026-10-15', total: '50.00' }, pfId());
    const p = await txn(plain);
    const change = await h.request('PUT', `/api/v1/invoices/${plain}`, c.token, {
      contactId: c.customer, txnDate: '2026-10-15', expectedUpdatedAt: p.updatedAt!.toISOString(),
      lines: [{ accountId: c.roles['sales'], description: 'Work', quantity: '1', unitPrice: '50.00', isTaxable: false }],
    });
    expect(change.status, JSON.stringify(change.json)).toBe(200);
    expect((await txn(plain)).contactId).toBe(c.customer);
  });
});
