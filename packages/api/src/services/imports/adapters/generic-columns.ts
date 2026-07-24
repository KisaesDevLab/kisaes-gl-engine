// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Single source of truth for the Generic Excel import templates. Both the
// parser (generic.ts) and the sample-file generator (generic-templates.service.ts)
// consume these column definitions so the template a user downloads is always
// exactly what the parser expects.

export interface GenericColumn {
  /** Column header text as it appears in row 1 of the template. */
  header: string;
  required: boolean;
  /** Example value written into the sample file's demo row. */
  example: string;
  /** Optional guidance shown under the header in the sample's Instructions sheet. */
  note?: string;
}

export interface GenericTemplate {
  /** Worksheet name in the generated .xlsx. */
  sheetName: string;
  columns: GenericColumn[];
  /** Short human description shown on the Instructions sheet + upload screen. */
  description: string;
}

export const ACCOUNT_TYPE_VALUES = [
  'asset', 'liability', 'equity', 'revenue', 'cogs', 'expense', 'other_revenue', 'other_expense',
] as const;

export const GENERIC_COA_TEMPLATE: GenericTemplate = {
  sheetName: 'Chart of Accounts',
  description: 'One account per row. Account Name and Account Type are required.',
  columns: [
    { header: 'Account Number', required: false, example: '1000', note: 'Optional code; must be unique.' },
    { header: 'Account Name', required: true, example: 'Business Checking' },
    { header: 'Account Type', required: true, example: 'asset', note: `One of: ${ACCOUNT_TYPE_VALUES.join(', ')}` },
    { header: 'Detail Type', required: false, example: 'bank' },
    { header: 'Description', required: false, example: 'Primary operating account' },
    { header: 'Parent Account Number', required: false, example: '', note: 'Account Number of the parent, for sub-accounts.' },
  ],
};

export const GENERIC_CONTACTS_TEMPLATE: GenericTemplate = {
  sheetName: 'Contacts',
  description: 'One contact per row. Display Name and Type are required.',
  columns: [
    { header: 'Display Name', required: true, example: 'Joplin Regional Stockyards' },
    { header: 'Type', required: true, example: 'customer', note: 'customer or vendor' },
    { header: 'Email', required: false, example: 'ap@joplinstockyards.com' },
    { header: 'Phone', required: false, example: '417-555-0134' },
    { header: 'Company Name', required: false, example: 'Joplin Regional Stockyards LLC' },
    { header: 'Billing Address', required: false, example: '123 Main St, Joplin, MO 64801' },
    { header: 'Default Expense Account', required: false, example: '', note: 'Vendors only: account name or number to categorize their bills.' },
  ],
};

export const GENERIC_TB_TEMPLATE: GenericTemplate = {
  sheetName: 'Trial Balance',
  description: 'One account balance per row. Debits must equal credits. Import the Chart of Accounts first — every account must already exist.',
  columns: [
    { header: 'Account Number', required: false, example: '1000', note: 'Account Number or Account Name is required.' },
    { header: 'Account Name', required: false, example: 'Business Checking' },
    { header: 'Debit', required: false, example: '5000.00' },
    { header: 'Credit', required: false, example: '', note: 'Put the balance in Debit OR Credit, not both.' },
  ],
};

export const GENERIC_TXN_TEMPLATE: GenericTemplate = {
  sheetName: 'Transactions',
  description:
    'One transaction per row. A positive Amount DEBITS the Account and credits the Offset Account; a negative Amount CREDITS the Account (as its positive value) and debits the Offset Account. Both accounts must already exist. Tags are created automatically if new.',
  columns: [
    { header: 'Date', required: true, example: '2026-07-01', note: 'YYYY-MM-DD or MM/DD/YYYY.' },
    { header: 'Account', required: true, example: 'Business Checking', note: 'Account name or number the amount applies to.' },
    { header: 'Amount', required: true, example: '-250.00', note: 'Positive = debit Account; negative = credit Account.' },
    { header: 'Offset Account', required: true, example: 'Office Supplies', note: 'The balancing account (name or number).' },
    { header: 'Description', required: false, example: 'Staples — printer paper' },
    { header: 'Name', required: false, example: 'Staples', note: 'Payee/customer; matched to an existing contact if found.' },
    { header: 'Reference', required: false, example: '1042', note: 'Check number or reference.' },
    { header: 'Tag', required: false, example: 'Joplin Store', note: 'Created automatically if it does not exist.' },
  ],
};

export const GENERIC_TEMPLATES: Record<'coa' | 'contacts' | 'trial_balance' | 'gl_transactions', GenericTemplate> = {
  coa: GENERIC_COA_TEMPLATE,
  contacts: GENERIC_CONTACTS_TEMPLATE,
  trial_balance: GENERIC_TB_TEMPLATE,
  gl_transactions: GENERIC_TXN_TEMPLATE,
};
