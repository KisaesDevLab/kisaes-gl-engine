// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

// Super-admin repair: designate an equity account as the system Retained
// Earnings (system_tag='retained_earnings') when the original was deleted.
// Enforces exactly one RE per tenant, equity-only, and sets isSystem.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { tenants, users, sessions, companies, accounts, auditLog } from '../db/schema/index.js';
import * as authService from './auth.service.js';
import * as accountsService from './accounts.service.js';
import * as admin from './admin.service.js';

let tenantId = '', userId = '';

async function cleanDb() {
  if (!tenantId) return;
  await db.delete(auditLog).where(eq(auditLog.tenantId, tenantId));
  await db.delete(accounts).where(eq(accounts.tenantId, tenantId));
  await db.delete(companies).where(eq(companies.tenantId, tenantId));
  await db.delete(sessions).where(eq(sessions.userId, userId));
  await db.delete(users).where(eq(users.tenantId, tenantId));
  await db.delete(tenants).where(eq(tenants.id, tenantId));
  tenantId = '';
}

async function setup() {
  const { user } = await authService.register({
    email: `re-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`,
    password: 'password123', displayName: 'RE', companyName: 'RE Co',
  });
  tenantId = user.tenantId; userId = user.id;
}

const reRows = () => db.select().from(accounts)
  .where(and(eq(accounts.tenantId, tenantId), eq(accounts.systemTag, 'retained_earnings')));

beforeEach(async () => { await cleanDb(); await setup(); });
afterEach(async () => { await cleanDb(); });

describe('admin designateRetainedEarnings', () => {
  it('repairs a tenant whose system RE was deleted', async () => {
    // Simulate deletion: remove the seeded system RE account.
    const seeded = await reRows();
    for (const r of seeded) await db.delete(accounts).where(eq(accounts.id, r.id));

    let info = await admin.getRetainedEarningsInfo(tenantId);
    expect(info.current).toBeNull(); // now shows calculated

    const re = await accountsService.create(tenantId, { name: 'Retained Earnings', accountType: 'equity', accountNumber: '3999' });
    info = await admin.designateRetainedEarnings(tenantId, re.id, userId);

    expect(info.current?.id).toBe(re.id);
    const rows = await reRows();
    expect(rows.length).toBe(1);
    expect(rows[0]!.isSystem).toBe(true);
    expect(rows[0]!.detailType).toBe('retained_earnings');
  });

  it('reassigns cleanly — exactly one RE after moving the tag', async () => {
    const other = await accountsService.create(tenantId, { name: 'Owner Equity', accountType: 'equity', accountNumber: '3200' });
    await admin.designateRetainedEarnings(tenantId, other.id, userId);
    const rows = await reRows();
    expect(rows.length).toBe(1);
    expect(rows[0]!.id).toBe(other.id);
  });

  it('rejects a non-equity account', async () => {
    const asset = await accountsService.create(tenantId, { name: 'Some Asset', accountType: 'asset', accountNumber: '1999' });
    await expect(admin.designateRetainedEarnings(tenantId, asset.id, userId)).rejects.toThrow(/equity/i);
  });
});
