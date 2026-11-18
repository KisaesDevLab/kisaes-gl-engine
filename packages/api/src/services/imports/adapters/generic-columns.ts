// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

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

/** U-264: open items (read by adapters/open-items.ts, which also takes the QuickBooks column names). */
function openItemsTemplate(kind: 'open_invoices' | 'unpaid_bills'): GenericTemplate {
  const ar = kind === 'open_invoices';
  return {
    sheetName: ar ? 'Open Invoices' : 'Unpaid Bills',
    description: ar
      ? 'One unpaid invoice, credit memo or unapplied payment per row, as of one date. Each becomes an open invoice (positive Open Balance) or credit memo (negative).'
      : 'One unpaid bill or vendor credit per row, as of one date. Each becomes an open bill (positive Open Balance) or vendor credit (negative).',
    columns: [
      { header: 'Type', required: true, example: ar ? 'Invoice' : 'Bill', note: ar ? 'Invoice, Credit Memo or Payment' : 'Bill or Credit' },
      { header: 'Date', required: true, example: '2026-09-15', note: 'YYYY-MM-DD or MM/DD/YYYY.' },
      { header: 'Num', required: false, example: ar ? '1001' : 'B-55', note: 'Kept on the document.' },
      { header: 'Name', required: true, example: ar ? 'Joplin Regional Stockyards' : 'Staples', note: ar ? 'Customer.' : 'Vendor.' },
      { header: 'Due Date', required: false, example: '2026-10-15' },
      { header: 'Amount', required: false, example: '1200.00', note: 'The original amount; kept in the memo.' },
      { header: 'Open Balance', required: true, example: '1000.00', note: 'Still owed; negative for a credit.' },
    ],
  };
}

/** U-265: the item list (read by adapters/items.ts, which also takes the QuickBooks column names). */
export const GENERIC_ITEMS_TEMPLATE: GenericTemplate = {
  sheetName: 'Items',
  description: 'One product or service per row. Item, Type and Account (the income account) are required; inventory items also need an Asset Account and a COGS Account.',
  columns: [
    { header: 'Item', required: true, example: 'Consulting', note: 'Unique name.' },
    { header: 'Type', required: true, example: 'Service', note: 'Service, Inventory Part, Non-inventory Part, Other Charge, Discount or Subtotal.' },
    { header: 'Description', required: false, example: 'Hourly consulting' },
    { header: 'Price', required: false, example: '125.00', note: 'Sales price; a discount takes an amount or a percent like 10%.' },
    { header: 'Cost', required: false, example: '', note: 'Purchase cost.' },
    { header: 'Account', required: true, example: '4000', note: 'Income account (name or number).' },
    { header: 'Expense Account', required: false, example: '', note: 'Purchases of non-inventory items (name or number).' },
    { header: 'COGS Account', required: false, example: '', note: 'Inventory items: cost of goods sold (name or number).' },
    { header: 'Asset Account', required: false, example: '', note: 'Inventory items: inventory asset (name or number).' },
    { header: 'Preferred Vendor', required: false, example: '' },
    { header: 'Sales Tax Code', required: false, example: 'Non', note: 'Tax or Non.' },
    { header: 'Active Status', required: false, example: 'Active', note: 'Active or Inactive.' },
  ],
};

/** U-265: inventory on hand and value as of one date (the report date is required on upload). */
export const GENERIC_VALUATION_TEMPLATE: GenericTemplate = {
  sheetName: 'Inventory Valuation',
  description: 'One inventory item per row, as of one date: what is on hand and its exact value. Each becomes opening stock at that value.',
  columns: [
    { header: 'Item', required: true, example: 'Widget' },
    { header: 'On Hand', required: true, example: '12', note: 'Above 0, at most 4 decimal places.' },
    { header: 'Asset Value', required: true, example: '180.00', note: 'The value of what is on hand, at most 2 decimal places.' },
  ],
};

/** U-268: multi-line invoices, bills and journal entries (read by adapters/transactions.ts). */
export const GENERIC_DOCUMENTS_TEMPLATE: GenericTemplate = {
  sheetName: 'Transactions',
  description: 'One line per row; rows with the same group_id are one invoice, bill or journal entry. '
    + 'Names, accounts, items and tags must already be in the company. No sales tax is added.',
  columns: [
    { header: 'group_id', required: true, example: 'INV-1', note: 'The same value on every row of one document.' },
    { header: 'type', required: true, example: 'invoice', note: 'invoice, bill or journal_entry.' },
    { header: 'date', required: true, example: '2026-09-15', note: 'YYYY-MM-DD or MM/DD/YYYY.' },
    { header: 'number', required: false, example: '1001', note: 'Invoice or journal entry number; a bill\'s vendor invoice number.' },
    { header: 'name', required: false, example: 'Joplin Regional Stockyards', note: 'Customer (invoice) or vendor (bill), required for them; optional on a journal entry.' },
    { header: 'due_date', required: false, example: '2026-10-15', note: 'Invoices and bills.' },
    { header: 'memo', required: false, example: '' },
    { header: 'line_account', required: false, example: '4000', note: 'Account number or name. Invoice and bill lines take an account or an item.' },
    { header: 'line_item', required: false, example: '', note: 'Item name (invoices and bills).' },
    { header: 'line_description', required: false, example: 'Consulting, September' },
    { header: 'line_amount', required: false, example: '1200.00', note: 'Invoice and bill lines (exact; invoices at most 2 decimal places). A journal entry line may use a signed amount (positive = debit).' },
    { header: 'line_debit', required: false, example: '', note: 'Journal entry lines.' },
    { header: 'line_credit', required: false, example: '', note: 'Journal entry lines. Each entry must balance exactly.' },
    { header: 'line_tag', required: false, example: '', note: 'Tag name.' },
  ],
};

export const GENERIC_TEMPLATES: Record<'coa' | 'contacts' | 'trial_balance' | 'gl_transactions' | 'open_invoices' | 'unpaid_bills' | 'items' | 'inventory_valuation' | 'transactions', GenericTemplate> = {
  transactions: GENERIC_DOCUMENTS_TEMPLATE,
  items: GENERIC_ITEMS_TEMPLATE,
  inventory_valuation: GENERIC_VALUATION_TEMPLATE,
  coa: GENERIC_COA_TEMPLATE,
  contacts: GENERIC_CONTACTS_TEMPLATE,
  trial_balance: GENERIC_TB_TEMPLATE,
  gl_transactions: GENERIC_TXN_TEMPLATE,
  open_invoices: openItemsTemplate('open_invoices'),
  unpaid_bills: openItemsTemplate('unpaid_bills'),
};
