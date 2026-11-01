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
  await h.start([['/api/v1/payments', paymentsRouter], ['/api/v1/transactions', transactionsRouter], ['/api/v1/finance-charges', financeChargesRouter]]);
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
