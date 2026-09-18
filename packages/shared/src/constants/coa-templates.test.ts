// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, expect, it } from 'vitest';
import { BUSINESS_TEMPLATES } from './coa-templates.js';

const ACCOUNT_TYPES = ['asset', 'liability', 'equity', 'revenue', 'cogs', 'expense', 'other_revenue', 'other_expense'];
const SYSTEM_TAGS = ['cash_on_hand', 'payments_clearing', 'accounts_receivable', 'accounts_payable',
  'sales_tax_payable', 'opening_balances', 'retained_earnings'];
// Hidden, non-business template — exempt from the business-chart checks.
const NON_BUSINESS = new Set(['personal_activities']);
// Industry accounts that were once cloned into every template.
const LEAK_HOME: Record<string, string[]> = {
  'Hair Products & Supplies': ['hairstylist_and_barbers'],
  'Passenger Supplies': ['ride_sharing_driver'],
  'Vet/Breeding/Medicine': ['farm_crops_and_animals'],
  'Seeds & Plants': ['farm_crops_and_animals'],
};

describe('BUSINESS_TEMPLATES', () => {
  for (const [slug, rows] of Object.entries(BUSINESS_TEMPLATES)) {
    describe(slug, () => {
      it('has unique account numbers and names', () => {
        expect(new Set(rows.map((a) => a.accountNumber)).size).toBe(rows.length);
        expect(new Set(rows.map((a) => a.name)).size).toBe(rows.length);
      });

      it('uses known account types', () => {
        for (const a of rows) expect(ACCOUNT_TYPES, `${a.accountNumber} ${a.name}`).toContain(a.accountType);
      });

      it('keeps the system-tagged accounts', () => {
        const tags = rows.filter((a) => a.isSystem).map((a) => a.systemTag);
        for (const t of SYSTEM_TAGS) expect(tags).toContain(t);
      });

      it('has no leaked industry accounts', () => {
        for (const [name, homes] of Object.entries(LEAK_HOME)) {
          if (!homes.includes(slug)) expect(rows.map((a) => a.name)).not.toContain(name);
        }
        expect(rows.map((a) => a.name)).not.toContain('Revenues, Cash & Check');
        expect(rows.map((a) => a.name)).not.toContain('Revenues, Credit Card');
      });

      if (NON_BUSINESS.has(slug)) return;

      it('has depreciation, a bank-fee account, revenue, and Uncategorized', () => {
        expect(rows.some((a) => a.detailType === 'depreciation')).toBe(true);
        expect(rows.some((a) => a.accountType === 'expense' && /bank/i.test(a.name))).toBe(true);
        expect(rows.some((a) => a.accountType === 'revenue')).toBe(true);
        expect(rows.find((a) => a.accountNumber === '89999')?.name).toBe('Uncategorized');
      });
    });
  }

  it('farm covers the Schedule F expense lines', () => {
    const names = BUSINESS_TEMPLATES['farm_crops_and_animals']!.map((a) => a.name);
    for (const n of ['Seeds & Plants', 'Vet/Breeding/Medicine', 'Supplies', 'Storage & Warehousing',
      'Feed & Mineral', 'Fertilizer & Lime', 'Chemicals', 'Custom Hire', 'Conservation Expenses',
      'Depreciation Expense', 'Pension/Retirement', 'Other Benefits', 'Wages, Payroll', 'Land Rent']) {
      expect(names).toContain(n);
    }
  });
});
