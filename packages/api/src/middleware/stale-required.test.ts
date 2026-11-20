// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

// 428 STALE_REQUIRED in LAN mode (U-292, stale-required-v1; T7).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startLanEngine, DEVICE_A, type LanEngine } from '../desktop/lan.test-support.js';
import { requiredStampField } from './stale-required.js';

let e: LanEngine;
let jwt = '';
let accA = '';
let accB = '';
const A = { device: DEVICE_A };

const jeBody = (extra: Record<string, unknown> = {}) => ({
  txnType: 'journal_entry', txnDate: '2026-03-02', memo: 'required test',
  lines: [{ accountId: accA, debit: '5.00', credit: '0' }, { accountId: accB, debit: '0', credit: '5.00' }], ...extra,
});

beforeAll(async () => {
  e = await startLanEngine();
  jwt = await e.signIn(A);
  const r = await e.call(A, '/api/v1/accounts', { jwt });
  const list = (r.json.data ?? r.json.accounts ?? r.json) as Array<{ id: string; accountType: string }>;
  const exp = list.filter((a) => a.accountType === 'expense');
  accA = exp[0]!.id;
  accB = exp[1]!.id;
}, 300_000);

afterAll(async () => {
  await e?.close();
});

describe('stale-required (U-292)', () => {
  it('maps classes to fields', () => {
    expect(requiredStampField('PUT', '/api/v1/transactions/0b6c2a4e-6f6e-4c1d-8a37-6c1f4d8e9a01')).toBe('expectedUpdatedAt');
    expect(requiredStampField('PUT', '/api/v1/budgets/0b6c2a4e-6f6e-4c1d-8a37-6c1f4d8e9a01')).toBe('version');
    expect(requiredStampField('POST', '/api/v1/tags/bulk-tag')).toBe('stamps');
    expect(requiredStampField('POST', '/api/v1/transactions')).toBeNull();
    expect(requiredStampField('GET', '/api/v1/transactions/x')).toBeNull();
  });

  it('a stale-checked write without its stamp is 428, from a workstation and from the host', async () => {
    const c = await e.call(A, '/api/v1/transactions', { method: 'POST', jwt, body: jeBody() });
    expect(c.status, JSON.stringify(c.json)).toBe(201);
    const id = c.json.transaction.id as string;
    const r = await e.call(A, `/api/v1/transactions/${id}`, { method: 'PUT', jwt, body: jeBody() });
    expect(r.status).toBe(428);
    expect(r.json.error).toMatchObject({ code: 'STALE_REQUIRED', details: { field: 'expectedUpdatedAt' } });
    const hostJwt = await e.signIn('host');
    expect((await e.call('host', `/api/v1/transactions/${id}`, { method: 'PUT', jwt: hostJwt, body: jeBody() })).status).toBe(428);
    const ok = await e.call(A, `/api/v1/transactions/${id}`, { method: 'PUT', jwt, body: jeBody({ expectedUpdatedAt: c.json.transaction.updatedAt }) });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    // DELETE carries its stamp in the query.
    const del = await e.call(A, `/api/v1/transactions/${id}?expectedUpdatedAt=${encodeURIComponent(ok.json.transaction.updatedAt)}`, { method: 'DELETE', jwt });
    expect(del.status, JSON.stringify(del.json)).toBe(200);
    expect((await e.call(A, '/api/v1/tags/bulk-tag', { method: 'POST', jwt, body: { transactionIds: [], tagIds: [] } })).status).toBe(428);
  });

  it('creates and reads need no stamp; the automatic reversal void still works (T7)', async () => {
    const c = await e.call(A, '/api/v1/transactions', { method: 'POST', jwt, body: jeBody({ reverseOn: '2026-04-01' }) });
    expect(c.status, JSON.stringify(c.json)).toBe(201);
    const id = c.json.transaction.id as string;
    expect((await e.call(A, `/api/v1/transactions/${id}`, { jwt })).status).toBe(200);
    const v = await e.call(A, `/api/v1/transactions/${id}/void`, { method: 'POST', jwt, body: { reason: 'test', expectedUpdatedAt: c.json.transaction.updatedAt } });
    expect(v.status, JSON.stringify(v.json)).toBe(200);
    const live = await e.query<{ n: string }>(
      "SELECT COUNT(*) AS n FROM transactions WHERE reverses_transaction_id = $1 AND status <> 'void'", [id]);
    expect(Number(live[0]!.n)).toBe(0);
  });
});
