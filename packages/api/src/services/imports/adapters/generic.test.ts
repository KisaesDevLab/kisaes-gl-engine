// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect } from 'vitest';
import * as generic from './generic.js';

const buf = (s: string) => Buffer.from(s, 'utf8');

describe('generic import adapter', () => {
  describe('parseCoa', () => {
    it('reads accounts and validates the type', async () => {
      const csv =
        'Account Number,Account Name,Account Type,Detail Type,Description,Parent Account Number\n' +
        '1000,Business Checking,asset,bank,Primary,\n' +
        '4000,Sales,income,,,\n'; // "income" synonym → revenue
      const { rows, errors } = await generic.parseCoa(buf(csv));
      expect(errors).toHaveLength(0);
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({ accountNumber: '1000', name: 'Business Checking', accountType: 'asset' });
      expect(rows[1]).toMatchObject({ name: 'Sales', accountType: 'revenue' });
    });

    it('errors on an unknown account type', async () => {
      const csv = 'Account Name,Account Type\nMystery,widget\n';
      const { rows, errors } = await generic.parseCoa(buf(csv));
      expect(rows).toHaveLength(0);
      expect(errors[0]?.code).toBe('IMPORT_UNKNOWN_TYPE');
    });
  });

  describe('parseContacts', () => {
    it('uses the per-row Type column', async () => {
      const csv = 'Display Name,Type,Email\nAcme,vendor,ap@acme.com\nJoe,customer,\n';
      const { rows, errors } = await generic.parseContacts(buf(csv));
      expect(errors).toHaveLength(0);
      expect(rows[0]).toMatchObject({ displayName: 'Acme', contactType: 'vendor', email: 'ap@acme.com' });
      expect(rows[1]).toMatchObject({ displayName: 'Joe', contactType: 'customer' });
    });

    it('falls back to the file-level kind when Type is blank', async () => {
      const csv = 'Display Name,Type\nNoType,\n';
      const { rows } = await generic.parseContacts(buf(csv), 'customer');
      expect(rows[0]).toMatchObject({ displayName: 'NoType', contactType: 'customer' });
    });
  });

  describe('parseTrialBalance', () => {
    it('reads debit/credit balances', async () => {
      const csv = 'Account Number,Account Name,Debit,Credit\n1000,Checking,5000.00,\n3000,Equity,,5000.00\n';
      const { rows } = await generic.parseTrialBalance(buf(csv));
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({ accountName: 'Checking', debit: '5000' });
      expect(rows[1]).toMatchObject({ accountName: 'Equity', credit: '5000' });
    });
  });

  describe('parseGl (single-row, signed amount)', () => {
    it('positive amount debits the Account and credits the Offset', async () => {
      const csv =
        'Date,Account,Amount,Offset Account,Description,Name,Reference,Tag\n' +
        '2026-07-01,Business Checking,1500.00,Sales,Deposit,JRS Cattle,DEP1,Joplin Store\n';
      const { entries, errors } = await generic.parseGl(buf(csv));
      expect(errors).toHaveLength(0);
      expect(entries).toHaveLength(1);
      const e = entries[0]!;
      expect(e.date).toBe('2026-07-01');
      expect(e.reference).toBe('DEP1');
      expect(e.name).toBe('JRS Cattle');
      // account line = debit; offset line = credit
      expect(e.lines[0]).toMatchObject({ accountName: 'Business Checking', debit: '1500.00', credit: '0', tagName: 'Joplin Store' });
      expect(e.lines[1]).toMatchObject({ accountName: 'Sales', debit: '0', credit: '1500.00', tagName: 'Joplin Store' });
    });

    it('negative amount credits the Account and debits the Offset', async () => {
      const csv =
        'Date,Account,Amount,Offset Account,Tag\n' +
        '07/03/2026,Business Checking,-250.00,Office Supplies,Overhead\n';
      const { entries } = await generic.parseGl(buf(csv));
      const e = entries[0]!;
      expect(e.date).toBe('2026-07-03'); // MM/DD/YYYY normalized
      expect(e.lines[0]).toMatchObject({ accountName: 'Business Checking', debit: '0', credit: '250.00', tagName: 'Overhead' });
      expect(e.lines[1]).toMatchObject({ accountName: 'Office Supplies', debit: '250.00', credit: '0', tagName: 'Overhead' });
    });

    it('accepts parenthesized negatives and resolves numeric accounts by number', async () => {
      const csv = 'Date,Account,Amount,Offset Account\n2026-07-05,1000,(75.00),6000\n';
      const { entries } = await generic.parseGl(buf(csv));
      const e = entries[0]!;
      expect(e.lines[0]).toMatchObject({ accountNumber: '1000', credit: '75.00' });
      expect(e.lines[1]).toMatchObject({ accountNumber: '6000', debit: '75.00' });
    });

    it('flags a bad date and a zero amount', async () => {
      const csv =
        'Date,Account,Amount,Offset Account\n' +
        'not-a-date,A,10,B\n' +
        '2026-07-01,A,0,B\n';
      const { entries, errors } = await generic.parseGl(buf(csv));
      expect(entries).toHaveLength(0);
      expect(errors.map((e) => e.code).sort()).toEqual(['IMPORT_BAD_AMOUNT', 'IMPORT_BAD_DATE']);
    });

    it('errors when the header row is missing', async () => {
      const { entries, errors } = await generic.parseGl(buf('foo,bar\n1,2\n'));
      expect(entries).toHaveLength(0);
      expect(errors[0]?.code).toBe('IMPORT_HEADER_NOT_FOUND');
    });
  });
});
