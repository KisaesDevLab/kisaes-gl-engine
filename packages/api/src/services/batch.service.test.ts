// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { db } from '../db/index.js';
import { tenants, users, sessions, accounts, companies, auditLog, contacts, transactions, journalLines, tags, transactionTags } from '../db/schema/index.js';
import * as batchService from './batch.service.js';
import * as accountsService from './accounts.service.js';
import * as ledger from './ledger.service.js';

let tenantId: string;
let bankAccountId: string;
let expenseAccountId: string;
let revenueAccountId: string;
let arAccountId: string;

// Tenant-SCOPED cleanup — unscoped deletes nuke concurrently-running
// suites' data and die on their FKs. Only ever touch our own tenant.
async function cleanDb() {
  if (!tenantId) return;
  await db.delete(transactionTags).where(eq(transactionTags.tenantId, tenantId));
  await db.delete(tags).where(eq(tags.tenantId, tenantId));
  await db.delete(journalLines).where(eq(journalLines.tenantId, tenantId));
  await db.delete(transactions).where(eq(transactions.tenantId, tenantId));
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

async function setup() {
  const [tenant] = await db.insert(tenants).values({ name: 'Batch Test', slug: 'batch-test-' + Date.now() }).returning();
  tenantId = tenant!.id;

  const bank = await accountsService.create(tenantId, { name: 'Business Checking', accountType: 'asset', detailType: 'bank', accountNumber: '1010' });
  bankAccountId = bank.id;
  const exp = await accountsService.create(tenantId, { name: 'Office Supplies', accountType: 'expense', accountNumber: '6400' });
  expenseAccountId = exp.id;
  const rev = await accountsService.create(tenantId, { name: 'Service Revenue', accountType: 'revenue', accountNumber: '4000' });
  revenueAccountId = rev.id;
  const ar = await accountsService.create(tenantId, { name: 'Accounts Receivable', accountType: 'asset', detailType: 'accounts_receivable', accountNumber: '1100' });
  ar.isSystem = true;
  arAccountId = ar.id;
  // Set system tag for AR
  await db.update(accounts).set({ isSystem: true, systemTag: 'accounts_receivable' }).where(eq(accounts.id, ar.id));

  // Create a vendor contact
  await db.insert(contacts).values({ tenantId, contactType: 'vendor', displayName: 'Office Depot' });
}

import { eq, inArray } from 'drizzle-orm';

describe('Batch Service', () => {
  beforeEach(async () => { await cleanDb(); await setup(); });
  afterEach(async () => { await cleanDb(); });

  describe('validateBatch', () => {
    it('should validate expense rows', async () => {
      const result = await batchService.validateBatch(tenantId, 'expense', bankAccountId, [
        { rowNumber: 1, date: '2026-03-15', contactName: 'Office Depot', accountName: 'Office Supplies', amount: 127.50 },
        { rowNumber: 2, date: '2026-03-16', accountName: 'Office Supplies', amount: 50 },
      ]);

      expect(result.validCount).toBe(2);
      expect(result.invalidCount).toBe(0);
      expect(result.rows[0]!.resolvedContactId).toBeTruthy();
      expect(result.rows[0]!.resolvedAccountId).toBeTruthy();
    });

    it('should flag missing amount', async () => {
      const result = await batchService.validateBatch(tenantId, 'expense', bankAccountId, [
        { rowNumber: 1, date: '2026-03-15', accountName: 'Office Supplies', amount: 0 },
      ]);
      expect(result.invalidCount).toBe(1);
      expect(result.rows[0]!.errors[0]!.field).toBe('amount');
    });

    it('should fuzzy match account names', async () => {
      const result = await batchService.validateBatch(tenantId, 'expense', bankAccountId, [
        { rowNumber: 1, date: '2026-03-15', accountName: 'Office Supplies', amount: 100 },
      ]);
      // Exact match should resolve
      expect(result.rows[0]!.resolvedAccountId).toBeTruthy();

      // Partial name should get a suggestion error
      const partial = await batchService.validateBatch(tenantId, 'expense', bankAccountId, [
        { rowNumber: 1, date: '2026-03-15', accountName: 'Ofice', amount: 100 },
      ]);
      expect(partial.rows[0]!.errors.length).toBeGreaterThan(0);
      expect(partial.rows[0]!.errors[0]!.message).toContain('not found');
    });

    it('should flag unresolved accounts', async () => {
      const result = await batchService.validateBatch(tenantId, 'expense', bankAccountId, [
        { rowNumber: 1, date: '2026-03-15', accountName: 'Nonexistent Account XYZ', amount: 100 },
      ]);
      expect(result.invalidCount).toBe(1);
    });

    it('should validate JE balance per group', async () => {
      const result = await batchService.validateBatch(tenantId, 'journal_entry', null, [
        { rowNumber: 1, date: '2026-03-31', refNo: 'ADJ-001', accountName: 'Office Supplies', debit: 500 },
        { rowNumber: 2, date: '2026-03-31', refNo: 'ADJ-001', accountName: 'Business Checking', credit: 500 },
      ]);
      expect(result.validCount).toBe(2);
    });

    it('should reject unbalanced JE group', async () => {
      const result = await batchService.validateBatch(tenantId, 'journal_entry', null, [
        { rowNumber: 1, date: '2026-03-31', refNo: 'BAD', accountName: 'Office Supplies', debit: 500 },
        { rowNumber: 2, date: '2026-03-31', refNo: 'BAD', accountName: 'Business Checking', credit: 300 },
      ]);
      expect(result.invalidCount).toBeGreaterThan(0);
    });
  });

  describe('saveBatch', () => {
    it('should save expense batch', async () => {
      const result = await batchService.saveBatch(tenantId, 'expense', bankAccountId, [
        { rowNumber: 1, date: '2026-03-15', accountName: 'Office Supplies', amount: 100, memo: 'Paper' },
        { rowNumber: 2, date: '2026-03-16', accountName: 'Office Supplies', amount: 200, memo: 'Toner' },
      ], { autoCreateContacts: true });

      expect(result.savedCount).toBe(2);

      // Verify ledger balance
      const validation = await ledger.validateBalance(tenantId);
      expect(validation.valid).toBe(true);
    });

    it('should auto-create contacts', async () => {
      const result = await batchService.saveBatch(tenantId, 'expense', bankAccountId, [
        { rowNumber: 1, date: '2026-03-15', contactName: 'New Vendor LLC', accountName: 'Office Supplies', amount: 50 },
      ], { autoCreateContacts: true });

      expect(result.createdContacts.length).toBe(1);
      expect(result.createdContacts[0]!.displayName).toBe('New Vendor LLC');
    });

    it('should reject batch with invalid rows when skipInvalid=false', async () => {
      await expect(
        batchService.saveBatch(tenantId, 'expense', bankAccountId, [
          { rowNumber: 1, date: '2026-03-15', accountName: 'Office Supplies', amount: 100 },
          { rowNumber: 2, date: '', accountName: '', amount: 0 }, // invalid
        ], { skipInvalid: false }),
      ).rejects.toThrow('invalid rows');
    });
  });

  describe('parseCsv', () => {
    it('should parse CSV with auto-detected columns', () => {
      const csv = 'Date,Payee,Account,Memo,Amount\n2026-03-15,Office Depot,Office Supplies,Paper,127.50\n03/16/2026,Staples,Office Supplies,Toner,50.00';
      const rows = batchService.parseCsv(csv, 'expense');
      expect(rows.length).toBe(2);
      expect(rows[0]!.date).toBe('2026-03-15');
      expect(rows[0]!.contactName).toBe('Office Depot');
      expect(rows[0]!.amount).toBe(127.5);
      expect(rows[1]!.date).toBe('2026-03-16');
    });

    it('should handle currency symbols and commas', () => {
      const csv = 'Date,Amount\n2026-03-15,"$1,234.56"\n2026-03-16,(500.00)';
      const rows = batchService.parseCsv(csv, 'expense');
      expect(rows[0]!.amount).toBe(1234.56);
      expect(rows[1]!.amount).toBe(-500);
    });
  });

  describe('suggestAccountForContact', () => {
    it('returns the contact configured default expense account first', async () => {
      const [vendor] = await db.insert(contacts).values({
        tenantId, contactType: 'vendor', displayName: 'Preferred Vendor',
        defaultExpenseAccountId: expenseAccountId,
      }).returning();
      const res = await batchService.suggestAccountForContact(tenantId, vendor!.id);
      expect(res.accountId).toBe(expenseAccountId);
      expect(res.source).toBe('default');
    });

    it('falls back to the most recently used category account', async () => {
      const [vendor] = await db.insert(contacts).values({
        tenantId, contactType: 'vendor', displayName: 'Historic Vendor',
      }).returning();
      await batchService.saveBatch(tenantId, 'expense', bankAccountId, [
        { rowNumber: 1, date: '2026-04-01', contactName: 'Historic Vendor', accountName: 'Office Supplies', amount: 75 },
      ], { autoCreateContacts: false });
      const res = await batchService.suggestAccountForContact(tenantId, vendor!.id);
      // The bank (asset) leg is excluded; only the expense category remains.
      expect(res.accountId).toBe(expenseAccountId);
      expect(res.source).toBe('recent');
    });

    it('returns null when there is neither a default nor any history', async () => {
      const [vendor] = await db.insert(contacts).values({
        tenantId, contactType: 'vendor', displayName: 'Fresh Vendor',
      }).returning();
      const res = await batchService.suggestAccountForContact(tenantId, vendor!.id);
      expect(res.accountId).toBeNull();
      expect(res.source).toBeNull();
    });
  });

  describe('fuzzy matching', () => {
    it('should exact-match contact', async () => {
      const result = await batchService.resolveContactByName(tenantId, 'Office Depot');
      expect(result.match).toBeTruthy();
      expect(result.isExact).toBe(true);
    });

    it('should fuzzy-match contact', async () => {
      const result = await batchService.resolveContactByName(tenantId, 'Office');
      expect(result.match || result.suggestions.length > 0).toBe(true);
    });

    it('should exact-match account by name', async () => {
      const result = await batchService.resolveAccountByName(tenantId, 'Office Supplies');
      expect(result.match).toBeTruthy();
      expect(result.isExact).toBe(true);
    });

    it('should match account by number', async () => {
      const result = await batchService.resolveAccountByName(tenantId, '6400');
      expect(result.match).toBeTruthy();
    });
  });
});
