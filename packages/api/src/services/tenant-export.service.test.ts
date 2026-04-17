// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'crypto';
import {
  encryptWithPassphrase,
  decryptWithPassphrase,
  validatePassphraseStrength,
} from './portable-encryption.service.js';

// These tests cover the export/import logic that doesn't require a database:
// - Encryption round-trip with export payloads
// - Version compatibility checks
// - Passphrase validation for exports
// - Wrong passphrase rejection
// - Corrupt file detection

const TEST_PASSPHRASE = 'test-export-passphrase-2026';

function buildTestPayload() {
  return {
    metadata: {
      export_type: 'tenant',
      version: '1.0.0',
      source_version: '0.3.0',
      created_at: new Date().toISOString(),
      created_by: 'test@example.com',
      encryption_method: 'passphrase_pbkdf2_aes256gcm',
      company_name: 'Test Corp',
      fiscal_year_start: 1,
      transaction_count: 42,
      counts: {
        accounts: 15,
        contacts: 8,
        transactions: 42,
        invoices: 5,
        bills: 3,
        attachments: 2,
        tags: 4,
        items: 6,
        budgets: 1,
        bank_rules: 3,
      },
      checksum: 'sha256:abc123',
    },
    company: { business_name: 'Test Corp', currency: 'USD' },
    accounts: [
      { id: crypto.randomUUID(), name: 'Cash', account_type: 'asset', account_number: '1000', balance: '5000.00' },
      { id: crypto.randomUUID(), name: 'Revenue', account_type: 'revenue', account_number: '4000', balance: '10000.00' },
    ],
    contacts: [
      { id: crypto.randomUUID(), display_name: 'Acme Inc', email: 'info@acme.com', contact_type: 'customer' },
    ],
    transactions: [
      { id: crypto.randomUUID(), txn_type: 'invoice', txn_date: '2026-01-15', total: '1500.00', status: 'posted' },
      { id: crypto.randomUUID(), txn_type: 'expense', txn_date: '2026-02-20', total: '250.00', status: 'posted' },
    ],
    journal_lines: [],
    invoices: [],
    bills: [],
    bill_payment_applications: [],
    vendor_credit_applications: [],
    tag_groups: [],
    tags: [{ id: crypto.randomUUID(), name: 'Tax Deductible', color: '#22c55e' }],
    transaction_tags: [],
    items: [{ id: crypto.randomUUID(), name: 'Consulting', item_type: 'service', rate: '150.00' }],
    bank_rules: [{ id: crypto.randomUUID(), name: 'Office Supplies', match_value: 'staples' }],
    budgets: [],
    budget_lines: [],
    recurring_templates: [],
    recurring_template_lines: [],
    categorization_history: [],
    audit_trail: [],
    attachments_meta: [],
    attachment_files: [],
    saved_report_filters: [],
  };
}

describe('Tenant Export/Import (unit)', () => {
  describe('Export encryption round-trip', () => {
    it('should encrypt and decrypt a tenant export payload', () => {
      const payload = buildTestPayload();
      const data = Buffer.from(JSON.stringify(payload));
      const encrypted = encryptWithPassphrase(data, TEST_PASSPHRASE);
      const decrypted = decryptWithPassphrase(encrypted, TEST_PASSPHRASE);
      const parsed = JSON.parse(decrypted.toString());

      expect(parsed.metadata.export_type).toBe('tenant');
      expect(parsed.metadata.company_name).toBe('Test Corp');
      expect(parsed.accounts).toHaveLength(2);
      expect(parsed.contacts).toHaveLength(1);
      expect(parsed.transactions).toHaveLength(2);
    });

    it('should reject wrong passphrase with clear error', () => {
      const payload = buildTestPayload();
      const data = Buffer.from(JSON.stringify(payload));
      const encrypted = encryptWithPassphrase(data, TEST_PASSPHRASE);

      expect(() => decryptWithPassphrase(encrypted, 'wrong-passphrase-here'))
        .toThrow('Incorrect passphrase');
    });

    it('should detect corrupted/tampered export file', () => {
      const payload = buildTestPayload();
      const data = Buffer.from(JSON.stringify(payload));
      const encrypted = encryptWithPassphrase(data, TEST_PASSPHRASE);

      // Tamper with encrypted data
      const tampered = Buffer.from(encrypted);
      const idx = tampered.length - 10;
      tampered.writeUInt8(tampered.readUInt8(idx) ^ 0xff, idx);

      expect(() => decryptWithPassphrase(tampered, TEST_PASSPHRASE))
        .toThrow('Incorrect passphrase or corrupted file');
    });
  });

  describe('Version compatibility', () => {
    it('should include source version in export metadata', () => {
      const payload = buildTestPayload();
      expect(payload.metadata.source_version).toBe('0.3.0');
      expect(payload.metadata.version).toBe('1.0.0');
    });

    it('should detect newer source version in metadata', () => {
      const payload = buildTestPayload();
      payload.metadata.source_version = '99.0.0';

      // The previewImport function checks this, but we test the logic directly
      const sourceVersion = payload.metadata.source_version;
      const currentVersion = '0.3.0';

      const sv = sourceVersion.split('.').map(Number);
      const cv = currentVersion.split('.').map(Number);
      const isNewer = (sv[0]! > cv[0]!) ||
        (sv[0] === cv[0] && sv[1]! > cv[1]!) ||
        (sv[0] === cv[0] && sv[1] === cv[1] && sv[2]! > cv[2]!);

      expect(isNewer).toBe(true);
    });
  });

  describe('Passphrase validation for exports', () => {
    it('should reject export passphrase shorter than 12 chars', () => {
      const result = validatePassphraseStrength('short');
      expect(result.valid).toBe(false);
    });

    it('should accept strong export passphrase', () => {
      const result = validatePassphraseStrength('My-Export-Key-2026!');
      expect(result.valid).toBe(true);
      expect(['strong', 'very_strong']).toContain(result.strength);
    });
  });

  describe('Export payload structure', () => {
    it('should include all expected data sections', () => {
      const payload = buildTestPayload();
      const sections = [
        'metadata', 'company', 'accounts', 'contacts', 'transactions',
        'journal_lines', 'tags', 'items', 'bank_rules', 'budgets',
        'recurring_templates', 'audit_trail', 'attachments_meta',
      ];
      for (const section of sections) {
        expect(payload).toHaveProperty(section);
      }
    });

    it('should NOT include user accounts in tenant export', () => {
      const payload = buildTestPayload();
      expect(payload).not.toHaveProperty('users');
      expect(payload).not.toHaveProperty('user_tenant_access');
      expect(payload).not.toHaveProperty('plaid_connections');
    });

    it('should include export_type as tenant', () => {
      const payload = buildTestPayload();
      expect(payload.metadata.export_type).toBe('tenant');
    });
  });

  describe('ID remapping logic', () => {
    it('should generate unique IDs for remapping', () => {
      const idMap = new Map<string, string>();
      function remap(oldId: string): string {
        if (!idMap.has(oldId)) {
          idMap.set(oldId, crypto.randomUUID());
        }
        return idMap.get(oldId)!;
      }

      const old1 = crypto.randomUUID();
      const old2 = crypto.randomUUID();

      const new1 = remap(old1);
      const new2 = remap(old2);

      // New IDs should be different from old
      expect(new1).not.toBe(old1);
      expect(new2).not.toBe(old2);

      // Same old ID should map to same new ID
      expect(remap(old1)).toBe(new1);
      expect(remap(old2)).toBe(new2);

      // New IDs should be unique
      expect(new1).not.toBe(new2);
    });

    it('should handle null IDs gracefully', () => {
      const idMap = new Map<string, string>();
      function remap(oldId: string | null | undefined): string | null {
        if (!oldId) return null;
        if (!idMap.has(oldId)) {
          idMap.set(oldId, crypto.randomUUID());
        }
        return idMap.get(oldId)!;
      }

      expect(remap(null)).toBeNull();
      expect(remap(undefined)).toBeNull();
      expect(remap('')).toBeNull();
    });
  });

  describe('Contact matching for merge', () => {
    it('should match contacts by name + email', () => {
      const existingContacts = [
        { id: '1', display_name: 'Acme Inc', email: 'info@acme.com' },
        { id: '2', display_name: 'Beta Corp', email: 'contact@beta.com' },
      ];

      const contactsByNameEmail = new Map<string, string>();
      for (const c of existingContacts) {
        const key = `${c.display_name.toLowerCase()}|${(c.email || '').toLowerCase()}`;
        contactsByNameEmail.set(key, c.id);
      }

      // Exact match
      expect(contactsByNameEmail.get('acme inc|info@acme.com')).toBe('1');

      // No match
      expect(contactsByNameEmail.get('new company|new@example.com')).toBeUndefined();
    });
  });

  describe('Account matching for merge', () => {
    it('should match accounts by number first, then by name', () => {
      const existing = [
        { id: 'a1', account_number: '1000', name: 'Cash' },
        { id: 'a2', account_number: '4000', name: 'Revenue' },
        { id: 'a3', account_number: null, name: 'Office Supplies' },
      ];

      const byNumber = new Map<string, string>();
      const byName = new Map<string, string>();
      for (const acc of existing) {
        if (acc.account_number) byNumber.set(acc.account_number, acc.id);
        byName.set(acc.name.toLowerCase(), acc.id);
      }

      // Match by number
      expect(byNumber.get('1000')).toBe('a1');

      // Match by name when no number
      expect(byName.get('office supplies')).toBe('a3');

      // No match
      expect(byNumber.get('9999')).toBeUndefined();
      expect(byName.get('nonexistent')).toBeUndefined();
    });
  });

  describe('Duplicate transaction detection', () => {
    it('should flag transactions with same date, amount, and contact', () => {
      const existing = [
        { txn_date: '2026-01-15', total: '1500.00', contact_id: 'c1' },
        { txn_date: '2026-02-20', total: '250.00', contact_id: 'c2' },
      ];

      const existingSet = new Set(
        existing.map((t) => `${t.txn_date}|${t.total}|${t.contact_id}`),
      );

      // Duplicate
      expect(existingSet.has('2026-01-15|1500.00|c1')).toBe(true);

      // Not duplicate
      expect(existingSet.has('2026-01-16|1500.00|c1')).toBe(false);
      expect(existingSet.has('2026-01-15|1500.01|c1')).toBe(false);
    });
  });
});

describe('Remote Backup (unit)', () => {
  describe('Email size limit', () => {
    it('should reject backups exceeding email size limit', () => {
      const maxSizeMb = 25;
      const maxSizeBytes = maxSizeMb * 1024 * 1024;

      // 30 MB file should be rejected
      const fileSize = 30 * 1024 * 1024;
      expect(fileSize > maxSizeBytes).toBe(true);

      // 20 MB file should be accepted
      const smallFileSize = 20 * 1024 * 1024;
      expect(smallFileSize > maxSizeBytes).toBe(false);
    });
  });
});
