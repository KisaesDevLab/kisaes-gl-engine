// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import { tenants, users, sessions, accounts, companies, auditLog } from '../db/schema/index.js';
import * as accountsService from './accounts.service.js';

let tenantId: string;

// Tenant-scoped cleanup — only ever touch this file's own tenant so
// concurrently-running suites' data survives.
async function cleanDb() {
  if (!tenantId) return;
  await db.delete(auditLog).where(eq(auditLog.tenantId, tenantId));
  await db.delete(accounts).where(eq(accounts.tenantId, tenantId));
  await db.delete(companies).where(eq(companies.tenantId, tenantId));
  await db.delete(sessions).where(
    inArray(sessions.userId, db.select({ id: users.id }).from(users).where(eq(users.tenantId, tenantId))),
  );
  await db.delete(users).where(eq(users.tenantId, tenantId));
  await db.delete(tenants).where(eq(tenants.id, tenantId));
  tenantId = '';
}

async function createTestTenant(): Promise<string> {
  const [tenant] = await db.insert(tenants).values({
    name: 'Test Company',
    slug: 'test-company-' + Date.now(),
  }).returning();
  return tenant!.id;
}

describe('Accounts Service', () => {
  beforeEach(async () => {
    await cleanDb();
    tenantId = await createTestTenant();
  });

  afterEach(async () => {
    await cleanDb();
  });

  describe('seedFromTemplate', () => {
    it('should seed default COA template', async () => {
      await accountsService.seedFromTemplate(tenantId, 'default');
      const result = await accountsService.list(tenantId, { limit: 100, offset: 0 });
      expect(result.total).toBeGreaterThan(30);

      // Check system accounts exist
      const systemAccounts = result.data.filter((a) => a.isSystem);
      expect(systemAccounts.length).toBe(7);
      const tags = systemAccounts.map((a) => a.systemTag).sort();
      expect(tags).toContain('accounts_receivable');
      expect(tags).toContain('accounts_payable');
      expect(tags).toContain('payments_clearing');
      expect(tags).toContain('retained_earnings');
      expect(tags).toContain('opening_balances');
      expect(tags).toContain('cash_on_hand');
      expect(tags).toContain('sales_tax_payable');
    });

    it('should seed freelancer template', async () => {
      await accountsService.seedFromTemplate(tenantId, 'freelancer');
      const result = await accountsService.list(tenantId, { limit: 100, offset: 0 });
      expect(result.total).toBeGreaterThan(10);
      // Freelancer template (graphic_design) should have Revenues, Cash & Check
      const revenue = result.data.find((a) => a.name === 'Revenues, Cash & Check');
      expect(revenue).toBeDefined();
    });
  });

  describe('CRUD', () => {
    it('should create an account', async () => {
      const account = await accountsService.create(tenantId, {
        name: 'Test Account',
        accountType: 'asset',
        accountNumber: '9000',
        detailType: 'bank',
      });
      expect(account.name).toBe('Test Account');
      expect(account.accountNumber).toBe('9000');
      expect(account.accountType).toBe('asset');
    });

    it('should reject duplicate account number', async () => {
      await accountsService.create(tenantId, {
        name: 'Account 1',
        accountType: 'asset',
        accountNumber: '9000',
      });
      await expect(
        accountsService.create(tenantId, {
          name: 'Account 2',
          accountType: 'asset',
          accountNumber: '9000',
        }),
      ).rejects.toThrow('already exists');
    });

    it('should update an account', async () => {
      const account = await accountsService.create(tenantId, {
        name: 'Original',
        accountType: 'expense',
      });
      const updated = await accountsService.update(tenantId, account.id, {
        name: 'Updated',
      });
      expect(updated.name).toBe('Updated');
    });

    it('should list accounts with filters', async () => {
      await accountsService.seedFromTemplate(tenantId, 'default');
      const assets = await accountsService.list(tenantId, { accountType: 'asset', limit: 100, offset: 0 });
      expect(assets.data.every((a) => a.accountType === 'asset')).toBe(true);

      const searched = await accountsService.list(tenantId, { search: 'cash', limit: 100, offset: 0 });
      expect(searched.data.length).toBeGreaterThan(0);
    });
  });

  describe('system account protection', () => {
    it('should not deactivate system accounts', async () => {
      await accountsService.seedFromTemplate(tenantId, 'default');
      const result = await accountsService.list(tenantId, { limit: 100, offset: 0 });
      const systemAccount = result.data.find((a) => a.isSystem);
      expect(systemAccount).toBeDefined();

      await expect(
        accountsService.deactivate(tenantId, systemAccount!.id),
      ).rejects.toThrow('Cannot deactivate a system account');
    });

    it('should not change type of system accounts', async () => {
      await accountsService.seedFromTemplate(tenantId, 'default');
      const result = await accountsService.list(tenantId, { limit: 100, offset: 0 });
      const systemAccount = result.data.find((a) => a.isSystem && a.accountType === 'asset');

      await expect(
        accountsService.update(tenantId, systemAccount!.id, { accountType: 'expense' }),
      ).rejects.toThrow('Cannot change the type of a system account');
    });
  });

  describe('merge', () => {
    it('should merge two accounts of the same type', async () => {
      const source = await accountsService.create(tenantId, { name: 'Source', accountType: 'expense' });
      const target = await accountsService.create(tenantId, { name: 'Target', accountType: 'expense' });

      const result = await accountsService.merge(tenantId, source.id, target.id);
      expect(result.id).toBe(target.id);

      // Source should be deactivated
      const sourceAfter = await accountsService.getById(tenantId, source.id);
      expect(sourceAfter.isActive).toBe(false);
    });

    it('should reject merging different types', async () => {
      const source = await accountsService.create(tenantId, { name: 'Source', accountType: 'expense' });
      const target = await accountsService.create(tenantId, { name: 'Target', accountType: 'asset' });

      await expect(
        accountsService.merge(tenantId, source.id, target.id),
      ).rejects.toThrow('Cannot merge accounts of different types');
    });

    it('should reject merging system accounts', async () => {
      await accountsService.seedFromTemplate(tenantId, 'default');
      const result = await accountsService.list(tenantId, { limit: 100, offset: 0 });
      const systemAccount = result.data.find((a) => a.isSystem);
      const target = await accountsService.create(tenantId, { name: 'Target', accountType: systemAccount!.accountType as 'asset' });

      await expect(
        accountsService.merge(tenantId, systemAccount!.id, target.id),
      ).rejects.toThrow('Cannot merge a system account');
    });
  });

  describe('import/export', () => {
    it('should import accounts from CSV data', async () => {
      const csvData = [
        { name: 'Import 1', accountNumber: '9001', accountType: 'asset' as const, detailType: 'bank' },
        { name: 'Import 2', accountNumber: '9002', accountType: 'expense' as const, detailType: 'other_expense' },
      ];
      const result = await accountsService.importFromCsv(tenantId, { accounts: csvData });
      expect(result.imported).toBe(2);
      expect(result.accounts.length).toBe(2);
      expect(result.skipped).toEqual([]);
    });

    it('should skip account numbers that already exist instead of failing', async () => {
      await accountsService.create(tenantId, { name: 'Cash', accountNumber: '9101', accountType: 'asset' });

      const result = await accountsService.importFromCsv(tenantId, {
        accounts: [
          { name: 'Cash From File', accountNumber: '9101', accountType: 'asset' as const },
          { name: 'Fresh', accountNumber: '9102', accountType: 'expense' as const },
        ],
      });

      expect(result.imported).toBe(1);
      expect(result.updated).toBe(0);
      expect(result.skipped).toHaveLength(1);
      expect(result.skipped[0]).toMatchObject({ row: 1, accountNumber: '9101' });

      const kept = await accountsService.list(tenantId, { limit: 500, offset: 0 });
      expect(kept.data.find((a) => a.accountNumber === '9101')?.name).toBe('Cash');
    });

    it('should overwrite existing accounts when updateExisting is set', async () => {
      await accountsService.create(tenantId, { name: 'Old Name', accountNumber: '9201', accountType: 'asset' });

      const result = await accountsService.importFromCsv(tenantId, {
        accounts: [{ name: 'New Name', accountNumber: '9201', accountType: 'expense' as const, detailType: 'Immediate' }],
        updateExisting: true,
      });

      expect(result.imported).toBe(0);
      expect(result.updated).toBe(1);

      const after = await accountsService.list(tenantId, { limit: 500, offset: 0 });
      const row = after.data.find((a) => a.accountNumber === '9201');
      expect(row?.name).toBe('New Name');
      expect(row?.accountType).toBe('expense');
      expect(row?.detailType).toBe('Immediate');
    });

    it('should skip a number repeated inside the same file', async () => {
      const result = await accountsService.importFromCsv(tenantId, {
        accounts: [
          { name: 'First', accountNumber: '9301', accountType: 'asset' as const },
          { name: 'Second', accountNumber: '9301', accountType: 'asset' as const },
        ],
      });

      expect(result.imported).toBe(1);
      expect(result.skipped).toHaveLength(1);
      expect(result.skipped[0]?.reason).toMatch(/within the file/i);
    });

    it('should export to CSV', async () => {
      await accountsService.seedFromTemplate(tenantId, 'default');
      const csv = await accountsService.exportToCsv(tenantId);
      expect(csv).toContain('Account Number,Name,Type');
      expect(csv).toContain('Cash');
    });
  });
});
