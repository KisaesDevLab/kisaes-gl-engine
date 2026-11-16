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
