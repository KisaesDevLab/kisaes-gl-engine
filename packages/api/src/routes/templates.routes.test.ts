// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// Templates without posting (ClientLedger U-62, templates-v1):
//   - create each kind; nothing is posted (no transaction, no balance);
//   - refusals: JSON number, 5 places, unbalanced entry, check lines ≠
//     amount, deposit sourceTransactionId, checkNumber, reverseOn, txnDate,
//     zero line, daily-sales auto, foreign account / tag / name;
//   - 409 STALE on a version mismatch, 409 TEMPLATE_NAME_TAKEN, soft
//     delete, group delete moves templates to no group;
//   - another tenant's or company's template is 404 and left out of lists;
//   - GET /draft: warnings for an inactive account, a missing one nulled;
//   - from-transaction: a check becomes a check template, an invoice a
//     legacy one, a void transaction is refused.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { accounts, transactions, journalLines, tags, dailySalesTemplates, dailySalesTemplateLines } from '../db/schema/index.js';
import * as ledger from '../services/ledger.service.js';
import * as checkService from '../services/check.service.js';
import { TestServer, makeCompany, cleanTenant, transferDraft, monthlyAuto, type Co } from '../services/templates/templates.test-helpers.js';

const srv = new TestServer();
const tenantIds: string[] = [];
let c: Co;

beforeEach(async () => {
  await srv.start();
  c = await makeCompany('crud', tenantIds);
});

afterEach(async () => {
  await srv.stop();
  while (tenantIds.length) await cleanTenant(tenantIds.pop()!);
});

const post = (body: unknown, co = c.companyId, token = c.token) => srv.request('POST', '/api/v1/templates', token, body, co);
const get = (path: string, co = c.companyId, token = c.token) => srv.request('GET', `/api/v1/templates${path}`, token, undefined, co);

async function txnCount(tenantId = c.tenantId) {
  return (await db.select({ id: transactions.id }).from(transactions).where(eq(transactions.tenantId, tenantId))).length;
}

describe('create each kind; nothing posts', () => {
  it('check, expense, deposit, transfer, journal entry and daily sales', async () => {
    const before = await txnCount();
    const bankBefore = (await db.query.accounts.findFirst({ where: eq(accounts.id, c.bank) }))!.balance;

    const check = await post({
      name: 'Rent', kind: 'check', clientForm: 'write_check',
      draft: {
        bankAccountId: c.bank, contactId: c.vendor, payeeNameOnCheck: 'Cosmos Granite', amount: '1250.5000',
        printLater: true, tagIds: [c.tag],
        lines: [{ accountId: c.expense, amount: '1000.0000', tagId: null }, { accountId: c.expense2, amount: '250.5000', tagId: c.tag, contactId: c.customer, isBillable: true }],
      },
      schedule: monthlyAuto('2026-01-31'),
    });
    expect(check.status, JSON.stringify(check.json)).toBe(201);
    expect(check.json.template).toMatchObject({
      name: 'Rent', kind: 'check', clientForm: 'write_check', total: '1250.5000', accountId: c.bank, contactId: c.vendor,
      legacy: false, version: 1,
      schedule: { mode: 'auto', frequency: 'monthly', intervalValue: 1, nextDate: '2026-01-31', isActive: true, remainingCount: null },
    });
    expect(check.json.template.draft).toEqual({
      bankAccountId: c.bank, contactId: c.vendor, payeeNameOnCheck: 'Cosmos Granite', amount: '1250.5000',
      printLater: true, tagIds: [c.tag],
      lines: [
        { accountId: c.expense, amount: '1000.0000', tagId: null, isBillable: false },
        { accountId: c.expense2, amount: '250.5000', tagId: c.tag, contactId: c.customer, isBillable: true },
      ],
    });

    const expense = await post({
      name: 'Phone', kind: 'expense', clientForm: 'card_charge',
      draft: { payFromAccountId: c.bank, contactId: c.vendor, memo: 'Monthly', tagIds: [c.tag], lines: [{ expenseAccountId: c.expense, amount: '89.9900' }] },
    });
    expect(expense.status, JSON.stringify(expense.json)).toBe(201);
    expect(expense.json.template).toMatchObject({ kind: 'expense', clientForm: 'card_charge', total: '89.9900', schedule: null });

    const deposit = await post({
      name: 'Rent in', kind: 'deposit',
      draft: {
        depositToAccountId: c.bank, lines: [{ accountId: c.income, amount: '500.0000' }, { accountId: c.expense, amount: '-2.5000' }],
        cashBack: { accountId: c.expense2, amount: '20.0000' },
      },
    });
    expect(deposit.status, JSON.stringify(deposit.json)).toBe(201);
    expect(deposit.json.template.total).toBe('477.5000');

    const transfer = await post({ name: 'Sweep', kind: 'transfer', draft: transferDraft(c) });
    expect(transfer.status).toBe(201);
    expect(transfer.json.template.total).toBe('49.0000');

    const je = await post({
      name: 'Depreciation', kind: 'journal_entry',
      draft: { memo: 'Monthly', basis: 'accrual', lines: [{ accountId: c.expense, debit: '100.1234' }, { accountId: c.bank, credit: '100.1234' }] },
    });
    expect(je.status, JSON.stringify(je.json)).toBe(201);
    expect(je.json.template.draft).toEqual({
      memo: 'Monthly', basis: 'accrual',
      lines: [
        { accountId: c.expense, debit: '100.1234', credit: '0.0000', tagId: null },
        { accountId: c.bank, debit: '0.0000', credit: '100.1234', tagId: null },
      ],
    });

    const [layout] = await db.insert(dailySalesTemplates).values({ tenantId: c.tenantId, companyId: c.companyId, name: 'Register' }).returning();
    const [line] = await db.insert(dailySalesTemplateLines).values({
      tenantId: c.tenantId, templateId: layout!.id, section: 'sales', label: 'Sales', accountId: c.income, normalSide: 'credit',
    }).returning();
    const ds = await post({ name: 'Daily', kind: 'daily_sales', draft: { templateId: layout!.id, values: [{ templateLineId: line!.id, amount: '300.0000' }] } });
    expect(ds.status, JSON.stringify(ds.json)).toBe(201);
    const dsAuto = await srv.request('PUT', `/api/v1/templates/${ds.json.template.id}`, c.token, { version: 1, schedule: monthlyAuto('2026-02-01') }, c.companyId);
    expect(dsAuto.status).toBe(400);
    expect(dsAuto.json.error.code).toBe('TEMPLATE_AUTO_UNSUPPORTED');

    expect(await txnCount()).toBe(before);
    expect((await db.query.accounts.findFirst({ where: eq(accounts.id, c.bank) }))!.balance).toBe(bankBefore);

    const list = await get('');
    expect(list.status).toBe(200);
    expect(list.json.total).toBe(6);
    expect(list.json.templates.map((t: { name: string }) => t.name)).toEqual(['Daily', 'Depreciation', 'Phone', 'Rent', 'Rent in', 'Sweep']);
  });
});

describe('refusals', () => {
  const cases: Array<[string, (c: Co) => unknown, string, string?]> = [
    ['JSON number amount', (c) => ({ kind: 'transfer', draft: { ...transferDraft(c), amount: 49 } }), 'VALIDATION_ERROR'],
    ['5 decimal places', (c) => ({ kind: 'transfer', draft: { ...transferDraft(c), amount: '1.00001' } }), 'VALIDATION_ERROR'],
    ['unbalanced journal entry', (c) => ({ kind: 'journal_entry', draft: { lines: [{ accountId: c.expense, debit: '10.0000' }, { accountId: c.bank, credit: '9.9999' }] } }), 'VALIDATION_ERROR'],
    ['check lines ≠ amount', (c) => ({ kind: 'check', draft: { bankAccountId: c.bank, payeeNameOnCheck: 'X', amount: '10.0000', lines: [{ accountId: c.expense, amount: '9.0000' }] } }), 'VALIDATION_ERROR'],
    ['deposit sourceTransactionId', (c) => ({ kind: 'deposit', draft: { depositToAccountId: c.bank, lines: [{ accountId: c.income, amount: '5', sourceTransactionId: c.bank }] } }), 'TEMPLATE_DEPOSIT_GROUPING'],
    ['checkNumber', (c) => ({ kind: 'check', draft: { bankAccountId: c.bank, payeeNameOnCheck: 'X', amount: '1', checkNumber: 1001, lines: [{ accountId: c.expense, amount: '1' }] } }), 'TEMPLATE_FIELD_NOT_ALLOWED', 'checkNumber'],
    ['reverseOn', (c) => ({ kind: 'journal_entry', draft: { reverseOn: '2026-02-01', lines: [{ accountId: c.expense, debit: '1' }, { accountId: c.bank, credit: '1' }] } }), 'TEMPLATE_FIELD_NOT_ALLOWED', 'reverseOn'],
    ['txnDate', (c) => ({ kind: 'transfer', draft: { ...transferDraft(c), txnDate: '2026-01-01' } }), 'TEMPLATE_FIELD_NOT_ALLOWED', 'txnDate'],
    ['journal entry txnNumber', (c) => ({ kind: 'journal_entry', draft: { txnNumber: '7', lines: [{ accountId: c.expense, debit: '1' }, { accountId: c.bank, credit: '1' }] } }), 'TEMPLATE_FIELD_NOT_ALLOWED', 'txnNumber'],
    ['zero line', (c) => ({ kind: 'expense', draft: { payFromAccountId: c.bank, lines: [{ expenseAccountId: c.expense, amount: '0.0000' }, { expenseAccountId: c.expense2, amount: '5' }] } }), 'VALIDATION_ERROR'],
    ['zero journal line', (c) => ({ kind: 'journal_entry', draft: { lines: [{ accountId: c.expense, debit: '1' }, { accountId: c.bank, credit: '1' }, { accountId: c.expense2 }] } }), 'VALIDATION_ERROR'],
    ['same transfer accounts', (c) => ({ kind: 'transfer', draft: { ...transferDraft(c), toAccountId: c.bank } }), 'VALIDATION_ERROR'],
  ];
  for (const [label, body, code, field] of cases) {
    it(label, async () => {
      const r = await post({ name: `T ${label}`, ...(body(c) as object) });
      expect(r.status, JSON.stringify(r.json)).toBe(400);
      expect(r.json.error.code).toBe(code);
      if (field) expect(r.json.error.details).toEqual({ field });
      expect(await txnCount()).toBe(0);
    });
  }

  it('foreign account, tag and name (another tenant) are refused', async () => {
    const other = await makeCompany('other', tenantIds);
    const acct = await post({ name: 'X1', kind: 'transfer', draft: { ...transferDraft(c), toAccountId: other.savings } });
    expect(acct.status).toBe(400);
    expect(acct.json.error.code).toBe('VALIDATION_ERROR');
    const tag = await post({ name: 'X2', kind: 'expense', draft: { payFromAccountId: c.bank, tagIds: [other.tag], lines: [{ expenseAccountId: c.expense, amount: '1' }] } });
    expect(tag.status).toBe(400);
    const name = await post({ name: 'X3', kind: 'expense', draft: { payFromAccountId: c.bank, contactId: other.vendor, lines: [{ expenseAccountId: c.expense, amount: '1' }] } });
    expect(name.status).toBe(400);
    // Another company's account in the same tenant.
    const [companyBAcct] = await db.insert(accounts).values({ tenantId: c.tenantId, companyId: c.companyB, name: 'B only', accountType: 'expense' }).returning();
    const coAcct = await post({ name: 'X4', kind: 'expense', draft: { payFromAccountId: c.bank, lines: [{ expenseAccountId: companyBAcct!.id, amount: '1' }] } });
    expect(coAcct.status).toBe(400);
  });
});

describe('versions, names, delete, groups', () => {
  it('409 STALE, 409 TEMPLATE_NAME_TAKEN, soft delete, schedule removed', async () => {
    const a = await post({ name: 'Sweep', kind: 'transfer', draft: transferDraft(c), schedule: monthlyAuto('2026-03-31') });
    const id = a.json.template.id;
    const dup = await post({ name: 'sweep', kind: 'transfer', draft: transferDraft(c) });
    expect(dup.status).toBe(409);
    expect(dup.json.error.code).toBe('TEMPLATE_NAME_TAKEN');
    // Same name in the other company is fine.
    expect((await post({ name: 'Sweep', kind: 'transfer', draft: transferDraft(c) }, c.companyB)).status).toBe(201);

    const put = await srv.request('PUT', `/api/v1/templates/${id}`, c.token, { version: 1, draft: transferDraft(c, '50.0000') }, c.companyId);
    expect(put.status, JSON.stringify(put.json)).toBe(200);
    expect(put.json.template).toMatchObject({ version: 2, total: '50.0000' });
    const stale = await srv.request('PUT', `/api/v1/templates/${id}`, c.token, { version: 1, name: 'Late' }, c.companyId);
    expect(stale.status).toBe(409);
    expect(stale.json.error).toMatchObject({ code: 'STALE', details: { version: 2 } });

    const noSched = await srv.request('PUT', `/api/v1/templates/${id}`, c.token, { version: 2, schedule: null }, c.companyId);
    expect(noSched.json.template.schedule).toBeNull();
    const again = await srv.request('PUT', `/api/v1/templates/${id}`, c.token, { version: 3, schedule: monthlyAuto('2026-04-30', { mode: 'remind' }) }, c.companyId);
    expect(again.json.template.schedule).toMatchObject({ mode: 'remind', nextDate: '2026-04-30' });

    const delStale = await srv.request('DELETE', `/api/v1/templates/${id}?version=1`, c.token, undefined, c.companyId);
    expect(delStale.status).toBe(409);
    const del = await srv.request('DELETE', `/api/v1/templates/${id}?version=4`, c.token, undefined, c.companyId);
    expect(del.status).toBe(204);
    expect((await get(`/${id}`)).status).toBe(404);
    // The name is free again after a delete.
    expect((await post({ name: 'Sweep', kind: 'transfer', draft: transferDraft(c) })).status).toBe(201);
  });

  it('groups: create, rename, list counts; delete moves templates to no group', async () => {
    const g = await srv.request('POST', '/api/v1/templates/groups', c.token, { name: 'Monthly' }, c.companyId);
    expect(g.status).toBe(201);
    expect((await srv.request('POST', '/api/v1/templates/groups', c.token, { name: 'monthly' }, c.companyId)).json.error.code).toBe('TEMPLATE_GROUP_NAME_TAKEN');
    const t = await post({ name: 'Sweep', kind: 'transfer', groupId: g.json.group.id, draft: transferDraft(c) });
    expect(t.json.template).toMatchObject({ groupId: g.json.group.id, groupName: 'Monthly' });
    expect((await get(`?groupId=${g.json.group.id}`)).json.total).toBe(1);
    const groups = await get('/groups');
    expect(groups.json.groups).toEqual([{ id: g.json.group.id, name: 'Monthly', templateCount: 1 }]);
    // Another company can't use the group.
    expect((await post({ name: 'Other', kind: 'transfer', groupId: g.json.group.id, draft: transferDraft(c) }, c.companyB)).status).toBe(400);
    expect((await srv.request('DELETE', `/api/v1/templates/groups/${g.json.group.id}`, c.token, undefined, c.companyB)).status).toBe(404);
    expect((await srv.request('DELETE', `/api/v1/templates/groups/${g.json.group.id}`, c.token, undefined, c.companyId)).status).toBe(204);
    expect((await get(`/${t.json.template.id}`)).json.template).toMatchObject({ groupId: null, groupName: null });
  });
});

describe('isolation', () => {
  it('another company or tenant: 404 and left out of lists', async () => {
    const a = await post({ name: 'Sweep', kind: 'transfer', draft: transferDraft(c) });
    const id = a.json.template.id;
    expect((await get(`/${id}`, c.companyB)).status).toBe(404);
    expect((await get('', c.companyB)).json.total).toBe(0);
    expect((await srv.request('PUT', `/api/v1/templates/${id}`, c.token, { version: 1, name: 'X' }, c.companyB)).status).toBe(404);
    expect((await srv.request('POST', `/api/v1/templates/${id}/enter`, c.token, {}, c.companyB)).status).toBe(404);
    const other = await makeCompany('iso', tenantIds);
    expect((await get(`/${id}`, other.companyId, other.token)).status).toBe(404);
    expect((await get('', other.companyId, other.token)).json.total).toBe(0);
    expect((await srv.request('DELETE', `/api/v1/templates/${id}?version=1`, other.token, undefined, other.companyId)).status).toBe(404);
    expect((await get(`/${id}`)).status).toBe(200);
  });
});

describe('GET /draft', () => {
  it('warns about an inactive account and nulls a missing tag', async () => {
    const t = await post({
      name: 'Phone', kind: 'expense',
      draft: { payFromAccountId: c.bank, tagIds: [c.tag], lines: [{ expenseAccountId: c.expense, amount: '10.0000', tagId: c.tag }] },
    });
    await db.update(accounts).set({ isActive: false }).where(eq(accounts.id, c.expense));
    await db.delete(tags).where(eq(tags.id, c.tag));
    const d = await get(`/${t.json.template.id}/draft`);
    expect(d.status).toBe(200);
    expect(d.json.kind).toBe('expense');
    expect(d.json.warnings).toEqual(expect.arrayContaining([
      { field: 'account', code: 'ACCOUNT_INACTIVE', id: c.expense },
      { field: 'tag', code: 'NOT_FOUND', id: c.tag },
    ]));
    expect(d.json.draft.tagIds).toEqual([]);
    expect(d.json.draft.lines[0].tagId).toBeNull();
    expect(d.json.draft.lines[0].expenseAccountId).toBe(c.expense);
    expect(await txnCount()).toBe(0);
  });
});

describe('from-transaction', () => {
  it('a check becomes a check template, an invoice a legacy one; void is refused', async () => {
    const check = await checkService.createCheck(c.tenantId, {
      bankAccountId: c.bank, contactId: c.vendor, payeeNameOnCheck: 'Cosmos Granite', txnDate: '2026-01-15', amount: '75.2500',
      printLater: false, lines: [{ accountId: c.expense, amount: '75.2500' }], tagIds: [c.tag],
    }, c.userId, c.companyId);
    const r = await srv.request('POST', '/api/v1/templates/from-transaction', c.token, { transactionId: check.id, name: 'Granite' }, c.companyId);
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    expect(r.json.template).toMatchObject({ kind: 'check', total: '75.2500', sourceTransactionId: check.id });
    expect(r.json.template.draft).toMatchObject({
      bankAccountId: c.bank, payeeNameOnCheck: 'Cosmos Granite', amount: '75.2500', printLater: false, tagIds: [c.tag],
      lines: [{ accountId: c.expense, amount: '75.2500' }],
    });

    const invoice = await ledger.postTransaction(c.tenantId, {
      txnType: 'invoice', txnDate: '2026-01-15', contactId: c.customer, total: '10.0000',
      lines: [{ accountId: c.ar, debit: '10.0000', credit: '0' }, { accountId: c.income, debit: '0', credit: '10.0000' }],
    }, c.userId, c.companyId);
    const inv = await srv.request('POST', '/api/v1/templates/from-transaction', c.token, { transactionId: invoice.id, name: 'Retainer' }, c.companyId);
    expect(inv.status).toBe(201);
    expect(inv.json.template).toMatchObject({ kind: 'legacy', legacy: true, draft: null, total: '10.0000' });

    await ledger.voidTransaction(c.tenantId, check.id, 'test', c.userId);
    const v = await srv.request('POST', '/api/v1/templates/from-transaction', c.token, { transactionId: check.id, name: 'Void' }, c.companyId);
    expect(v.status).toBe(400);
    expect(v.json.error.code).toBe('TEMPLATE_SOURCE_INVALID');
    expect((await srv.request('POST', '/api/v1/templates/from-transaction', c.token, { transactionId: invoice.id, name: 'B' }, c.companyB)).status).toBe(404);
    void journalLines; void and;
  });
});
