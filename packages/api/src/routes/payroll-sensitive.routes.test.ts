// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.
//
// U-247 (payroll-import-sensitive-v1): a viewer with a hidden account (wages
// marked sensitive) is refused every payroll import route, sees no payroll
// overlap line of an entry touching a hidden account, and can't match a feed
// line to one. The owner sees and does all of it.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { db } from '../db/index.js';
import { bankConnections, bankFeedItems } from '../db/schema/index.js';
import * as ledger from '../services/ledger.service.js';
import { DESKTOP_CAPABILITIES } from '../desktop/capabilities.js';
import { startSensitiveHarness, type SensitiveHarness } from './sensitive.test-fixtures.js';

let h: SensitiveHarness;
let hiddenPayroll = '';
let visiblePayroll = '';
let hiddenItem = '';
let visibleItem = '';

beforeAll(async () => {
  h = await startSensitiveHarness('sens-payroll');
  const post = (memo: string, lines: Array<Record<string, unknown>>) =>
    ledger.postTransaction(h.tenantId, {
      txnType: 'journal_entry' as never, txnDate: '2026-03-10', memo, source: 'payroll_import', sourceId: 'p30', lines: lines as never,
    }, h.ownerId, h.companyId);
  hiddenPayroll = (await post('Payroll — pay date 2026-03-10', [
    { accountId: h.acct.wages, debit: '901.23', credit: '0' }, { accountId: h.acct.bank, debit: '0', credit: '901.23' },
  ])).id;
  visiblePayroll = (await post('Payroll — pay date 2026-03-10', [
    { accountId: h.acct.supplies, debit: '501.00', credit: '0' }, { accountId: h.acct.bank, debit: '0', credit: '501.00' },
  ])).id;
  await h.markWages();
  const [conn] = await db.insert(bankConnections).values({ tenantId: h.tenantId, companyId: h.companyId, accountId: h.acct.bank, provider: 'manual' }).returning();
  const item = async (amount: string) => (await db.insert(bankFeedItems).values({
    tenantId: h.tenantId, companyId: h.companyId, bankConnectionId: conn!.id, feedDate: '2026-03-11', amount,
    description: 'PAYROLL', originalDescription: 'PAYROLL', status: 'pending',
  }).returning())[0]!.id;
  hiddenItem = await item('901.23');
  visibleItem = await item('501.00');
}, 120_000);

afterAll(async () => { await h.close(); });

describe('U-247 sensitive accounts on payroll import', () => {
  it('lists the capability and the refuse prefix', async () => {
    expect(DESKTOP_CAPABILITIES).toContain('payroll-import-sensitive-v1');
    const doors = await h.call('bk', 'GET', '/api/v1/sensitive-doors');
    expect(doors.json.refusePrefixes).toContain('/api/v1/payroll-import');
  });

  it('refuses every payroll import route to the restricted viewer, not to the owner', async () => {
    for (const [method, path] of [
      ['GET', '/api/v1/payroll-import/sessions'],
      ['GET', '/api/v1/payroll-import/templates'],
      ['GET', `/api/v1/payroll-import/account-mappings/${h.companyId}`],
      ['POST', `/api/v1/payroll-import/account-mappings/${h.companyId}/auto-map`],
      ['PUT', `/api/v1/payroll-import/account-mappings/${h.companyId}`],
      ['POST', '/api/v1/payroll-import/sessions/00000000-0000-4000-8000-000000000001/post'],
    ] as const) {
      const bk = await h.call('bk', method, path, method === 'GET' ? undefined : { mappings: {} });
      expect([path, bk.status, bk.json?.error?.code]).toEqual([path, 403, 'SENSITIVE_HIDDEN']);
    }
    const own = await h.call('owner', 'GET', '/api/v1/payroll-import/sessions');
    expect(own.status).toBe(200);
  });

  it('the payroll overlap leaves out an entry touching a hidden account', async () => {
    const own = await h.call('owner', 'GET', `/api/v1/banking/feed/${hiddenItem}/payroll-overlap`);
    expect(own.json.overlaps.map((o: { txnId: string }) => o.txnId)).toEqual([hiddenPayroll]);
    const bk = await h.call('bk', 'GET', `/api/v1/banking/feed/${hiddenItem}/payroll-overlap`);
    expect(bk.status).toBe(200);
    expect(bk.json.overlaps).toEqual([]);
    expect(bk.text).not.toContain('901.23');
    const visible = await h.call('bk', 'GET', `/api/v1/banking/feed/${visibleItem}/payroll-overlap`);
    expect(visible.json.overlaps.map((o: { txnId: string }) => o.txnId)).toEqual([visiblePayroll]);
  });

  it('matching a feed line to such an entry is 403 SENSITIVE_ACCOUNT; a visible one matches', async () => {
    const own = await h.call('owner', 'GET', `/api/v1/banking/feed/${hiddenItem}/payroll-overlap`);
    const line = own.json.overlaps[0].journalLineId as string;
    const byTxn = await h.call('bk', 'PUT', `/api/v1/banking/feed/${hiddenItem}/match`, { transactionId: hiddenPayroll, journalLineId: line });
    expect([byTxn.status, byTxn.json?.error?.code]).toEqual([403, 'SENSITIVE_ACCOUNT']);
    // The line of a hidden entry named next to a visible entry id is refused too.
    const byLine = await h.call('bk', 'PUT', `/api/v1/banking/feed/${visibleItem}/match`, { transactionId: visiblePayroll, journalLineId: line });
    expect([byLine.status, byLine.json?.error?.code]).toEqual([403, 'SENSITIVE_ACCOUNT']);
    const ok = await h.call('bk', 'PUT', `/api/v1/banking/feed/${visibleItem}/match`, { transactionId: visiblePayroll });
    expect(ok.status).toBe(200);
  });
});
