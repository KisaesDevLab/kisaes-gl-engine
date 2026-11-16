// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

// Sensitive accounts (U-33, Q-P29f): audit rows about a hidden account or a
// transaction touching one stay listed for a restricted viewer, with
// before/after blank and redacted: true. The owner sees them whole.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as ledger from '../services/ledger.service.js';
import { startSensitiveHarness, type SensitiveHarness } from './sensitive.test-fixtures.js';

let h: SensitiveHarness;
let hiddenTxn = '';

beforeAll(async () => {
  h = await startSensitiveHarness('sens-audit');
  hiddenTxn = (await ledger.postTransaction(h.tenantId, {
    txnType: 'expense', txnDate: '2026-03-01', memo: 'payroll',
    lines: [{ accountId: h.acct.wages, debit: '4321.09', credit: '0' }, { accountId: h.acct.bank, debit: '0', credit: '4321.09' }],
  }, h.ownerId, h.companyId)).id;
  await h.markWages();
});

afterAll(async () => { await h.close(); });

describe('GET /audit-log for a viewer without sensitive_accounts', () => {
  it('blanks rows about hidden accounts and their transactions, keeps the rest', async () => {
    const bk = await h.call('bk', 'GET', '/api/v1/audit-log?limit=500');
    expect(bk.status).toBe(200);
    expect(bk.text).not.toContain('Canary');
    expect(bk.text).not.toContain('4321.09');
    const rows = bk.json.data as Array<{ entity_id: string | null; entity_type: string; before_data: unknown; after_data: unknown; redacted?: boolean }>;
    // The hidden account's rows stay listed, blanked, without its id.
    expect(rows.some((r) => r.entity_id === h.acct.wages)).toBe(false);
    const redacted = rows.filter((r) => r.redacted === true);
    expect(redacted.length).toBeGreaterThanOrEqual(3); // create, mark, the payroll transaction
    for (const r of redacted) expect(r).toMatchObject({ before_data: null, after_data: null });
    expect(redacted.some((r) => r.entity_type === 'account' && r.entity_id === null)).toBe(true);
    expect((await h.call('bk', 'GET', '/api/v1/audit-log/export')).text).not.toContain(h.acct.wages);
    const supplies = rows.find((r) => r.entity_id === h.acct.supplies);
    expect(supplies?.redacted).toBeUndefined();
    expect(supplies?.after_data).not.toBeNull();

    const own = await h.call('owner', 'GET', '/api/v1/audit-log?limit=500');
    expect(own.text).toContain('Canary Wages');
    expect(own.json.data.every((r: { redacted?: boolean }) => r.redacted === undefined)).toBe(true);
    // Filtering on the hidden transaction is refused outright.
    expect((await h.call('bk', 'GET', `/api/v1/audit-log?entity_id=${hiddenTxn}`)).status).toBe(403);
  });
});
