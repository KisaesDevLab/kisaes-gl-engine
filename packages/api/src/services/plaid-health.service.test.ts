// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// The detection half of Plaid connection health.
//
// Repair was always well covered; knowing something needed repairing was not.
// The two assertions that matter most here are the ones that were previously
// impossible: a feed that stopped SUCCEEDING (last_sync_at cannot answer that,
// see migration 0166), and a connection that has gone silent on webhooks.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { plaidItems, plaidAccounts } from '../db/schema/index.js';
import { getPlaidHealth } from './plaid-health.service.js';

const marker = 'HEALTHTEST-' + Date.now();
let itemId = '';

const suffix = () => Date.now() + '-' + Math.random().toString(36).slice(2, 6);

async function mkItem(fields: Partial<typeof plaidItems.$inferInsert> = {}) {
  const [item] = await db.insert(plaidItems).values({
    plaidItemId: 'pi-' + suffix(),
    plaidInstitutionId: 'ins_health',
    institutionName: marker,
    accessTokenEncrypted: 'x',
    // Old enough that the "should have synced by now" arms apply.
    createdAt: new Date(Date.now() - 60 * 24 * 3600_000),
    ...fields,
  }).returning();
  itemId = item!.id;
  return item!;
}

/** Issues raised against this test's own institution only. */
async function issuesHere() {
  const health = await getPlaidHealth();
  return health.issues.filter((i) => i.institutionName === marker);
}

afterEach(async () => {
  await db.delete(plaidAccounts).where(eq(plaidAccounts.plaidItemId, itemId));
  await db.execute(sql`DELETE FROM plaid_items WHERE institution_name = ${marker}`);
  itemId = '';
});

describe('getPlaidHealth', () => {
  it('flags a feed that has not SUCCEEDED, even though it syncs constantly', async () => {
    // The exact shape the old check could not see: last_sync_at is recent
    // because the claim and the error path both bump it, but nothing has
    // actually succeeded in a month.
    await mkItem({
      lastSyncAt: new Date(),
      lastSyncStatus: 'error',
      lastSuccessAt: new Date(Date.now() - 30 * 24 * 3600_000),
      lastSyncError: 'RATE_LIMIT_EXCEEDED',
    });
    const kinds = (await issuesHere()).map((i) => i.kind);
    expect(kinds).toContain('feed_stale');
    // And separately as a failing sync nobody was emailed about.
    expect(kinds).toContain('sync_failing');
  });

  it('does not flag a healthy, recently succeeded connection', async () => {
    await mkItem({
      lastSyncAt: new Date(), lastSyncStatus: 'success', lastSuccessAt: new Date(),
      itemStatus: 'active',
    });
    // A webhook-silence warning is expected (this fixture logs none), but no
    // error-level issue should be raised.
    const errors = (await issuesHere()).filter((i) => i.severity === 'error');
    expect(errors).toEqual([]);
  });

  it('flags a connection that has gone silent on webhooks', async () => {
    await mkItem({ lastSyncStatus: 'success', lastSuccessAt: new Date() });
    const kinds = (await issuesHere()).map((i) => i.kind);
    // Nothing else in the system ever compares webhook receipt against now —
    // this is the failure a domain move causes, and it used to be invisible.
    expect(kinds).toContain('webhook_stale');
  });

  it('warns before a consent lapses rather than after', async () => {
    await mkItem({
      lastSyncStatus: 'success', lastSuccessAt: new Date(),
      consentExpirationAt: new Date(Date.now() + 5 * 24 * 3600_000),
    });
    const consent = (await issuesHere()).filter((i) => i.kind === 'consent_expiring');
    expect(consent).toHaveLength(1);
    expect(consent[0]!.severity).toBe('error');
  });

  it('does NOT flag an account that is merely unmapped', async () => {
    // Clients routinely tick every account in Plaid Link, personal ones
    // included, so unmapped is the normal case and not something to chase.
    // The connection list already shows each one with a Map button.
    const item = await mkItem({ lastSyncStatus: 'success', lastSuccessAt: new Date() });
    await db.insert(plaidAccounts).values({
      plaidItemId: item.id, plaidAccountId: 'pa-' + suffix(),
      name: 'FREE CHECKING', accountType: 'depository', accountSubtype: 'checking', mask: '6968',
    });
    const kinds = (await issuesHere()).map((i) => i.kind);
    expect(kinds).not.toContain('account_unmapped');
  });

  it('ignores a removed connection entirely', async () => {
    await mkItem({ removedAt: new Date(), itemStatus: 'removed', lastSyncStatus: 'error' });
    expect(await issuesHere()).toEqual([]);
  });

  it('does not call a brand-new connection stale', async () => {
    // Created moments ago: no webhook and no success yet is normal, not a fault.
    await mkItem({ createdAt: new Date() });
    const kinds = (await issuesHere()).map((i) => i.kind);
    expect(kinds).not.toContain('webhook_stale');
    expect(kinds).not.toContain('feed_stale');
  });
});
