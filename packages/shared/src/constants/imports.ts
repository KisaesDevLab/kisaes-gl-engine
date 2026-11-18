// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

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
  // Accounting Power exports use E for EXPENSE (not equity) and Q for
  // equity. E was previously mapped to 'equity', silently flipping every
  // expense account onto the balance sheet.
  Q: 'equity',
  E: 'expense',
  I: 'revenue',         // Income
  R: 'revenue',         // Some AP exports use R
  X: 'expense',         // Older AP exports
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
 * QuickBooks Desktop account-list Type column → MyBooks accountType enum.
 *
 * QB Desktop uses singular type labels ("Other Current Asset") where QBO
 * uses plural ("Other current assets"), so it gets its own map rather than
 * reusing QBO_TYPE_TEXT_MAP. Match is case-insensitive; unknown values
 * surface as IMPORT_UNKNOWN_TYPE. Fixed assets collapse to 'asset'
 * (MyBooks has no distinct fixed-asset enum).
 */
export const QBD_TYPE_TEXT_MAP: Record<string, AccountType> = {
  // Assets
  'bank': 'asset',
  'accounts receivable': 'asset',
  'other current asset': 'asset',
  'other current assets': 'asset',
  'fixed asset': 'asset',
  'other asset': 'asset',
  'inventory': 'asset',

  // Liabilities
  'accounts payable': 'liability',
  'credit card': 'liability',
  'other current liability': 'liability',
  'other current liabilities': 'liability',
  'long term liability': 'liability',
  'long-term liability': 'liability',

  // Equity
  'equity': 'equity',

  // Income
  'income': 'revenue',
  'other income': 'other_revenue',

  // COGS
  'cost of goods sold': 'cogs',

  // Expense
  'expense': 'expense',
  'other expense': 'other_expense',
};

/**
 * QB Desktop Journal "Type" column → memo prefix label. The full label
 * survives in the memo (e.g. `[QBD:Check] …`) so the original transaction
 * shape isn't lost when everything imports as txnType='journal_entry'.
 */
export const QBD_TXN_TYPE_LABELS: Record<string, string> = {
  'check': 'QBD:Check',
  'deposit': 'QBD:Deposit',
  'bill': 'QBD:Bill',
  'bill pmt -check': 'QBD:Bill Payment',
  'bill pmt -cc': 'QBD:Bill Payment',
  'invoice': 'QBD:Invoice',
  'payment': 'QBD:Payment',
  'sales receipt': 'QBD:Sales Receipt',
  'credit memo': 'QBD:Credit Memo',
  'credit card charge': 'QBD:Credit Card Charge',
  'credit card credit': 'QBD:Credit Card Credit',
  'general journal': 'QBD:General Journal',
  'transfer': 'QBD:Transfer',
  'paycheck': 'QBD:Paycheck',
  'liability check': 'QBD:Liability Check',
  'sales tax payment': 'QBD:Sales Tax Payment',
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

/**
 * Open-item report Type column → the sign the row must carry (U-264).
 * 'charge' rows are positive (invoice / bill), 'credit' rows negative (credit
 * memo / vendor credit), 'either' rows follow their sign. A Type not listed
 * is a row error (IMPORT_UNKNOWN_TYPE). Keys are lowercased; QuickBooks
 * Desktop, QuickBooks Online and the Generic template labels.
 */
export const OPEN_INVOICE_TYPE_MAP: Record<string, 'charge' | 'credit' | 'either'> = {
  'invoice': 'charge',
  'statement charge': 'charge',
  'stmt charge': 'charge',
  'credit memo': 'credit',
  // An unapplied customer payment: a credit memo, never a customer payment (P31 spike C9).
  'payment': 'credit',
  'general journal': 'either',
  'journal entry': 'either',
  'check': 'either',
};

export const UNPAID_BILL_TYPE_MAP: Record<string, 'charge' | 'credit' | 'either'> = {
  'bill': 'charge',
  'item receipt': 'charge',
  'credit': 'credit',
  'bill credit': 'credit',
  'vendor credit': 'credit',
  // An unapplied bill payment: a vendor credit.
  'bill pmt -check': 'credit',
  'bill pmt -cc': 'credit',
  'bill pmt -ccard': 'credit',
  'bill payment (check)': 'credit',
  'bill payment (credit card)': 'credit',
  'general journal': 'either',
  'journal entry': 'either',
  'check': 'either',
};

/**
 * Item list Type column -> engine item kind (U-265), lowercased; QuickBooks
 * Desktop Item Listing, QuickBooks Online Products and Services and the Generic
 * template labels. A `skip:` entry is listed in the preview but not imported
 * (the engine keeps sales tax in its own lists; groups and payment items have
 * no engine kind). A Type not listed is a row error (IMPORT_UNKNOWN_TYPE).
 */
export const ITEM_TYPE_MAP: Record<string, 'service' | 'non_inventory' | 'other_charge' | 'discount' | 'subtotal' | 'inventory_part'
  | 'skip:sales_tax' | 'skip:group' | 'skip:payment'> = {
  'service': 'service',
  'inventory part': 'inventory_part',
  'inventory assembly': 'inventory_part',
  'inventory': 'inventory_part',
  'inventory_part': 'inventory_part',
  'non-inventory part': 'non_inventory',
  'non-inventory': 'non_inventory',
  'noninventory': 'non_inventory',
  'non_inventory': 'non_inventory',
  'other charge': 'other_charge',
  'other_charge': 'other_charge',
  'discount': 'discount',
  'subtotal': 'subtotal',
  'sales tax item': 'skip:sales_tax',
  'sales tax group': 'skip:sales_tax',
  'group': 'skip:group',
  'bundle': 'skip:group',
  'payment': 'skip:payment',
};

/**
 * QB Desktop Journal Types whose Name and Memo carry an employee's name
 * (Q-P31m): both are dropped at parse time, so the name is never stored.
 */
export const QBD_PAYCHECK_TYPES: ReadonlySet<string> = new Set(['paycheck', 'payroll check', 'payroll adjustment']);

/** transactions.source values written by this importer. */
export const IMPORT_SOURCE_TAGS = {
  AP_GL: 'accounting_power_import',
  QBO_GL: 'quickbooks_online_import',
  QBD_GL: 'quickbooks_desktop_import',
  GENERIC_GL: 'generic_import',
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

/**
 * Account-list Type text that marks an A/R or A/P account (U-264), lowercased,
 * QuickBooks Desktop and Online labels.
 */
export const SOURCE_SYSTEM_ROLE_TYPES: Record<string, 'accounts_receivable' | 'accounts_payable'> = {
  'accounts receivable': 'accounts_receivable',
  'accounts receivable (a/r)': 'accounts_receivable',
  'accounts payable': 'accounts_payable',
  'accounts payable (a/p)': 'accounts_payable',
};

/**
 * U-272: a source chart row that is QuickBooks' own Retained Earnings account.
 * QuickBooks Desktop lists it with the plain Type "Equity", so the rule is the
 * equity type AND the name QuickBooks gives it ("Retained Earnings", number
 * stripped); QuickBooks Online marks it by Detail type "Retained Earnings"
 * (any name). A renamed QBD account is not detected (map it with accountMap).
 */
export function sourceRetainedEarnings(
  accountType: string,
  name: string,
  detailTypeText?: string,
): 'retained_earnings' | undefined {
  if (accountType !== 'equity') return undefined;
  if ((detailTypeText ?? '').trim().toLowerCase() === 'retained earnings') return 'retained_earnings';
  return name.trim().replace(/\s+/g, ' ').toLowerCase() === 'retained earnings' ? 'retained_earnings' : undefined;
}

/** QB Desktop Account List CSV header signature. */
export const QBD_COA_HEADER_REQUIRED = ['Account', 'Type'] as const;

/** QB Desktop Journal CSV header signature. */
export const QBD_GL_HEADER_REQUIRED = ['Trans #', 'Type', 'Date', 'Account'] as const;
