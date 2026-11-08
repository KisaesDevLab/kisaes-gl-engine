// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// cleanBankDescription: the noise it strips (prefixes, phone numbers, zip
// codes, reference codes, URLs, entity suffixes, merchant map) and U-176:
// no cut that leaves only banking words, a check keeps its number, Unicode
// title case.

import { describe, it, expect } from 'vitest';
import { cleanBankDescription as clean } from './bank-name-cleaner.js';

describe('cleanBankDescription', () => {
  it.each([
    ['COMCAST PAYMENT 123456', 'Comcast'],
    ['VERIZON WIRELESS PAYMENT', 'Verizon'],
    ['POS PURCHASE STARBUCKS #12345 SEATTLE WA', 'Starbucks'],
    ['AMZN MKTP US*2K3L45', 'Amazon'],
    ['SQ *BLUE BOTTLE COFFEE', 'Blue Bottle Coffee'],
    ['ACH DEBIT GUSTO PAYROLL 800-555-1234', 'Gusto Payroll'],
    ['NETFLIX.COM 866-579-7172 CA', 'Netflix'],
    ['TST* JOES DINER 98101', 'Joes Diner'],
    ['DEPOSIT', 'Deposit'],
    ['DEPOSIT 12345', 'Deposit'],
    ['ATM WITHDRAWAL 4455', 'ATM Withdrawal'],
    ['MOBILE DEPOSIT', 'Mobile Deposit'],
    ['INTEREST PAYMENT', 'Interest'],
    ['TRANSFER 99887766', 'Transfer'],
    ['Clean Vendor Inc', 'Clean Vendor'],
    ['HOME DEPOT 4521 04/03', 'Home Depot'],
    ['APPSUMO.COM APPSUMO.C', 'AppSumo'],
    ['TAXSPEAKER TAXSPEAKE', 'TaxSpeaker'],
    ['WIRE TRANSFER ACME CORP', 'Acme'],
    ['ACME SUPPLY CREDIT', 'Acme Supply'],
    ['PAYPAL *EBAY', 'PayPal'],
    ['SHELL OIL 57444', 'Shell Oil'],
    ["MCDONALD'S F1234", "McDonald's"],
    ['IRS USATAXPYMT', 'IRS Usataxpymt'],
    ['CHASE CREDIT CRD AUTOPAY', 'Chase'],
  ])('strips noise: %s → %s', (raw, want) => {
    expect(clean(raw)).toBe(want);
  });

  it.each([
    ['ONLINE TRANSFER TO CARD', 'Online Transfer To Card'],
    ['ONLINE TRANSFER FROM SAVINGS 1234', 'Online Transfer From Savings'],
    ['CREDIT CARD PAYMENT', 'Credit Card Payment'],
    ['ONLINE PAYMENT THANK YOU', 'Online Payment Thank You'],
    ['ONLINE TRANSFER ACME PAYMENT 123456', 'Online Transfer Acme'],
  ])('U-176: never cuts down to banking words only: %s → %s', (raw, want) => {
    expect(clean(raw)).toBe(want);
  });

  it.each([
    ['CHECK 1005', 'Check 1005'],
    ['CHECK #1005', 'Check #1005'],
    ['CHK 1005', 'Chk 1005'],
    ['CHECK 100523', 'Check 100523'],
  ])('U-176: a check keeps its number: %s → %s', (raw, want) => {
    expect(clean(raw)).toBe(want);
  });

  it.each([
    ['CAFÉ LUMIÈRE', 'Café Lumière'],
    ['CAFÉ LUMIÈRE 4521', 'Café Lumière'],
    ['ÉCOLE NATIONALE', 'École Nationale'],
    ['ÜBER EATS', 'Über Eats'],
    ['STRAßE CAFE', 'Straße Cafe'],
    ["JOE'S PIZZA", "Joe's Pizza"],
    ["O'REILLY AUTO PARTS", "O'Reilly Auto Parts"],
    ['T-MOBILE STORE', 'T-Mobile'],
    ['ABC LLC', 'Abc'],
  ])('U-176: Unicode title case: %s → %s', (raw, want) => {
    expect(clean(raw)).toBe(want);
  });

  it('keeps the raw text when nothing is left', () => {
    expect(clean('')).toBe('');
    expect(clean('   ')).toBe('');
    expect(clean('#1234')).toBe('#1234');
  });
});
