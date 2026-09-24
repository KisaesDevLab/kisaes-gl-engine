// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import { tenants, users, sessions, accounts, companies, auditLog, contacts } from '../db/schema/index.js';
import * as contactsService from './contacts.service.js';

let tenantId: string;

// Tenant-SCOPED cleanup — unscoped deletes nuke concurrently-running
// suites' data and die on their FKs. Only ever touch our own tenant.
async function cleanDb() {
  if (!tenantId) return;
  await db.delete(auditLog).where(eq(auditLog.tenantId, tenantId));
  await db.delete(contacts).where(eq(contacts.tenantId, tenantId));
  await db.delete(accounts).where(eq(accounts.tenantId, tenantId));
  await db.delete(companies).where(eq(companies.tenantId, tenantId));
  // sessions has no tenant_id — scope through this tenant's users.
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
    slug: 'test-contacts-' + Date.now(),
  }).returning();
  return tenant!.id;
}

describe('Contacts Service', () => {
  beforeEach(async () => {
    await cleanDb();
    tenantId = await createTestTenant();
  });

  afterEach(async () => {
    await cleanDb();
  });

  describe('CRUD', () => {
    it('should create a customer', async () => {
      const contact = await contactsService.create(tenantId, {
        contactType: 'customer',
        displayName: 'Acme Corp',
        email: 'billing@acme.com',
        phone: '555-1234',
      });
      expect(contact.displayName).toBe('Acme Corp');
      expect(contact.contactType).toBe('customer');
      expect(contact.email).toBe('billing@acme.com');
    });

    it('should create a vendor', async () => {
      const contact = await contactsService.create(tenantId, {
        contactType: 'vendor',
        displayName: 'Office Depot',
        is1099Eligible: true,
        taxId: '12-3456789',
      });
      expect(contact.contactType).toBe('vendor');
      expect(contact.is1099Eligible).toBe(true);
      expect(contact.taxId).toBe('12-3456789');
    });

    // Migration 0177. Text, not numeric: a number column (or a numeric input)
    // would turn "00-4471-A" into garbage and "0012345" into 12345.
    it('stores the vendor account number as text, verbatim', async () => {
      const created = await contactsService.create(tenantId, {
        contactType: 'vendor',
        displayName: 'City Water',
        vendorAccountNumber: '0012345',
      });
      expect(created.vendorAccountNumber).toBe('0012345');

      const updated = await contactsService.update(tenantId, created.id, { vendorAccountNumber: '00-4471-A' });
      expect(updated.vendorAccountNumber).toBe('00-4471-A');
      expect((await contactsService.getById(tenantId, created.id)).vendorAccountNumber).toBe('00-4471-A');

      const cleared = await contactsService.update(tenantId, created.id, { vendorAccountNumber: null });
      expect(cleared.vendorAccountNumber).toBeNull();
    });

    it('should create a dual-type contact', async () => {
      const contact = await contactsService.create(tenantId, {
        contactType: 'both',
        displayName: 'Partner LLC',
      });
      expect(contact.contactType).toBe('both');
    });

    it('should update a contact', async () => {
      const contact = await contactsService.create(tenantId, {
        contactType: 'customer',
        displayName: 'Old Name',
      });
      const updated = await contactsService.update(tenantId, contact.id, {
        displayName: 'New Name',
        email: 'new@example.com',
      });
      expect(updated.displayName).toBe('New Name');
      expect(updated.email).toBe('new@example.com');
    });

    it('should deactivate a contact', async () => {
      const contact = await contactsService.create(tenantId, {
        contactType: 'customer',
        displayName: 'Deactivate Me',
      });
      const deactivated = await contactsService.deactivate(tenantId, contact.id);
      expect(deactivated?.isActive).toBe(false);
    });

    it('should get by id', async () => {
      const contact = await contactsService.create(tenantId, {
        contactType: 'vendor',
        displayName: 'Specific Vendor',
      });
      const found = await contactsService.getById(tenantId, contact.id);
      expect(found.displayName).toBe('Specific Vendor');
    });

    it('should throw not found for invalid id', async () => {
      await expect(
        contactsService.getById(tenantId, '00000000-0000-0000-0000-000000000000'),
      ).rejects.toThrow('Contact not found');
    });
  });

  describe('list with filters', () => {
    beforeEach(async () => {
      await contactsService.create(tenantId, { contactType: 'customer', displayName: 'Customer A', email: 'a@test.com' });
      await contactsService.create(tenantId, { contactType: 'customer', displayName: 'Customer B' });
      await contactsService.create(tenantId, { contactType: 'vendor', displayName: 'Vendor X' });
      await contactsService.create(tenantId, { contactType: 'both', displayName: 'Both Contact' });
    });

    it('should list all contacts', async () => {
      const result = await contactsService.list(tenantId, { limit: 50, offset: 0 });
      expect(result.total).toBe(4);
    });

    it('should filter by customer type (including both)', async () => {
      const result = await contactsService.list(tenantId, { contactType: 'customer', limit: 50, offset: 0 });
      expect(result.total).toBe(3); // Customer A, Customer B, Both Contact
    });

    it('should filter by vendor type (including both)', async () => {
      const result = await contactsService.list(tenantId, { contactType: 'vendor', limit: 50, offset: 0 });
      expect(result.total).toBe(2); // Vendor X, Both Contact
    });

    it('should search by name', async () => {
      const result = await contactsService.list(tenantId, { search: 'Customer A', limit: 50, offset: 0 });
      expect(result.total).toBe(1);
      expect(result.data[0]!.displayName).toBe('Customer A');
    });

    it('should search by email', async () => {
      const result = await contactsService.list(tenantId, { search: 'a@test', limit: 50, offset: 0 });
      expect(result.total).toBe(1);
    });

    it('sorts server-side by the whitelisted keys, name as tiebreak', async () => {
      await contactsService.create(tenantId, { contactType: 'vendor', displayName: 'Zed', email: 'a@x.com' });
      await contactsService.create(tenantId, { contactType: 'customer', displayName: 'Amy', email: 'z@x.com' });
      await contactsService.create(tenantId, { contactType: 'both', displayName: 'Mid', email: null });
      // The suite's beforeEach seeds other contacts; only the relative order
      // of these three is asserted.
      const mine = new Set(['Amy', 'Mid', 'Zed']);
      const names = async (f: Parameters<typeof contactsService.list>[1]) =>
        (await contactsService.list(tenantId, f)).data.map((c) => c.displayName).filter((n) => mine.has(n));
      expect(await names({})).toEqual(['Amy', 'Mid', 'Zed']);
      expect(await names({ sortBy: 'name', sortDir: 'desc' })).toEqual(['Zed', 'Mid', 'Amy']);
      // both < customer < vendor alphabetically.
      expect(await names({ sortBy: 'type', sortDir: 'asc' })).toEqual(['Mid', 'Amy', 'Zed']);
      // Missing email last either way.
      expect(await names({ sortBy: 'email', sortDir: 'asc' })).toEqual(['Zed', 'Amy', 'Mid']);
      expect(await names({ sortBy: 'email', sortDir: 'desc' })).toEqual(['Amy', 'Zed', 'Mid']);
    });

    it('joins the default expense category name and number onto list rows', async () => {
      const [util] = await db.insert(accounts).values({
        tenantId, name: 'Utilities', accountType: 'expense', accountNumber: '7021',
      }).returning();
      const vendor = await contactsService.create(tenantId, { contactType: 'vendor', displayName: 'Spire', defaultExpenseAccountId: util!.id });
      const { data } = await contactsService.list(tenantId, { contactType: 'vendor' });
      const row = data.find((c) => c.id === vendor.id)!;
      expect(row.defaultExpenseAccountName).toBe('Utilities');
      expect(row.defaultExpenseAccountNumber).toBe('7021');
      // A contact without one reads null, not a missing key.
      const plain = data.find((c) => c.id !== vendor.id);
      if (plain) expect(plain.defaultExpenseAccountName).toBeNull();
    });

    it('should filter by active', async () => {
      const all = await contactsService.list(tenantId, { limit: 50, offset: 0 });
      const c = all.data[0]!;
      await contactsService.deactivate(tenantId, c.id);

      const active = await contactsService.list(tenantId, { isActive: true, limit: 50, offset: 0 });
      expect(active.total).toBe(3);
      const inactive = await contactsService.list(tenantId, { isActive: false, limit: 50, offset: 0 });
      expect(inactive.total).toBe(1);
    });
  });

  describe('merge', () => {
    it('should merge contacts and deactivate source', async () => {
      const source = await contactsService.create(tenantId, { contactType: 'customer', displayName: 'Duplicate' });
      const target = await contactsService.create(tenantId, { contactType: 'customer', displayName: 'Keep This' });

      const result = await contactsService.merge(tenantId, source.id, target.id);
      expect(result.id).toBe(target.id);

      const sourceAfter = await contactsService.getById(tenantId, source.id);
      expect(sourceAfter.isActive).toBe(false);
    });

    it('should reject merging contact with itself', async () => {
      const contact = await contactsService.create(tenantId, { contactType: 'customer', displayName: 'Self' });
      await expect(
        contactsService.merge(tenantId, contact.id, contact.id),
      ).rejects.toThrow('Cannot merge a contact with itself');
    });
  });

  describe('import/export', () => {
    it('should import contacts', async () => {
      const result = await contactsService.importFromCsv(tenantId, [
        { displayName: 'Import 1', email: 'i1@test.com' },
        { displayName: 'Import 2', phone: '555-0000' },
      ], 'customer');
      expect(result.length).toBe(2);
      expect(result[0]!.contactType).toBe('customer');
    });

    it('should export to CSV', async () => {
      await contactsService.create(tenantId, { contactType: 'customer', displayName: 'Export Test' });
      const csv = await contactsService.exportToCsv(tenantId);
      expect(csv).toContain('Display Name,Type');
      expect(csv).toContain('Export Test');
    });

    it('should export filtered by type', async () => {
      await contactsService.create(tenantId, { contactType: 'customer', displayName: 'Cust' });
      await contactsService.create(tenantId, { contactType: 'vendor', displayName: 'Vend' });

      const csv = await contactsService.exportToCsv(tenantId, 'vendor');
      expect(csv).toContain('Vend');
      expect(csv).not.toContain('Cust');
    });
  });

  describe('transaction history', () => {
    it('should return empty for now (Phase 4)', async () => {
      const contact = await contactsService.create(tenantId, { contactType: 'customer', displayName: 'Test' });
      const result = await contactsService.getTransactionHistory(tenantId, contact.id, {});
      expect(result.data).toEqual([]);
      expect(result.total).toBe(0);
    });
  });
});
