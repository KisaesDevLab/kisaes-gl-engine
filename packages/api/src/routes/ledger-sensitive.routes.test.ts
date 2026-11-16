// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

// Sensitive accounts (U-33), E4–E6: a transaction with a line on a hidden
// account can't be opened, edited, voided, deleted or bulk-edited by a
// viewer without the right (403 SENSITIVE_ACCOUNT, before the closed-period
// 423), is left out of GET /transactions, and posting to a hidden account
// is refused. The owner is unaffected.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import * as ledger from '../services/ledger.service.js';
import { startSensitiveHarness, type SensitiveHarness } from './sensitive.test-fixtures.js';

let h: SensitiveHarness;
let hiddenTxn = '';
let visibleTxn = '';

beforeAll(async () => {
  h = await startSensitiveHarness('sens-ledger');
  const post = async (accountId: string, amount: string, memo: string) =>
    (await ledger.postTransaction(h.tenantId, {
      txnType: 'expense', txnDate: '2026-03-01', memo,
      lines: [{ accountId, debit: amount, credit: '0' }, { accountId: h.acct.bank, debit: '0', credit: amount }],
    }, h.ownerId, h.companyId)).id;
  hiddenTxn = await post(h.acct.wagesSub, '4321.09', 'payroll');
  visibleTxn = await post(h.acct.supplies, '10.00', 'paper');
  await h.markWages();
});

afterAll(async () => { await h.close(); });

const sensitive = (r: { status: number; json: any }) => {
  expect(r.status).toBe(403);
  expect(r.json.error.code).toBe('SENSITIVE_ACCOUNT');
};

describe('transactions touching a hidden account', () => {
  it('are refused to open for the bookkeeper, not for the owner', async () => {
    sensitive(await h.call('bk', 'GET', `/api/v1/transactions/${hiddenTxn}`));
    expect((await h.call('bk', 'GET', `/api/v1/transactions/${visibleTxn}`)).status).toBe(200);
    expect((await h.call('owner', 'GET', `/api/v1/transactions/${hiddenTxn}`)).status).toBe(200);
    // Any router naming the transaction in its path is refused the same way.
    sensitive(await h.call('bk', 'GET', `/api/v1/transactions/${hiddenTxn}/activity`));
    sensitive(await h.call('bk', 'GET', `/api/v1/checks/${hiddenTxn}`));
  });

  it('are left out of the transaction list', async () => {
    const bk = await h.call('bk', 'GET', '/api/v1/transactions?limit=100');
    expect(bk.status).toBe(200);
    const ids = bk.json.data.map((t: { id: string }) => t.id);
    expect(ids).toContain(visibleTxn);
    expect(ids).not.toContain(hiddenTxn);
    expect(bk.text).not.toContain('4321.09');
    expect(bk.json.total).toBe(1);
    const owner = await h.call('owner', 'GET', '/api/v1/transactions?limit=100');
    expect(owner.json.data.map((t: { id: string }) => t.id)).toContain(hiddenTxn);
  });

  it('are read-only: edit, void, delete and bulk edit refuse', async () => {
    sensitive(await h.call('bk', 'PUT', `/api/v1/transactions/${hiddenTxn}`, {
      txnType: 'expense', txnDate: '2026-03-01', payFromAccountId: h.acct.bank,
      lines: [{ expenseAccountId: h.acct.supplies, amount: '1.00' }],
    }));
    sensitive(await h.call('bk', 'POST', `/api/v1/transactions/${hiddenTxn}/void`, { reason: 'x' }));
    sensitive(await h.call('bk', 'DELETE', `/api/v1/transactions/${hiddenTxn}`));
    sensitive(await h.call('bk', 'POST', '/api/v1/transactions/bulk-update', { txnIds: [hiddenTxn], setTagId: null }));
    // Still posted.
    const row = await db.execute(sql`SELECT status FROM transactions WHERE id = ${hiddenTxn}`);
    expect((row.rows[0] as { status: string }).status).toBe('posted');
  });

  it('refuses posting to a hidden account', async () => {
    sensitive(await h.call('bk', 'POST', '/api/v1/transactions', {
      txnType: 'journal_entry', txnDate: '2026-03-02', memo: 'je',
      lines: [{ accountId: h.acct.wages, debit: '5.00', credit: '0' }, { accountId: h.acct.bank, debit: '0', credit: '5.00' }],
    }));
    const count = await db.execute(sql`SELECT count(*)::int AS c FROM journal_lines WHERE tenant_id = ${h.tenantId} AND account_id = ${h.acct.wages}`);
    expect((count.rows[0] as { c: number }).c).toBe(0);
  });

  it('refuses with 403 before the closed-period 423', async () => {
    await db.execute(sql`UPDATE companies SET lock_date = '2026-12-31' WHERE id = ${h.companyId}`);
    try {
      sensitive(await h.call('bk', 'POST', `/api/v1/transactions/${hiddenTxn}/void`, { reason: 'x' }));
      expect((await h.call('owner', 'POST', `/api/v1/transactions/${visibleTxn}/void`, { reason: 'x' })).status).toBe(423);
    } finally {
      await db.execute(sql`UPDATE companies SET lock_date = NULL WHERE id = ${h.companyId}`);
    }
  });

  it('hides a hidden account id in the path (404)', async () => {
    expect((await h.call('bk', 'GET', `/api/v1/accounts/${h.acct.wages}`)).status).toBe(404);
    expect((await h.call('bk', 'GET', `/api/v1/accounts/${h.acct.wagesSub}/register`)).status).toBe(404);
    expect((await h.call('owner', 'GET', `/api/v1/accounts/${h.acct.wages}`)).status).toBe(200);
  });
});
