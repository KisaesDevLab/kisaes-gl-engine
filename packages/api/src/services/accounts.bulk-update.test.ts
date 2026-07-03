// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.
//
// Covers accountsService.bulkUpdate (the COA Bulk Edit table):
//   - edits number/name/type/detail on multiple accounts at once
//   - supports account-number SWAPS (A↔B) via the two-phase renumber
//   - refuses type changes on system accounts
//   - refuses duplicate numbers (within the batch and vs. outside rows)
//   - audits each change

import { describe, it, expect, afterEach } from 'vitest';
import { eq, and } from 'drizzle-orm';
import { db } from '../db/index.js';
import { tenants, accounts, auditLog as auditLogTable } from '../db/schema/index.js';
import { bulkUpdate } from './accounts.service.js';

let tenantId = '';

async function seed() {
  const [t] = await db.insert(tenants).values({ name: 'Bulk', slug: 'bulk-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6) }).returning();
  tenantId = t!.id;
  const rows = await db.insert(accounts).values([
    { tenantId, accountNumber: '10100', name: 'Cash', accountType: 'asset', detailType: 'bank', isSystem: true, systemTag: 'cash_on_hand' },
    { tenantId, accountNumber: '60100', name: 'Office Supplies', accountType: 'expense', detailType: 'office_expenses' },
    { tenantId, accountNumber: '60200', name: 'Software', accountType: 'expense', detailType: 'office_expenses' },
    { tenantId, accountNumber: '40100', name: 'Sales', accountType: 'revenue', detailType: 'service' },
  ]).returning();
  return Object.fromEntries(rows.map((r) => [r.name, r]));
}

afterEach(async () => {
  if (tenantId) {
    await db.delete(auditLogTable).where(eq(auditLogTable.tenantId, tenantId));
    await db.delete(accounts).where(eq(accounts.tenantId, tenantId));
    await db.delete(tenants).where(eq(tenants.id, tenantId));
    tenantId = '';
  }
});

describe('accountsService.bulkUpdate', () => {
  it('edits multiple fields across rows and audits each', async () => {
    const s = await seed();
    const updated = await bulkUpdate(tenantId, { updates: [
      { id: s['Office Supplies']!.id, name: 'Supplies & Materials', accountNumber: '60150' },
      { id: s['Sales']!.id, detailType: 'product', accountType: 'revenue' },
    ] });
    expect(updated).toHaveLength(2);
    const supplies = updated.find((a) => a.id === s['Office Supplies']!.id)!;
    expect(supplies.name).toBe('Supplies & Materials');
    expect(supplies.accountNumber).toBe('60150');
    const audits = await db.select().from(auditLogTable)
      .where(and(eq(auditLogTable.tenantId, tenantId), eq(auditLogTable.entityType, 'account')));
    expect(audits.length).toBe(2);
  });

  it('supports swapping two account numbers', async () => {
    const s = await seed();
    await bulkUpdate(tenantId, { updates: [
      { id: s['Office Supplies']!.id, accountNumber: '60200' },
      { id: s['Software']!.id, accountNumber: '60100' },
    ] });
    const after = await db.select().from(accounts).where(eq(accounts.tenantId, tenantId));
    expect(after.find((a) => a.id === s['Office Supplies']!.id)!.accountNumber).toBe('60200');
    expect(after.find((a) => a.id === s['Software']!.id)!.accountNumber).toBe('60100');
  });

  it('refuses a type change on a system account', async () => {
    const s = await seed();
    await expect(bulkUpdate(tenantId, { updates: [
      { id: s['Cash']!.id, accountType: 'expense' },
    ] })).rejects.toThrow(/system account/i);
  });

  it('refuses a number already used by an account outside the batch', async () => {
    const s = await seed();
    await expect(bulkUpdate(tenantId, { updates: [
      { id: s['Software']!.id, accountNumber: '40100' },
    ] })).rejects.toThrow(/already exists/i);
  });

  it('refuses the same number claimed twice within the batch', async () => {
    const s = await seed();
    await expect(bulkUpdate(tenantId, { updates: [
      { id: s['Office Supplies']!.id, accountNumber: '61000' },
      { id: s['Software']!.id, accountNumber: '61000' },
    ] })).rejects.toThrow(/more than one/i);
  });
});
