import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { db } from '../db/index.js';
import { tenants, users, sessions, accounts, companies, auditLog } from '../db/schema/index.js';
import * as accountsService from './accounts.service.js';

let tenantId: string;

async function cleanDb() {
  await db.delete(auditLog);
  await db.delete(accounts);
  await db.delete(companies);
  await db.delete(sessions);
  await db.delete(users);
  await db.delete(tenants);
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
      expect(systemAccounts.length).toBe(6);
      const tags = systemAccounts.map((a) => a.systemTag).sort();
      expect(tags).toContain('accounts_receivable');
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

      const searched = await accountsService.list(tenantId, { search: 'checking', limit: 100, offset: 0 });
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
        { name: 'Import 1', accountNumber: '9001', accountType: 'asset', detailType: 'bank' },
        { name: 'Import 2', accountNumber: '9002', accountType: 'expense', detailType: 'other_expense' },
      ];
      const result = await accountsService.importFromCsv(tenantId, csvData);
      expect(result.length).toBe(2);
    });

    it('should export to CSV', async () => {
      await accountsService.seedFromTemplate(tenantId, 'default');
      const csv = await accountsService.exportToCsv(tenantId);
      expect(csv).toContain('Account Number,Name,Type');
      expect(csv).toContain('Business Checking');
    });
  });
});
