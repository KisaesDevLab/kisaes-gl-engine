// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

// Sensitive accounts (U-33, Q-P29f): audit rows about a hidden account or a
// transaction touching one stay listed for a restricted viewer, with
// before/after blank and redacted: true. The owner sees them whole.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

const state = vi.hoisted(() => ({ desktop: false }));
vi.mock('../desktop/profile.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../desktop/profile.js')>();
  return { ...actual, isDesktop: () => state.desktop };
});
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

describe('audit search and export (security review S1)', () => {
  it('a search never matches the images of a withheld row, and total counts only what may match', async () => {
    // The attack: rebuild the paycheck amount digit by digit from which searches match.
    for (const q of ['4321.09', '"4321', 'Canary', h.acct.wages]) {
      const bk = await h.call('bk', 'GET', `/api/v1/audit-log?limit=500&search=${encodeURIComponent(q)}`);
      expect(bk.status).toBe(200);
      expect([q, bk.json.total, bk.json.data.length]).toEqual([q, 0, 0]);
    }
    // A search still finds rows that touch nothing hidden, and the entity type of a withheld row.
    const plain = await h.call('bk', 'GET', `/api/v1/audit-log?limit=500&search=Supplies`);
    expect(plain.json.total).toBeGreaterThan(0);
    expect(plain.json.total).toBe(plain.json.data.length);
    const byType = await h.call('bk', 'GET', `/api/v1/audit-log?limit=500&search=transaction`);
    expect(byType.json.data.some((r: { redacted?: boolean }) => r.redacted === true)).toBe(true);
    // The owner searches everything.
    const own = await h.call('owner', 'GET', `/api/v1/audit-log?limit=500&search=Canary`);
    expect(own.json.total).toBeGreaterThan(0);
  });

  it('on the desktop only the owner may export; reads are unchanged; the server build is unchanged', async () => {
    state.desktop = true;
    try {
      const bk = await h.call('bk', 'GET', '/api/v1/audit-log/export');
      expect([bk.status, bk.json?.error?.code]).toEqual([403, 'OWNER_REQUIRED']);
      expect((await h.call('bk', 'GET', '/api/v1/audit-log?limit=5')).status).toBe(200);
      expect((await h.call('owner', 'GET', '/api/v1/audit-log/export')).status).toBe(200);
    } finally {
      state.desktop = false;
    }
    expect((await h.call('bk', 'GET', '/api/v1/audit-log/export')).status).toBe(200);
  });
});