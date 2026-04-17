// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { db } from '../db/index.js';
import { tenants, users, sessions, accounts, companies, auditLog, contacts } from '../db/schema/index.js';
import * as contactsService from './contacts.service.js';

let tenantId: string;

async function cleanDb() {
  await db.delete(auditLog);
  await db.delete(contacts);
  await db.delete(accounts);
  await db.delete(companies);
  await db.delete(sessions);
  await db.delete(users);
  await db.delete(tenants);
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
