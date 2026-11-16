// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

// Sensitive accounts (U-33) and templates (security review B1): a viewer
// without the sensitive_accounts right can't copy a transaction that touches
// a hidden account into a template, can't list or open a template that
// touches one (draft, legacy, journal-entry layouts, schedules), and can't
// name a hidden account in a draft. Nothing changes until an account is
// marked.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { db } from '../db/index.js';
import { contacts, jeTemplateLines, jeTemplates } from '../db/schema/index.js';
import * as ledger from '../services/ledger.service.js';
import { startSensitiveHarness, type SensitiveHarness } from './sensitive.test-fixtures.js';

let h: SensitiveHarness;
let paycheck = '';
let paper = '';
let invoice = '';
let wagesTpl = '';
let legacyTpl = '';
let paperTpl = '';
let jeHidden = '';
let jeVisible = '';
let schedHidden = '';

const post = (txnType: string, memo: string, lines: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) =>
  ledger.postTransaction(h.tenantId, { txnType: txnType as never, txnDate: '2026-03-01', memo, lines: lines as never, ...extra }, h.ownerId, h.companyId);

beforeAll(async () => {
  h = await startSensitiveHarness('sens-tpl');
  paycheck = (await post('journal_entry', 'payroll', [
    { accountId: h.acct.wagesSub, debit: '4321.09', credit: '0' }, { accountId: h.acct.bank, debit: '0', credit: '4321.09' },
  ])).id;
  paper = (await post('journal_entry', 'paper', [
    { accountId: h.acct.supplies, debit: '10.00', credit: '0' }, { accountId: h.acct.bank, debit: '0', credit: '10.00' },
  ])).id;
  const [cust] = await db.insert(contacts).values({ tenantId: h.tenantId, companyId: h.companyId, contactType: 'customer', displayName: 'Plain Customer' }).returning();
  invoice = (await post('invoice', 'inv', [
    { accountId: h.acct.ar, debit: '2111.13', credit: '0', contactId: cust!.id },
    { accountId: h.acct.wages, debit: '0', credit: '2111.13' },
  ], { contactId: cust!.id, dueDate: '2026-04-01', total: '2111.13', balanceDue: '2111.13', amountPaid: '0', invoiceStatus: 'sent' })).id;
  const mk = async (transactionId: string, name: string, schedule?: unknown) => {
    const r = await h.call('owner', 'POST', '/api/v1/templates/from-transaction', { transactionId, name, ...(schedule ? { schedule } : {}) });
    if (r.status !== 201) throw new Error(`template: ${r.status} ${r.text}`);
    return r.json.template.id as string;
  };
  wagesTpl = await mk(paycheck, 'Payroll', { mode: 'remind', frequency: 'monthly', intervalValue: 1, nextDate: '2026-03-01' });
  legacyTpl = await mk(invoice, 'Officer invoice');
  paperTpl = await mk(paper, 'Paper', { mode: 'remind', frequency: 'monthly', intervalValue: 1, nextDate: '2026-03-01' });
  const r = await h.call('owner', 'POST', '/api/v1/recurring', { templateTransactionId: paycheck, frequency: 'monthly', startDate: '2026-03-01', mode: 'reminder' });
  if (r.status !== 201) throw new Error(`schedule: ${r.status} ${r.text}`);
  schedHidden = r.json.schedule.id;
  const [jh] = await db.insert(jeTemplates).values({ tenantId: h.tenantId, companyId: h.companyId, name: 'Payroll accrual' }).returning();
  const [jv] = await db.insert(jeTemplates).values({ tenantId: h.tenantId, companyId: h.companyId, name: 'Rent accrual' }).returning();
  jeHidden = jh!.id;
  jeVisible = jv!.id;
  await db.insert(jeTemplateLines).values([
    { tenantId: h.tenantId, templateId: jeHidden, label: 'Wages', accountId: h.acct.wages, normalSide: 'debit' },
    { tenantId: h.tenantId, templateId: jeVisible, label: 'Supplies', accountId: h.acct.supplies, normalSide: 'debit' },
  ] as never);
}, 120_000);

afterAll(async () => { await h.close(); });

describe('templates and sensitive accounts (B1)', () => {
  it('with nothing marked, the bookkeeper sees every template', async () => {
    const list = await h.call('bk', 'GET', '/api/v1/templates');
    expect(list.status).toBe(200);
    expect(list.json.templates.map((t: { id: string }) => t.id)).toEqual(expect.arrayContaining([wagesTpl, legacyTpl, paperTpl]));
    expect((await h.call('bk', 'GET', `/api/v1/templates/${wagesTpl}/draft`)).status).toBe(200);
    expect((await h.call('bk', 'GET', `/api/v1/je-templates/${jeHidden}`)).status).toBe(200);
  });

  it('once marked: no copy, no list entry, no door', async () => {
    await h.markWages();
    // from-transaction on the paycheck: refused before anything is saved.
    const copy = await h.call('bk', 'POST', '/api/v1/templates/from-transaction', { transactionId: paycheck, name: 'Mine' });
    expect(copy.status).toBe(403);
    expect(copy.json.error.code).toBe('SENSITIVE_ACCOUNT');
    const legacyCopy = await h.call('bk', 'POST', '/api/v1/templates/from-transaction', { transactionId: invoice, name: 'Mine 2' });
    expect(legacyCopy.status).toBe(403);
    // A draft naming a hidden account.
    const draft = await h.call('bk', 'POST', '/api/v1/templates', {
      name: 'Sneaky', kind: 'journal_entry',
      draft: { lines: [{ accountId: h.acct.wages, debit: '1.00' }, { accountId: h.acct.bank, credit: '1.00' }] },
    });
    expect(draft.status).toBe(403);
    expect(draft.json.error.code).toBe('SENSITIVE_ACCOUNT');

    const list = await h.call('bk', 'GET', '/api/v1/templates');
    expect(list.status).toBe(200);
    const ids = list.json.templates.map((t: { id: string }) => t.id);
    expect(ids).toContain(paperTpl);
    expect(ids).not.toContain(wagesTpl);
    expect(ids).not.toContain(legacyTpl);
    expect(list.json.total).toBe(ids.length);
    expect(list.text).not.toContain('4321.09');
    expect(list.text).not.toContain('2111.13');
    expect(list.text).not.toContain('Mine');

    for (const id of [wagesTpl, legacyTpl]) {
      for (const [method, path, body] of [
        ['GET', `/api/v1/templates/${id}`, undefined],
        ['GET', `/api/v1/templates/${id}/draft`, undefined],
        ['PUT', `/api/v1/templates/${id}`, { version: 1, name: 'Renamed' }],
        ['POST', `/api/v1/templates/${id}/enter`, { occurrenceDate: '2026-03-01' }],
        ['POST', `/api/v1/templates/${id}/occurrences/2026-03-01/skip`, {}],
        ['DELETE', `/api/v1/templates/${id}?version=1`, undefined],
      ] as Array<[string, string, unknown]>) {
        const r = await h.call('bk', method, path, body);
        expect([method, path, r.status, r.json?.error?.code]).toEqual([method, path, 403, 'SENSITIVE_ACCOUNT']);
      }
    }
    expect((await h.call('bk', 'GET', `/api/v1/templates/${paperTpl}/draft`)).status).toBe(200);

    // Reminders and the catch-up run list nothing of the hidden template.
    const att = await h.call('bk', 'GET', '/api/v1/recurring/attention?asOf=2026-03-02');
    expect(att.status).toBe(200);
    const remind = att.json.reminders.map((r: { templateId: string }) => r.templateId);
    expect(remind).toContain(paperTpl);
    expect(remind).not.toContain(wagesTpl);
    expect(att.text).not.toContain('4321.09');
    const run = await h.call('bk', 'POST', '/api/v1/recurring/run-due', { asOf: '2026-03-02' });
    expect(run.status).toBe(200);
    expect(run.text).not.toContain('4321.09');
    expect(run.text).not.toContain(wagesTpl);

    // Legacy schedules: out of the list; their doors refused; no new one from the paycheck.
    const sch = await h.call('bk', 'GET', '/api/v1/recurring');
    expect(sch.status).toBe(200);
    expect(sch.json.schedules.map((s: { id: string }) => s.id)).not.toContain(schedHidden);
    expect(sch.text).not.toContain(paycheck);
    expect((await h.call('bk', 'POST', `/api/v1/recurring/${schedHidden}/archive`, {})).status).toBe(403);
    expect((await h.call('bk', 'POST', '/api/v1/recurring', { templateTransactionId: paycheck, frequency: 'monthly', startDate: '2026-03-01' })).status).toBe(403);

    // Journal-entry layouts with a hidden line.
    const jl = await h.call('bk', 'GET', '/api/v1/je-templates');
    expect(jl.json.templates.map((t: { id: string }) => t.id)).toEqual(expect.arrayContaining([jeVisible]));
    expect(jl.json.templates.map((t: { id: string }) => t.id)).not.toContain(jeHidden);
    expect((await h.call('bk', 'GET', `/api/v1/je-templates/${jeHidden}`)).status).toBe(403);
    expect((await h.call('bk', 'POST', `/api/v1/je-templates/${jeHidden}/duplicate`, {})).status).toBe(403);
    expect((await h.call('bk', 'PUT', `/api/v1/je-templates/${jeVisible}/lines`, {
      lines: [{ label: 'W', accountId: h.acct.wages, normalSide: 'debit' }],
    })).status).toBe(403);

    // The owner still sees and opens all of them.
    const own = await h.call('owner', 'GET', '/api/v1/templates');
    expect(own.json.templates.map((t: { id: string }) => t.id)).toEqual(expect.arrayContaining([wagesTpl, legacyTpl, paperTpl]));
    expect((await h.call('owner', 'GET', `/api/v1/templates/${wagesTpl}/draft`)).text).toContain(h.acct.wagesSub);
    expect((await h.call('owner', 'GET', `/api/v1/je-templates/${jeHidden}`)).status).toBe(200);
  });
});
