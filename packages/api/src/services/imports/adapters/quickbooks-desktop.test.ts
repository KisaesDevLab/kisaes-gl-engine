// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect } from 'vitest';
import * as qbd from './quickbooks-desktop.js';

// QB Desktop exports are ISO-8859-1 with a MIDDLE DOT (0xB7 / U+00B7)
// account separator. Build fixture buffers the same way — encode the
// string as latin1 so U+00B7 lands as a single 0xB7 byte, exactly like a
// real export. Using the default utf8 encoding would emit 0xC2 0xB7 and
// the middle-dot split would (correctly) not match.
const DOT = '·'; // ·
function buf(text: string): Buffer {
  return Buffer.from(text, 'latin1');
}

describe('QuickBooks Desktop adapter', () => {
  describe('splitQbdAccount', () => {
    it('splits "<number> · <name>" into number + name', () => {
      expect(qbd.splitQbdAccount(`12000 ${DOT} Cash Operating Account Freedom`)).toEqual({
        accountNumber: '12000',
        accountName: 'Cash Operating Account Freedom',
      });
    });
    it('handles a name-only cell', () => {
      expect(qbd.splitQbdAccount('Cash Operating')).toEqual({ accountName: 'Cash Operating' });
    });
    it('handles a number-only cell', () => {
      expect(qbd.splitQbdAccount('12000')).toEqual({ accountNumber: '12000' });
    });
    it('tolerates the UTF-8 replacement char if the file was mis-decoded', () => {
      expect(qbd.splitQbdAccount('50000 � Cost of Sales')).toEqual({
        accountNumber: '50000',
        accountName: 'Cost of Sales',
      });
    });
  });

  describe('parseCoa', () => {
    const csv =
      `,"Account","Type","Balance Total","Description","Accnt. #","Tax Line"\r\n` +
      `,"11000 ${DOT} CASH Operating Account Commerce","Bank",0.00,,"11000","<Unassigned>"\r\n` +
      `,"12200 ${DOT} Intercompany Transfer","Other Current Asset",-2500.00,,"12200","<Unassigned>"\r\n` +
      `,"26100 ${DOT} Credit Card- Chase","Credit Card",0.00,,"26100","<Unassigned>"\r\n` +
      `,"39000 ${DOT} Retained Earnings","Equity","","Undistributed earnings","39000","<Unassigned>"\r\n` +
      `,"41000 ${DOT} Sales/Revenues","Income","","Sales/Revenues","41000","<Unassigned>"\r\n` +
      `,"50000 ${DOT} Cost of Sales/Revenue","Cost of Goods Sold","","Cost of Sales","50000","<Unassigned>"\r\n` +
      `,"60100 ${DOT} Advertising Expense","Expense","","Advertising Expense","60100","<Unassigned>"\r\n` +
      `,"86000 ${DOT} Interest Income","Other Income","","Interest Income","86000","<Unassigned>"\r\n` +
      `,"96000 ${DOT} Interest Expense","Other Expense","","Interest Expense","96000","<Unassigned>"\r\n`;

    it('parses number, name, and maps QB Desktop types', () => {
      const { rows, errors } = qbd.parseCoa(buf(csv));
      expect(errors).toEqual([]);
      expect(rows).toHaveLength(9);
      const byNum = Object.fromEntries(rows.map((r) => [r.accountNumber, r]));
      expect(byNum['11000']).toMatchObject({ name: 'CASH Operating Account Commerce', accountType: 'asset' });
      expect(byNum['12200']!.accountType).toBe('asset');
      expect(byNum['26100']!.accountType).toBe('liability');
      expect(byNum['39000']!.accountType).toBe('equity');
      expect(byNum['41000']!.accountType).toBe('revenue');
      expect(byNum['50000']!.accountType).toBe('cogs');
      expect(byNum['60100']!.accountType).toBe('expense');
      expect(byNum['86000']!.accountType).toBe('other_revenue');
      expect(byNum['96000']!.accountType).toBe('other_expense');
    });

    it('flags an unknown account type', () => {
      const bad = `,"Account","Type","Accnt. #"\r\n,"99000 ${DOT} Mystery","Wormhole","99000"\r\n`;
      const { rows, errors } = qbd.parseCoa(buf(bad));
      expect(rows).toHaveLength(0);
      expect(errors[0]!.code).toBe('IMPORT_UNKNOWN_TYPE');
    });
  });

  describe('parseContacts', () => {
    const csv =
      `,"Active Status","Vendor","Balance","Company","Main Phone","Bill from 1"\r\n` +
      `,"Active","Baisch & Skinner",0.00,,"417-555-1000","Baisch & Skinner"\r\n` +
      `,"Active","Café Beausoleil",0.00,,,"Café Beausoleil"\r\n` +
      `,"Inactive","Old Vendor",0.00,,,"Old Vendor"\r\n`;

    it('reads vendor names, skips inactive, preserves accented latin1 names', () => {
      const { rows, errors } = qbd.parseContacts(buf(csv), 'vendor');
      expect(errors).toEqual([]);
      expect(rows.map((r) => r.displayName)).toEqual(['Baisch & Skinner', 'Café Beausoleil']);
      expect(rows[0]).toMatchObject({ contactType: 'vendor', phone: '417-555-1000' });
    });
  });

  describe('parseTrialBalance', () => {
    const csv =
      `,"Dec 31, 25"\r\n` +
      `,"Debit","Credit"\r\n` +
      `"11000 ${DOT} CASH Operating Account Commerce",0.00,""\r\n` +
      `"12000 ${DOT} Cash Operating Account Freedom",4667.87,""\r\n` +
      `"12200 ${DOT} Intercompany Transfer","",2500.00\r\n` +
      `"41000 ${DOT} Sales/Revenues","",134627.37\r\n` +
      `"TOTAL",252731.68,252731.68\r\n`;

    it('scrapes the "As of" date, splits accounts, drops zero + TOTAL rows', () => {
      const { rows, errors, reportDate } = qbd.parseTrialBalance(buf(csv));
      expect(errors).toEqual([]);
      expect(reportDate).toBe('2025-12-31');
      // 11000 is zero → dropped; TOTAL → dropped; 3 real rows remain.
      expect(rows).toHaveLength(3);
      expect(rows[0]).toMatchObject({ accountNumber: '12000', accountName: 'Cash Operating Account Freedom', debit: '4667.87' });
      expect(rows[1]).toMatchObject({ accountNumber: '12200', credit: '2500.00' });
      expect(rows[1]!.debit).toBeUndefined();
    });
  });

  describe('parseGl', () => {
    // Two transactions: a Check (credit cash / debit expense) and a
    // Deposit (debit cash / credit revenue), each followed by a subtotal
    // row, then a grand TOTAL row.
    const csv =
      `"Trans #","Type","Date","Num","Adj","Name","Memo","Account","Debit","Credit"\r\n` +
      `"4650","Check","01/01/2025","2450",,"Betty's Flowers",,"12000 ${DOT} Cash Operating Account Freedom","",623.95\r\n` +
      `,,,,,"Betty's Flowers",,"50000 ${DOT} Cost of Sales/Revenue",623.95,""\r\n` +
      `,,,,,,,,623.95,623.95\r\n` +
      `"4720","Deposit","01/31/2025",,,,"Deposit","12000 ${DOT} Cash Operating Account Freedom",9514.23,""\r\n` +
      `,,,,,,"Deposit","41000 ${DOT} Sales/Revenues","",9514.23\r\n` +
      `,,,,,,,,9514.23,9514.23\r\n` +
      `"TOTAL",,,,,,,,10138.18,10138.18\r\n`;

    it('groups multi-row transactions, maps type, splits accounts, drops subtotals + TOTAL', () => {
      const { entries, errors } = qbd.parseGl(buf(csv));
      expect(errors).toEqual([]);
      expect(entries).toHaveLength(2);

      const check = entries[0]!;
      expect(check).toMatchObject({
        date: '2025-01-01',
        reference: '2450',
        transactionType: 'Check',
        sourceCode: 'QBD:Check',
        name: "Betty's Flowers",
      });
      expect(check.lines).toHaveLength(2);
      expect(check.lines[0]).toMatchObject({ accountNumber: '12000', credit: '623.95', debit: '0' });
      expect(check.lines[1]).toMatchObject({ accountNumber: '50000', debit: '623.95', credit: '0' });

      const deposit = entries[1]!;
      expect(deposit).toMatchObject({ date: '2025-01-31', transactionType: 'Deposit', sourceCode: 'QBD:Deposit' });
      expect(deposit.lines[0]).toMatchObject({ accountNumber: '12000', debit: '9514.23' });
      expect(deposit.lines[1]).toMatchObject({ accountNumber: '41000', credit: '9514.23' });
    });

    it('every emitted entry balances', () => {
      const { entries } = qbd.parseGl(buf(csv));
      for (const e of entries) {
        const d = e.lines.reduce((s, l) => s + Number(l.debit), 0);
        const c = e.lines.reduce((s, l) => s + Number(l.credit), 0);
        expect(d).toBeCloseTo(c, 2);
      }
    });

    it('carries a continuation-row memo onto the entry', () => {
      const withMemo =
        `"Trans #","Type","Date","Num","Adj","Name","Memo","Account","Debit","Credit"\r\n` +
        `"4846","Check","05/12/2025",,,"Transfer","April & May","12000 ${DOT} Cash Operating Account Freedom","",1600.00\r\n` +
        `,,,,,"Transfer","April & May","72000 ${DOT} Rent",1600.00,""\r\n` +
        `,,,,,,,,1600.00,1600.00\r\n`;
      const { entries } = qbd.parseGl(buf(withMemo));
      expect(entries[0]!.memo).toBe('April & May');
    });
  });
});
