// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

// PUT /accounts/:id/sensitive (U-33): Admin only, the refusal list,
// idempotent, one audit row with only {isSensitive}; PUT /accounts/:id
// and /bulk ignore the field.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { accounts, auditLog } from '../db/schema/index.js';
import { startSensitiveHarness, type SensitiveHarness } from './sensitive.test-fixtures.js';

let h: SensitiveHarness;
beforeEach(async () => { h = await startSensitiveHarness('sens-flag'); });
afterEach(async () => { await h.close(); });

async function flagOf(id: string): Promise<boolean> {
  const [row] = await db.select({ f: accounts.isSensitive }).from(accounts).where(eq(accounts.id, id));
  return row!.f;
}

async function auditRows(id: string) {
  return db.select().from(auditLog).where(and(eq(auditLog.tenantId, h.tenantId), eq(auditLog.entityId, id), eq(auditLog.action, 'update')));
}

describe('accounts list, pickers and registers for a viewer without the right (E1-E3)', () => {
  it('leaves hidden accounts out of the list and export; their ids are 404', async () => {
    await h.markWages();
    const bk = await h.call('bk', 'GET', '/api/v1/accounts?limit=500');
    expect(bk.status).toBe(200);
    const ids = bk.json.data.map((a: { id: string }) => a.id);
    expect(ids).toContain(h.acct.supplies);
    expect(ids).not.toContain(h.acct.wages);
    expect(ids).not.toContain(h.acct.wagesSub);
    expect(bk.text).not.toContain('Canary');
    expect(bk.json.total).toBe(ids.length);
    const csv = await h.call('bk', 'GET', '/api/v1/accounts/export');
    expect(csv.status).toBe(200);
    expect(csv.text).not.toContain('Canary');
    expect(csv.text).toContain('Supplies');
    const own = await h.call('owner', 'GET', '/api/v1/accounts?limit=500');
    expect(own.json.data.map((a: { id: string }) => a.id)).toEqual(expect.arrayContaining([h.acct.wages, h.acct.wagesSub]));
    expect(own.json.data.find((a: { id: string }) => a.id === h.acct.wages).isSensitive).toBe(true);
    // Merge and bulk edit can't reach a hidden account.
    expect((await h.call('bk', 'POST', '/api/v1/accounts/merge', { sourceId: h.acct.supplies, targetId: h.acct.wages })).status).toBe(404);
    expect((await h.call('bk', 'PUT', '/api/v1/accounts/bulk', { updates: [{ id: h.acct.wages, name: 'x' }] })).status).toBe(404);
  });

  it('bank register: the paycheck line keeps its amount and balance, the other side is withheld', async () => {
    const { postTransaction } = await import('../services/ledger.service.js');
    await postTransaction(h.tenantId, {
      txnType: 'expense', txnDate: '2026-03-01', memo: 'payroll',
      lines: [{ accountId: h.acct.wagesSub, debit: '4321.09', credit: '0' }, { accountId: h.acct.bank, debit: '0', credit: '4321.09' }],
    }, h.ownerId, h.companyId);
    await postTransaction(h.tenantId, {
      txnType: 'expense', txnDate: '2026-03-02', memo: 'paper',
      lines: [{ accountId: h.acct.supplies, debit: '10.0000', credit: '0' }, { accountId: h.acct.bank, debit: '0', credit: '10.0000' }],
    }, h.ownerId, h.companyId);
    const path = `/api/v1/accounts/${h.acct.bank}/register?start_date=2026-01-01&end_date=2026-12-31&exact=1`;
    const before = await h.call('bk', 'GET', path);
    expect(before.json.lines.every((l: { hiddenSplit?: boolean }) => l.hiddenSplit === undefined)).toBe(true);
    await h.markWages();
    const bk = await h.call('bk', 'GET', path);
    const owner = await h.call('owner', 'GET', path);
    expect(bk.status).toBe(200);
    expect(bk.json.endingBalance).toBe('-4331.0900');
    expect(bk.json.endingBalance).toBe(owner.json.endingBalance);
    const pay = bk.json.lines.find((l: { memo: string }) => l.memo === 'payroll');
    expect(pay).toMatchObject({ payment: '4321.0900', categoryName: null, categoryAccountId: null, accountName: null, hiddenSplit: true, isEditable: false });
    const ownerPay = owner.json.lines.find((l: { memo: string }) => l.memo === 'payroll');
    expect(ownerPay.categoryName).toBe('Canary Wages Officers');
    expect(ownerPay.hiddenSplit).toBeUndefined();
    expect(pay.runningBalance).toBe(ownerPay.runningBalance);
    const paper = bk.json.lines.find((l: { memo: string }) => l.memo === 'paper');
    expect(paper.categoryName).toBe('Supplies');
    expect(paper.hiddenSplit).toBeUndefined();
    expect(bk.text).not.toContain('Canary');
    expect(bk.text).not.toContain(h.acct.wagesSub);
    // The hidden account's own register and summary are not found.
    expect((await h.call('bk', 'GET', `/api/v1/accounts/${h.acct.wagesSub}/register`)).status).toBe(404);
    expect((await h.call('bk', 'GET', `/api/v1/accounts/${h.acct.wages}/register/summary`)).status).toBe(404);
  });
});

describe('PUT /accounts/:id/sensitive', () => {
  it('lets the owner mark and unmark an account, one audit row per change', async () => {
    const r = await h.call('owner', 'PUT', `/api/v1/accounts/${h.acct.wages}/sensitive`, { isSensitive: true });
    expect(r.status).toBe(200);
    expect(r.json.account.isSensitive).toBe(true);
    expect(await flagOf(h.acct.wages)).toBe(true);

    // Idempotent: same value again changes nothing and writes no row.
    const again = await h.call('owner', 'PUT', `/api/v1/accounts/${h.acct.wages}/sensitive`, { isSensitive: true });
    expect(again.status).toBe(200);
    let rows = await auditRows(h.acct.wages);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.beforeData).toEqual({ isSensitive: false });
    expect(rows[0]!.afterData).toEqual({ isSensitive: true });
    expect(rows[0]!.entityType).toBe('account');

    const off = await h.call('owner', 'PUT', `/api/v1/accounts/${h.acct.wages}/sensitive`, { isSensitive: false });
    expect(off.status).toBe(200);
    expect(await flagOf(h.acct.wages)).toBe(false);
    rows = await auditRows(h.acct.wages);
    expect(rows).toHaveLength(2);
  });

  it('refuses everyone but the Admin', async () => {
    const r = await h.call('bk', 'PUT', `/api/v1/accounts/${h.acct.supplies}/sensitive`, { isSensitive: true });
    expect(r.status).toBe(403);
    expect(await flagOf(h.acct.supplies)).toBe(false);
  });

  it('refuses bank, card and built-in accounts with 422 SENSITIVE_NOT_ALLOWED', async () => {
    const [card] = await db.insert(accounts).values({ tenantId: h.tenantId, name: 'Visa', accountType: 'liability', detailType: 'credit_card', accountNumber: '2100' }).returning();
    for (const id of [h.acct.bank, h.acct.ar, h.acct.ap, card!.id]) {
      const r = await h.call('owner', 'PUT', `/api/v1/accounts/${id}/sensitive`, { isSensitive: true });
      expect(r.status).toBe(422);
      expect(r.json.error.code).toBe('SENSITIVE_NOT_ALLOWED');
      expect(await flagOf(id)).toBe(false);
    }
    // A parent whose sub-account is a bank account can't be marked either.
    await db.update(accounts).set({ parentId: h.acct.supplies }).where(eq(accounts.id, h.acct.bank));
    const parent = await h.call('owner', 'PUT', `/api/v1/accounts/${h.acct.supplies}/sensitive`, { isSensitive: true });
    expect(parent.status).toBe(422);
    expect(parent.json.error.code).toBe('SENSITIVE_NOT_ALLOWED');
    expect(await flagOf(h.acct.supplies)).toBe(false);
    // Unmarking is always allowed (a no-op here).
    expect((await h.call('owner', 'PUT', `/api/v1/accounts/${h.acct.bank}/sensitive`, { isSensitive: false })).status).toBe(200);
  });

  it('rejects a bad body and an unknown account', async () => {
    expect((await h.call('owner', 'PUT', `/api/v1/accounts/${h.acct.wages}/sensitive`, { isSensitive: 'yes' })).status).toBe(400);
    expect((await h.call('owner', 'PUT', `/api/v1/accounts/00000000-0000-4000-8000-000000000000/sensitive`, { isSensitive: true })).status).toBe(404);
  });

  it('PUT /accounts/:id and /bulk ignore isSensitive', async () => {
    const r = await h.call('owner', 'PUT', `/api/v1/accounts/${h.acct.supplies}`, { name: 'Supplies 2', isSensitive: true });
    expect(r.status).toBe(200);
    expect(await flagOf(h.acct.supplies)).toBe(false);
    const b = await h.call('owner', 'PUT', '/api/v1/accounts/bulk', { updates: [{ id: h.acct.supplies, name: 'Supplies 3', isSensitive: true }] });
    expect(b.status).toBe(200);
    expect(await flagOf(h.acct.supplies)).toBe(false);
  });
});

describe('no bank, card or built-in account under a sensitive account (review S4)', () => {
  it('create, move and type change under a sensitive ancestor are 422; elsewhere unchanged', async () => {
    await h.markWages();
    for (const body of [
      { name: 'Payroll Checking', accountType: 'asset', detailType: 'bank', accountNumber: '1012', parentId: h.acct.wagesSub },
      { name: 'Payroll Card', accountType: 'liability', detailType: 'credit_card', accountNumber: '2101', parentId: h.acct.wages },
    ]) {
      const r = await h.call('owner', 'POST', '/api/v1/accounts', body);
      expect([body.name, r.status, r.json?.error?.code]).toEqual([body.name, 422, 'SENSITIVE_NOT_ALLOWED']);
    }
    // Moving the bank account under the sensitive one, or a sub-account into a bank under it.
    const mv = await h.call('owner', 'PUT', `/api/v1/accounts/${h.acct.bank}`, { parentId: h.acct.wages });
    expect([mv.status, mv.json?.error?.code]).toEqual([422, 'SENSITIVE_NOT_ALLOWED']);
    const retype = await h.call('owner', 'PUT', `/api/v1/accounts/${h.acct.wagesSub}`, { accountType: 'asset', detailType: 'bank' });
    expect([retype.status, retype.json?.error?.code]).toEqual([422, 'SENSITIVE_NOT_ALLOWED']);
    // A parent holding a bank account can't move under the sensitive account either.
    const holder = await h.call('owner', 'POST', '/api/v1/accounts', { name: 'Cash Group', accountType: 'asset', accountNumber: '1050' });
    await h.call('owner', 'POST', '/api/v1/accounts', { name: 'Cash Drawer', accountType: 'asset', detailType: 'bank', accountNumber: '1051', parentId: holder.json.account?.id ?? holder.json.id });
    const mvHolder = await h.call('owner', 'PUT', `/api/v1/accounts/${holder.json.account?.id ?? holder.json.id}`, { parentId: h.acct.wages });
    expect([mvHolder.status, mvHolder.json?.error?.code]).toEqual([422, 'SENSITIVE_NOT_ALLOWED']);
    // Plain accounts still go anywhere.
    const fine = await h.call('owner', 'POST', '/api/v1/accounts', { name: 'Officer Bonus', accountType: 'expense', accountNumber: '6997', parentId: h.acct.wages });
    expect(fine.status).toBe(201);
    const bankElsewhere = await h.call('owner', 'POST', '/api/v1/accounts', { name: 'Savings', accountType: 'asset', detailType: 'bank', accountNumber: '1013' });
    expect(bankElsewhere.status).toBe(201);
  });
});