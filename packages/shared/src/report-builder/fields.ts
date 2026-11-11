// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

/**
 * Report Builder field catalogue (U-119, schema v1). Which sources exist,
 * what each one reads, and which measures, filters, group-bys and detail
 * fields it offers. The definition schema (schemas.ts) accepts every key
 * listed here; the validator refuses a key the section's source does not
 * offer (DEFINITION_INVALID code NOT_IN_SOURCE). GET /report-builder/fields
 * returns this table. Pure data: no I/O.
 *
 * Signs: every amount a source reports is signed by the section's polarity
 * ("natural" = the source's default below). Open-item sources are
 * owed-positive and take no polarity.
 */

export const RB_SOURCES = [
  'sales', 'item_sales', 'purchases', 'item_purchases', 'ar_open', 'ap_open', 'gl', 'bank', 'tax',
] as const;
export type RbSource = (typeof RB_SOURCES)[number];

/** Sources shown greyed out in v1, with the reason (not accepted by the schema). */
export const RB_UNAVAILABLE_SOURCES = [
  { key: 'inventory', reason: 'Inventory movements are not available in the Report Builder yet.' },
  { key: 'project', reason: 'Projects are not available yet.' },
] as const;

export const RB_MEASURES = [
  'amount', 'debit', 'credit', 'balance', 'tb_net', 'count', 'quantity', 'open_balance', 'original_amount',
] as const;
export type RbMeasure = (typeof RB_MEASURES)[number];

/** What a measure's figures are; formulas and percents never mix units (FORMULA_UNITS, PERCENT_BASE). */
export type RbUnit = 'money' | 'count' | 'quantity' | 'debit_credit';
export const RB_MEASURE_UNIT: Record<RbMeasure, RbUnit> = {
  amount: 'money', debit: 'money', credit: 'money', balance: 'money', open_balance: 'money', original_amount: 'money',
  tb_net: 'debit_credit', count: 'count', quantity: 'quantity',
};

export const RB_GROUP_KEYS = [
  'account', 'account_type', 'contact', 'item', 'txn_type', 'tag', 'month', 'quarter', 'year',
  'cleared', 'due_status', 'aging_bucket',
] as const;
export type RbGroupKey = (typeof RB_GROUP_KEYS)[number];

export const RB_FILTER_FIELDS = [
  'account', 'account_type', 'contact', 'item', 'tag', 'txn_type', 'cleared', 'due_status', 'aging_bucket', 'amount',
] as const;
export type RbFilterField = (typeof RB_FILTER_FIELDS)[number];

export const RB_FILTER_OPS = ['in', 'not_in', 'is_none', 'gte', 'lte'] as const;
export type RbFilterOp = (typeof RB_FILTER_OPS)[number];

/** Filter fields whose `in` / `not_in` take entity ids (`ids`), and the table they name. */
export const RB_ID_FILTER_FIELDS = { account: 'accounts', contact: 'contacts', item: 'items', tag: 'tags' } as const;
/** Filter fields whose `in` / `not_in` take enumeration values (`values`). */
export const RB_VALUE_FILTER_FIELDS = ['account_type', 'txn_type', 'cleared', 'due_status', 'aging_bucket'] as const;
/** Filter fields that may be empty on a line (`is_none`: no contact, no item, untagged). */
export const RB_NULLABLE_FILTER_FIELDS = ['contact', 'item', 'tag'] as const;
/** The one scalar filter: `gte` / `lte` with `value` a decimal string. */
export const RB_SCALAR_FILTER_FIELDS = ['amount'] as const;

export const RB_DETAIL_FIELDS = [
  'date', 'txn_type', 'number', 'contact', 'memo', 'description', 'account', 'item', 'quantity', 'unit_price',
  'tag', 'cleared', 'debit', 'credit', 'amount', 'running_balance', 'due_date', 'days_past_due', 'aging_bucket',
  'open_balance', 'original_amount',
] as const;
export type RbDetailField = (typeof RB_DETAIL_FIELDS)[number];

export const RB_ACCOUNT_TYPES = [
  'asset', 'liability', 'equity', 'revenue', 'cogs', 'expense', 'other_revenue', 'other_expense',
] as const;
/** Account types whose natural balance is a debit; the rest are credit-normal. */
export const RB_DEBIT_NORMAL_TYPES = ['asset', 'cogs', 'expense', 'other_expense'] as const;

export const RB_TXN_TYPES = [
  'invoice', 'customer_payment', 'cash_sale', 'expense', 'deposit', 'transfer', 'journal_entry',
  'credit_memo', 'customer_refund', 'bill', 'vendor_credit', 'bill_payment', 'daily_sales', 'aje',
  'returned_payment', 'sales_tax_payment', 'bad_debt_recovery', 'inventory_adjustment',
] as const;
export const RB_CLEARED = ['uncleared', 'cleared', 'reconciled'] as const;
export const RB_DUE_STATUS = ['current', 'overdue'] as const;
/** Aging buckets by days past due (Q-105): current, 1–30, 31–60, 61–90, over 90. */
export const RB_AGING_BUCKETS = ['current', 'd1_30', 'd31_60', 'd61_90', 'over_90'] as const;

/** The enumeration a value filter takes. */
export const RB_FILTER_VALUES: Record<(typeof RB_VALUE_FILTER_FIELDS)[number], readonly string[]> = {
  account_type: RB_ACCOUNT_TYPES,
  txn_type: RB_TXN_TYPES,
  cleared: RB_CLEARED,
  due_status: RB_DUE_STATUS,
  aging_bucket: RB_AGING_BUCKETS,
};

export type RbSign = 'credit_minus_debit' | 'debit_minus_credit' | 'natural' | 'owed_positive';

/** Rights areas (shared/src/constants/permissions.ts resources), read access. */
export type RbRight =
  | 'reports' | 'invoices' | 'receive_payment' | 'items' | 'bills' | 'pay_bills' | 'checks' | 'banking' | 'sales_tax';

export interface RbSourceInfo {
  key: RbSource;
  caption: string;
  /** Which lines it reads (plain language; the engine's fact query is the definition). */
  lines: string;
  sign: RbSign;
  openItems: boolean;
  measures: readonly RbMeasure[];
  /** Measures refused on cash basis (run: 400 DEFINITION_INVALID code NOT_ON_CASH). */
  accrualOnly: readonly RbMeasure[];
  filters: readonly RbFilterField[];
  groupBy: readonly RbGroupKey[];
  detailFields: readonly RbDetailField[];
  /** Rights always needed; the run adds more from the transaction types a section admits. */
  rights: readonly RbRight[];
  tiesTo: string | null;
}

const LINE_FIELDS = ['date', 'txn_type', 'number', 'contact', 'memo', 'description', 'account', 'item', 'tag', 'debit', 'credit', 'amount'] as const;
const LINE_GROUPS = ['account', 'account_type', 'contact', 'item', 'txn_type', 'tag', 'month', 'quarter', 'year'] as const;
const LINE_FILTERS = ['account', 'account_type', 'contact', 'item', 'tag', 'txn_type', 'amount'] as const;
const OPEN_FIELDS = ['date', 'txn_type', 'number', 'contact', 'memo', 'due_date', 'days_past_due', 'aging_bucket', 'open_balance', 'original_amount'] as const;
// On open items a tag is a document filter only ("the document has a line with the tag"); group by tag is not offered (Q-A07c).
const OPEN_FILTERS = ['contact', 'tag', 'txn_type', 'due_status', 'aging_bucket'] as const;
const OPEN_GROUPS = ['contact', 'txn_type', 'due_status', 'aging_bucket'] as const;

export const RB_SOURCE_INFO: Record<RbSource, RbSourceInfo> = {
  sales: {
    key: 'sales', caption: 'Sales',
    lines: 'Income lines (revenue, other revenue) of sales: invoices, sales receipts, credit memos and daily sales; on cash basis the cash-basis lines of invoices, sales receipts, credit memos, customer payments, returned payments and customer refunds. Bounced-payment and unapplied-receipt lines are left out.',
    sign: 'credit_minus_debit', openItems: false,
    measures: ['amount', 'quantity', 'count'], accrualOnly: ['quantity'],
    filters: LINE_FILTERS, groupBy: LINE_GROUPS, detailFields: [...LINE_FIELDS, 'quantity', 'unit_price'],
    rights: ['reports', 'invoices'], tiesTo: 'sales-by-customer',
  },
  item_sales: {
    key: 'item_sales', caption: 'Sales by item',
    lines: 'The same lines as Sales, by item; lines without an item are "No item".',
    sign: 'credit_minus_debit', openItems: false,
    measures: ['amount', 'quantity', 'count'], accrualOnly: ['quantity'],
    filters: LINE_FILTERS, groupBy: LINE_GROUPS, detailFields: [...LINE_FIELDS, 'quantity', 'unit_price'],
    rights: ['reports', 'invoices', 'items'], tiesTo: 'sales-by-item',
  },
  purchases: {
    key: 'purchases', caption: 'Purchases',
    lines: 'Expense, cost of goods sold and other expense lines of bills, vendor credits, expenses and checks; on cash basis also bill payments.',
    sign: 'debit_minus_credit', openItems: false,
    measures: ['amount', 'count'], accrualOnly: [],
    filters: LINE_FILTERS, groupBy: LINE_GROUPS, detailFields: LINE_FIELDS,
    rights: ['reports', 'bills'], tiesTo: null,
  },
  item_purchases: {
    key: 'item_purchases', caption: 'Purchases by item',
    lines: 'Lines with an item on bills, vendor credits, expenses and checks, on any account.',
    sign: 'debit_minus_credit', openItems: false,
    measures: ['amount', 'quantity', 'count'], accrualOnly: ['quantity'],
    filters: LINE_FILTERS, groupBy: LINE_GROUPS, detailFields: [...LINE_FIELDS, 'quantity', 'unit_price'],
    rights: ['reports', 'bills', 'items'], tiesTo: null,
  },
  ar_open: {
    key: 'ar_open', caption: 'Open invoices (A/R)',
    lines: 'Invoices and credits still open on each column\'s end date: payments and credits count only when dated on or before it.',
    sign: 'owed_positive', openItems: true,
    measures: ['open_balance', 'original_amount', 'count'], accrualOnly: [],
    filters: OPEN_FILTERS, groupBy: OPEN_GROUPS, detailFields: OPEN_FIELDS,
    rights: ['reports', 'invoices'], tiesTo: 'ar-aging-summary',
  },
  ap_open: {
    key: 'ap_open', caption: 'Unpaid bills (A/P)',
    lines: 'Bills and vendor credits still open on each column\'s end date: payments and credits count only when dated on or before it.',
    sign: 'owed_positive', openItems: true,
    measures: ['open_balance', 'original_amount', 'count'], accrualOnly: [],
    filters: OPEN_FILTERS, groupBy: OPEN_GROUPS, detailFields: OPEN_FIELDS,
    rights: ['reports', 'bills'], tiesTo: 'ap-aging-summary',
  },
  gl: {
    key: 'gl', caption: 'All accounts (general ledger)',
    lines: 'Every posted line, on the report\'s basis.',
    sign: 'natural', openItems: false,
    measures: ['amount', 'debit', 'credit', 'balance', 'tb_net', 'count'], accrualOnly: [],
    filters: [...LINE_FILTERS, 'cleared'], groupBy: LINE_GROUPS, detailFields: [...LINE_FIELDS, 'cleared', 'running_balance'],
    rights: ['reports'], tiesTo: 'general-ledger',
  },
  bank: {
    key: 'bank', caption: 'Bank accounts',
    lines: 'Lines on bank accounts; money in is positive.',
    sign: 'debit_minus_credit', openItems: false,
    measures: ['amount', 'balance', 'count'], accrualOnly: [],
    filters: [...LINE_FILTERS, 'cleared'], groupBy: [...LINE_GROUPS, 'cleared'], detailFields: [...LINE_FIELDS, 'cleared', 'running_balance'],
    rights: ['reports', 'banking'], tiesTo: 'check-register',
  },
  tax: {
    key: 'tax', caption: 'Sales tax',
    lines: 'Lines on the sales tax payable accounts.',
    sign: 'credit_minus_debit', openItems: false,
    measures: ['amount', 'count'], accrualOnly: [],
    filters: LINE_FILTERS, groupBy: LINE_GROUPS, detailFields: LINE_FIELDS,
    rights: ['reports', 'sales_tax'], tiesTo: null,
  },
};
