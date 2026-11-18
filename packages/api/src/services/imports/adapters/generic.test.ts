// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

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
      // U-260: canonical exact text (was String(Number(x)) = '5000').
      expect(rows[0]).toMatchObject({ accountName: 'Checking', debit: '5000.00' });
      expect(rows[1]).toMatchObject({ accountName: 'Equity', credit: '5000.00' });
    });

    it('keeps every place and accepts accounting forms; a bad cell is IMPORT_AMOUNT_INVALID (U-260)', async () => {
      const csv = 'Account Name,Debit,Credit\n'
        + 'Checking,"$1,234,567,890.1234",\n'
        + 'Loan,,(0.0001)\n'
        + 'Equity,,"1,234,567,890.1235"\n'
        + 'Bad,1e3,\n'
        + 'Comma,,"1.234,56"\n';
      const { rows, errors } = await generic.parseTrialBalance(buf(csv));
      expect(rows.map((r) => [r.accountName, r.debit, r.credit])).toEqual([
        ['Checking', '1234567890.1234', undefined],
        ['Loan', undefined, '-0.0001'],
        ['Equity', undefined, '1234567890.1235'],
      ]);
      expect(errors.map((e) => [e.rowNumber, e.field, e.code])).toEqual([
        [5, 'Debit', 'IMPORT_AMOUNT_INVALID'],
        [6, 'Credit', 'IMPORT_AMOUNT_INVALID'],
      ]);
    });

    it('xlsx: number cells are read as their raw value, not the 15-digit display', async () => {
      const ExcelJS = (await import('exceljs')).default;
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('TB');
      ws.addRow(['Account Name', 'Debit', 'Credit']);
      ws.addRow(['Checking', 123456789012.34, null]);
      ws.addRow(['Equity', null, 0.1 + 0.2]);
      ws.getCell('B2').numFmt = '#,##0';
      const { rows, errors } = await generic.parseTrialBalance(Buffer.from(await wb.xlsx.writeBuffer()));
      expect(rows).toEqual([expect.objectContaining({ accountName: 'Checking', debit: '123456789012.34' })]);
      // 0.30000000000000004 is refused, not rounded to 0.3.
      expect(errors).toEqual([expect.objectContaining({ rowNumber: 3, field: 'Credit', code: 'IMPORT_AMOUNT_INVALID' })]);
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

    it('signed Amount: CR/DR, U+2212, trailing minus and 4 places, exactly (U-260)', async () => {
      const csv =
        'Date,Account,Amount,Offset Account\n' +
        '2026-07-01,Checking,"1,234.5678 CR",Sales\n' +
        '2026-07-02,Checking,50.10 DR,Sales\n' +
        '2026-07-03,Checking,−12.5,Sales\n' +
        '2026-07-04,Checking,7-,Sales\n' +
        '2026-07-05,Checking,1.23456,Sales\n' +
        '2026-07-06,Checking,-(5),Sales\n';
      const { entries, errors } = await generic.parseGl(buf(csv));
      expect(entries.map((e) => [e.lines[0]!.debit, e.lines[0]!.credit])).toEqual([
        ['0', '1234.5678'], ['50.10', '0'], ['0', '12.50'], ['0', '7.00'],
      ]);
      expect(errors.map((e) => [e.rowNumber, e.code])).toEqual([[6, 'IMPORT_AMOUNT_INVALID'], [7, 'IMPORT_AMOUNT_INVALID']]);
    });

    it('errors when the header row is missing', async () => {
      const { entries, errors } = await generic.parseGl(buf('foo,bar\n1,2\n'));
      expect(entries).toHaveLength(0);
      expect(errors[0]?.code).toBe('IMPORT_HEADER_NOT_FOUND');
    });
  });
});
