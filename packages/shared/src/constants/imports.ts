// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

// Source-system mapping tables for the bulk-import pipeline. Adapters
// reference these to translate vendor-specific labels into the
// canonical row shapes the validate/commit pipeline expects.

import type { AccountType } from '../types/accounts.js';

/**
 * Accounting Power CoA Type column → MyBooks accountType enum.
 * Single-letter codes per US GAAP convention. Unknown letters surface
 * as IMPORT_UNKNOWN_TYPE validation errors at upload time.
 */
export const AP_TYPE_LETTER_MAP: Record<string, AccountType> = {
  A: 'asset',
  L: 'liability',
  E: 'equity',
  I: 'revenue',         // Income
  R: 'revenue',         // Some AP exports use R
  X: 'expense',
  C: 'cogs',
};

/**
 * QuickBooks Online CoA Type column → MyBooks accountType enum.
 *
 * QBO uses verbose Type-text labels rather than letters. This list is
 * derived from QBO's account-type taxonomy plus what we've seen in
 * real exports. Match is case-insensitive and trims trailing/leading
 * whitespace; unknown values surface as IMPORT_UNKNOWN_TYPE.
 *
 * Fixed-asset types collapse to 'asset' rather than a missing
 * 'fixed_asset' enum value — MyBooks doesn't currently distinguish.
 */
export const QBO_TYPE_TEXT_MAP: Record<string, AccountType> = {
  // Assets
  'bank': 'asset',
  'accounts receivable (a/r)': 'asset',
  'accounts receivable': 'asset',
  'other current assets': 'asset',
  'inventory': 'asset',
  'fixed assets': 'asset',
  'other assets': 'asset',
  'fixed asset': 'asset',
  'other asset': 'asset',
  'cash and cash equivalents': 'asset',

  // Liabilities
  'accounts payable (a/p)': 'liability',
  'accounts payable': 'liability',
  'credit card': 'liability',
  'other current liabilities': 'liability',
  'long term liabilities': 'liability',
  'long-term liabilities': 'liability',

  // Equity
  'equity': 'equity',

  // Income
  'income': 'revenue',
  'other income': 'other_revenue',

  // COGS
  'cost of goods sold': 'cogs',
  'cogs': 'cogs',

  // Expense
  'expenses': 'expense',
  'expense': 'expense',
  'other expense': 'other_expense',
};

/**
 * QBO Transaction Type → memo prefix label. The full label survives in
 * the memo (e.g. `[QBO:Check] …`) so the original transaction shape
 * isn't lost when everything is imported as txnType='journal_entry'.
 */
export const QBO_TXN_TYPE_LABELS: Record<string, string> = {
  'check': 'QBO:Check',
  'deposit': 'QBO:Deposit',
  'expense': 'QBO:Expense',
  'bill': 'QBO:Bill',
  'bill payment': 'QBO:Bill Payment',
  'invoice': 'QBO:Invoice',
  'sales receipt': 'QBO:Sales Receipt',
  'payment': 'QBO:Payment',
  'credit memo': 'QBO:Credit Memo',
  'journal entry': 'QBO:Journal Entry',
  'transfer': 'QBO:Transfer',
};

/**
 * Accounting Power Journal column codes → memo prefix label.
 */
export const AP_JOURNAL_LABELS: Record<string, string> = {
  CD: 'AP:CD', // Cash Disbursement
  CR: 'AP:CR', // Cash Receipt
  GJ: 'AP:GJ', // General Journal
  AP: 'AP:AP', // Accounts Payable
  AR: 'AP:AR', // Accounts Receivable
  PR: 'AP:PR', // Payroll
};

/** transactions.source values written by this importer. */
export const IMPORT_SOURCE_TAGS = {
  AP_GL: 'accounting_power_import',
  QBO_GL: 'quickbooks_online_import',
  TRIAL_BALANCE: 'trial_balance_import',
} as const;

/** AP TB CSV header signature — lets the parser fail fast on a wrong file. */
export const AP_TB_HEADER_REQUIRED = [
  'Account Code',
  'Type',
  'Description',
  'Beginning Balance',
  'Adjusted Balance',
] as const;

/** AP CoA CSV header signature. */
export const AP_COA_HEADER_REQUIRED = [
  'Account',
  'Description',
  'Type',
  'Class',
  'Category',
  'SubAccount Of',
] as const;

/** AP GL CSV header signature. */
export const AP_GL_HEADER_REQUIRED = [
  'Journal',
  'Date',
  'Reference',
  'Description',
  'Account',
  'Debit Amount',
  'Credit Amount',
] as const;
