// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Super-admin repair: point any system-account role (accounts.system_tag) at
// an existing account when a tenant's system accounts were deleted or
// mis-tagged. Covers the role catalog/status endpoint (missing, duplicate,
// type-mismatch detection) and assignment (move semantics, type validation,
// tenant scoping, clearing).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { SYSTEM_ACCOUNT_ROLES } from '@kis-books/shared';
import { db } from '../db/index.js';
import { tenants, users, sessions, companies, accounts, auditLog } from '../db/schema/index.js';
import * as authService from './auth.service.js';
import * as accountsService from './accounts.service.js';
import * as admin from './admin.service.js';

let tenantId = '', userId = '';

async function cleanTenant(tid: string, uid: string) {
  if (!tid) return;
  await db.delete(auditLog).where(eq(auditLog.tenantId, tid));
  await db.delete(accounts).where(eq(accounts.tenantId, tid));
  await db.delete(companies).where(eq(companies.tenantId, tid));
  await db.delete(sessions).where(eq(sessions.userId, uid));
  await db.delete(users).where(eq(users.tenantId, tid));
  await db.delete(tenants).where(eq(tenants.id, tid));
}

async function registerTenant(prefix: string) {
  const { user } = await authService.register({
    email: `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`,
    password: 'password123', displayName: 'SysAcct', companyName: `${prefix} Co`,
  });
  return { tenantId: user.tenantId, userId: user.id };
}

const tagHolders = (tag: string) => db.select().from(accounts)
  .where(and(eq(accounts.tenantId, tenantId), eq(accounts.systemTag, tag)));

const roleFor = async (tag: string) => {
  const info = await admin.getSystemAccountsInfo(tenantId);
  const role = info.roles.find((r) => r.tag === tag);
  expect(role).toBeDefined();
  return role!;
};

beforeEach(async () => {
  await cleanTenant(tenantId, userId);
  ({ tenantId, userId } = await registerTenant('sysacct'));
});
afterEach(async () => { await cleanTenant(tenantId, userId); tenantId = ''; userId = ''; });

describe('admin getSystemAccountsInfo', () => {
  it('reports every catalog role; required roles are assigned after seeding', async () => {
    const info = await admin.getSystemAccountsInfo(tenantId);
    expect(info.roles.map((r) => r.tag).sort()).toEqual(SYSTEM_ACCOUNT_ROLES.map((r) => r.tag).sort());
    for (const role of info.roles) {
      if (role.required) {
        expect(role.assigned, `required role ${role.tag} should be seeded`).not.toBeNull();
        expect(role.typeMismatch).toBe(false);
        expect(role.duplicates).toEqual([]);
      } else {
        expect(role.assigned).toBeNull(); // daily-sales roles are lazy-created
      }
    }
    expect(info.accounts.length).toBeGreaterThan(0);
  });

  it('flags a deleted system account as missing', async () => {
    const [ap] = await tagHolders('accounts_payable');
    await db.delete(accounts).where(eq(accounts.id, ap!.id));
    const role = await roleFor('accounts_payable');
    expect(role.assigned).toBeNull();
    expect(role.required).toBe(true);
  });

  it('flags duplicates and type mismatches', async () => {
    // Duplicate: second account with the same tag (pre-guard corrupt state).
    const dup = await accountsService.create(tenantId, { name: 'AP Two', accountType: 'liability', accountNumber: '29998' });
    await db.update(accounts).set({ systemTag: 'accounts_payable' }).where(eq(accounts.id, dup.id));
    const apRole = await roleFor('accounts_payable');
    expect(apRole.assigned).not.toBeNull();
    expect(apRole.duplicates.length).toBe(1);

    // Type mismatch: retag the sales-tax role onto an expense account.
    const [tax] = await tagHolders('sales_tax_payable');
    await db.update(accounts).set({ systemTag: null }).where(eq(accounts.id, tax!.id));
    const wrong = await accountsService.create(tenantId, { name: 'Wrong Type', accountType: 'expense', accountNumber: '69998' });
    await db.update(accounts).set({ systemTag: 'sales_tax_payable' }).where(eq(accounts.id, wrong.id));
    const taxRole = await roleFor('sales_tax_payable');
    expect(taxRole.typeMismatch).toBe(true);
  });

  it('rejects an unknown tenant', async () => {
    await expect(admin.getSystemAccountsInfo('00000000-0000-0000-0000-000000000000')).rejects.toThrow(/tenant not found/i);
  });
});

describe('admin assignSystemAccount', () => {
  it('repairs a tenant whose system account was deleted (stamps tag, isSystem, canonical detail type)', async () => {
    const [ap] = await tagHolders('accounts_payable');
    await db.delete(accounts).where(eq(accounts.id, ap!.id));

    const replacement = await accountsService.create(tenantId, { name: 'New AP', accountType: 'liability', accountNumber: '29999' });
    const info = await admin.assignSystemAccount(tenantId, 'accounts_payable', replacement.id, userId);

    const role = info.roles.find((r) => r.tag === 'accounts_payable')!;
    expect(role.assigned?.id).toBe(replacement.id);
    const rows = await tagHolders('accounts_payable');
    expect(rows.length).toBe(1);
    expect(rows[0]!.isSystem).toBe(true);
    expect(rows[0]!.detailType).toBe('accounts_payable'); // canonical detail type stamped
  });

  it('moves the tag atomically — exactly one holder after reassignment, old holder untagged', async () => {
    const [oldTax] = await tagHolders('sales_tax_payable');
    const next = await accountsService.create(tenantId, { name: 'State Tax Payable', accountType: 'liability', accountNumber: '20950' });

    await admin.assignSystemAccount(tenantId, 'sales_tax_payable', next.id, userId);

    const rows = await tagHolders('sales_tax_payable');
    expect(rows.length).toBe(1);
    expect(rows[0]!.id).toBe(next.id);
    const old = await db.query.accounts.findFirst({ where: eq(accounts.id, oldTax!.id) });
    expect(old!.systemTag).toBeNull();
    expect(old!.isSystem).toBe(false);
  });

  it('does not stamp a detail type for roles without a canonical one', async () => {
    const next = await accountsService.create(tenantId, {
      name: 'Alt Clearing', accountType: 'asset', accountNumber: '10175', detailType: 'other_current_asset',
    });
    await admin.assignSystemAccount(tenantId, 'payments_clearing', next.id, userId);
    const row = await db.query.accounts.findFirst({ where: eq(accounts.id, next.id) });
    expect(row!.systemTag).toBe('payments_clearing');
    expect(row!.detailType).toBe('other_current_asset'); // untouched
  });

  it('clears a mapping (accountId: null), including duplicates', async () => {
    const dup = await accountsService.create(tenantId, { name: 'AP Dup', accountType: 'liability', accountNumber: '29997' });
    await db.update(accounts).set({ systemTag: 'accounts_payable' }).where(eq(accounts.id, dup.id));

    const info = await admin.assignSystemAccount(tenantId, 'accounts_payable', null, userId);

    expect(info.roles.find((r) => r.tag === 'accounts_payable')!.assigned).toBeNull();
    expect((await tagHolders('accounts_payable')).length).toBe(0);
  });

  it('rejects a type-incompatible account', async () => {
    const asset = await accountsService.create(tenantId, { name: 'Some Asset', accountType: 'asset', accountNumber: '19999' });
    await expect(admin.assignSystemAccount(tenantId, 'accounts_payable', asset.id, userId))
      .rejects.toThrow(/liability/i);
  });

  it('rejects an account that already serves another role', async () => {
    const [ar] = await tagHolders('accounts_receivable');
    // AR account is an asset — type-compatible with cash_on_hand, but already tagged.
    await expect(admin.assignSystemAccount(tenantId, 'cash_on_hand', ar!.id, userId))
      .rejects.toThrow(/already the system/i);
  });

  it('rejects an account belonging to another tenant', async () => {
    const other = await registerTenant('sysacct-b');
    try {
      const [otherAp] = await db.select().from(accounts)
        .where(and(eq(accounts.tenantId, other.tenantId), eq(accounts.systemTag, 'accounts_payable')));
      await expect(admin.assignSystemAccount(tenantId, 'accounts_payable', otherAp!.id, userId))
        .rejects.toThrow(/account not found/i);
    } finally {
      await cleanTenant(other.tenantId, other.userId);
    }
  });

  it('rejects an unknown role tag', async () => {
    const acct = await accountsService.create(tenantId, { name: 'X', accountType: 'asset', accountNumber: '19998' });
    await expect(admin.assignSystemAccount(tenantId, 'not_a_role', acct.id, userId))
      .rejects.toThrow(/unknown system account role/i);
  });

  it('audit-logs the assignment', async () => {
    const next = await accountsService.create(tenantId, { name: 'RE Two', accountType: 'equity', accountNumber: '39998' });
    await admin.assignSystemAccount(tenantId, 'retained_earnings', next.id, userId);
    const logs = await db.select().from(auditLog)
      .where(and(eq(auditLog.tenantId, tenantId), eq(auditLog.entityType, 'system_account_role')));
    expect(logs.length).toBe(1);
    expect(logs[0]!.entityId).toBe(next.id);
    expect(logs[0]!.userId).toBe(userId);
  });
});
