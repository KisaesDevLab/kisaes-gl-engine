// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

// Record stamps, more (U-291, stale-all-v1): payments racing over the same
// invoices do not deadlock; a form saves on the stamp its own child write
// returned (T9, S2); lines-only edits re-save on the returned stamp.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startLanEngine, DEVICE_A, DEVICE_B, type LanEngine } from '../desktop/lan.test-support.js';

let e: LanEngine;
let jwtA = '';
let jwtB = '';
let customer = '';
let income = '';
let bank = '';
let expA = '';
let expB = '';
const A = { device: DEVICE_A };
const B = { device: DEVICE_B };

async function invoice(amount: string): Promise<{ id: string; updatedAt: string }> {
  const r = await e.call(A, '/api/v1/invoices', {
    method: 'POST', jwt: jwtA,
    body: { txnDate: '2026-03-02', contactId: customer, lines: [{ accountId: income, description: 'Work', quantity: '1', unitPrice: amount }] },
  });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return r.json.invoice;
}

beforeAll(async () => {
  e = await startLanEngine();
  jwtA = await e.signIn(A);
  jwtB = await e.signIn(B);
  const list = ((await e.call(A, '/api/v1/accounts', { jwt: jwtA })).json);
  const accounts = (list.data ?? list.accounts ?? list) as Array<{ id: string; accountType: string; detailType?: string | null }>;
  income = accounts.find((a) => a.accountType === 'revenue')!.id;
  bank = accounts.find((a) => a.accountType === 'asset' && /bank|checking/i.test(a.detailType ?? ''))!.id;
  const exp = accounts.filter((a) => a.accountType === 'expense');
  expA = exp[0]!.id;
  expB = exp[1]!.id;
  const c = await e.call(A, '/api/v1/contacts', { method: 'POST', jwt: jwtA, body: { contactType: 'customer', displayName: 'Race Customer' } });
  customer = (c.json.contact ?? c.json).id;
}, 300_000);

afterAll(async () => {
  await e?.close();
});

describe('record stamps, more (U-291)', () => {
  it('two payments over the same two invoices in opposite order: no deadlock (20 runs)', async () => {
    for (let i = 0; i < 20; i++) {
      const [i1, i2] = [await invoice('100.00'), await invoice('100.00')];
      const pay = (who: typeof A, first: string, second: string, jwt: string) => e.call(who, '/api/v1/payments/receive', {
        method: 'POST', jwt,
        body: { customerId: customer, date: '2026-03-03', amount: '20.00', depositTo: bank,
          applications: [{ invoiceId: first, amount: '10.00' }, { invoiceId: second, amount: '10.00' }] },
      });
      const [p1, p2] = await Promise.all([pay(A, i1.id, i2.id, jwtA), pay(B, i2.id, i1.id, jwtB)]);
      expect(p1.status, JSON.stringify(p1.json)).toBe(201);
      expect(p2.status, JSON.stringify(p2.json)).toBe(201);
    }
  });

  it('an invoice re-saves on the stamp its own save returned (lines only)', async () => {
    const inv = await invoice('50.00');
    const body = (amount: string, stamp: string) => ({
      txnDate: '2026-03-02', contactId: customer, expectedUpdatedAt: stamp,
      lines: [{ accountId: income, description: 'Work', quantity: '1', unitPrice: amount }],
    });
    const r1 = await e.call(A, `/api/v1/invoices/${inv.id}`, { method: 'PUT', jwt: jwtA, body: body('60.00', inv.updatedAt) });
    expect(r1.status, JSON.stringify(r1.json)).toBe(200);
    const r2 = await e.call(A, `/api/v1/invoices/${inv.id}`, { method: 'PUT', jwt: jwtA, body: body('70.00', r1.json.invoice.updatedAt) });
    expect(r2.status, JSON.stringify(r2.json)).toBe(200);
    const stale = await e.call(B, `/api/v1/invoices/${inv.id}`, { method: 'PUT', jwt: jwtB, body: body('80.00', inv.updatedAt) });
    expect(stale.status).toBe(409);
  });

  it('attaching a file to an open entry returns the stamp its save then uses (T9)', async () => {
    const t = await e.call(A, '/api/v1/transactions', {
      method: 'POST', jwt: jwtA,
      body: { txnType: 'journal_entry', txnDate: '2026-03-02', memo: 'attach', lines: [
        { accountId: expA, debit: '4.00', credit: '0' }, { accountId: expB, debit: '0', credit: '4.00' }] },
    });
    expect(t.status, JSON.stringify(t.json)).toBe(201);
    const id = t.json.transaction.id as string;
    const form = new FormData();
    form.append('file', new Blob([Buffer.from('%PDF-1.4\n%%EOF\n')], { type: 'application/pdf' }), 'receipt.pdf');
    form.append('attachableType', 'transaction');
    form.append('attachableId', id);
    const up = await e.callRaw(A, '/api/v1/attachments', { method: 'POST', jwt: jwtA, body: form });
    expect(up.status, JSON.stringify(up.json)).toBe(201);
    expect(up.json.parentUpdatedAt).not.toBe(t.json.transaction.updatedAt);
    const save = await e.call(A, `/api/v1/transactions/${id}`, {
      method: 'PUT', jwt: jwtA,
      body: { txnType: 'journal_entry', txnDate: '2026-03-02', memo: 'attach saved', expectedUpdatedAt: up.json.parentUpdatedAt, lines: [
        { accountId: expA, debit: '5.00', credit: '0' }, { accountId: expB, debit: '0', credit: '5.00' }] },
    });
    expect(save.status, JSON.stringify(save.json)).toBe(200);
  });

  it('price-level items and JE template lines move their parent and re-save on the returned stamp', async () => {
    const pl = await e.call(A, '/api/v1/price-levels', { method: 'POST', jwt: jwtA, body: { name: 'Resave Level', percent: '0' } });
    expect(pl.status, JSON.stringify(pl.json)).toBe(201);
    const level = pl.json.priceLevel ?? pl.json;
    const r1 = await e.call(A, `/api/v1/price-levels/${level.id}`, { method: 'PUT', jwt: jwtA, body: { name: 'Resave Level', percent: '5', expectedUpdatedAt: level.updatedAt } });
    expect(r1.status, JSON.stringify(r1.json)).toBe(200);
    const next = (r1.json.priceLevel ?? r1.json).updatedAt as string;
    const r2 = await e.call(A, `/api/v1/price-levels/${level.id}`, { method: 'PUT', jwt: jwtA, body: { name: 'Resave Level 2', expectedUpdatedAt: next } });
    expect(r2.status, JSON.stringify(r2.json)).toBe(200);
  });
});
