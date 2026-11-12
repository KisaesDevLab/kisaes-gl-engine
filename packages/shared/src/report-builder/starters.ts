// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

/**
 * Report Builder starters (U-119): builder definitions that reproduce
 * standard reports. Each names the standard report (GET /reports/<tiesTo>)
 * it ties to when run with the same dates, ranges, basis and adjusting.
 * GET /report-builder/starters returns them; fixtures/starters/<key>.json
 * holds the same definitions for the desktop's schema tests.
 */

import type { BuilderDefinition, RbFilter, RbGroupBy, RbSectionNode, RbNode, RbCompare } from './schemas.js';
import type { RbDetailField } from './fields.js';

export interface BuilderStarter {
  key: string;
  title: string;
  /** The standard report route it ties to (`/reports/<tiesTo>`). */
  tiesTo: string;
  definition: BuilderDefinition;
}

type SectionOpts = Partial<Omit<RbSectionNode, 'type' | 'id' | 'caption' | 'source' | 'measure'>>;

function section(id: string, caption: string, source: RbSectionNode['source'], measure: RbSectionNode['measure'], o: SectionOpts = {}): RbSectionNode {
  return {
    type: 'section', id, caption, source, measure,
    ...(o.polarity ? { polarity: o.polarity } : {}),
    filters: o.filters ?? [],
    groupBy: o.groupBy ?? [{ key: 'account' }],
    display: o.display ?? 'summary',
    defaultExpanded: o.defaultExpanded ?? false,
    showTotal: o.showTotal ?? true,
    ...(o.totalCaption ? { totalCaption: o.totalCaption } : {}),
    hideZero: o.hideZero ?? true,
    ...(o.earnings ? { earnings: o.earnings } : {}),
  };
}

const types = (...values: string[]): RbFilter => ({ field: 'account_type', op: 'in', values });
const by = (key: RbGroupBy['key']): RbGroupBy[] => [{ key }];

function def(mode: 'range' | 'asOf', preset: string, nodes: RbNode[], columns: Partial<BuilderDefinition['columns']> = {}): BuilderDefinition {
  return {
    schemaVersion: 1,
    kind: 'builder',
    dates: { mode, preset },
    columns: { detailFields: [], compare: [] as RbCompare[], headers: {}, ...columns },
    nodes,
  };
}

function profitLossNodes(): RbNode[] {
  return [
    section('income', 'Income', 'gl', 'amount', { filters: [types('revenue')], totalCaption: 'Total Income' }),
    section('cogs', 'Cost of Goods Sold', 'gl', 'amount', { filters: [types('cogs')], totalCaption: 'Total Cost of Goods Sold' }),
    { type: 'formula', id: 'gross_profit', caption: 'Gross Profit', terms: [{ nodeId: 'income', sign: 1 }, { nodeId: 'cogs', sign: -1 }] },
    section('expenses', 'Expenses', 'gl', 'amount', { filters: [types('expense')], totalCaption: 'Total Expenses' }),
    { type: 'formula', id: 'net_operating_income', caption: 'Net Operating Income', terms: [{ nodeId: 'gross_profit', sign: 1 }, { nodeId: 'expenses', sign: -1 }] },
    section('other_income', 'Other Income', 'gl', 'amount', { filters: [types('other_revenue')], totalCaption: 'Total Other Income' }),
    section('other_expenses', 'Other Expenses', 'gl', 'amount', { filters: [types('other_expense')], totalCaption: 'Total Other Expenses' }),
    {
      type: 'formula', id: 'net_income', caption: 'Net Income',
      terms: [{ nodeId: 'net_operating_income', sign: 1 }, { nodeId: 'other_income', sign: 1 }, { nodeId: 'other_expenses', sign: -1 }],
    },
  ];
}

/**
 * Detail fields (U-119f, report-builder-starters-v2): every starter drills to
 * detail, so each names the columns its detail rows show, as its standard
 * report's drill does. The value columns carry the amount, so no `amount`
 * field (it would repeat it). Fields are definition-wide: a summary run
 * sends them as columns whose cells are all null (the desktop hides those).
 */
const AR_DETAIL: RbDetailField[] = ['date', 'txn_type', 'number', 'contact', 'due_date', 'days_past_due', 'original_amount'];
/** Line drills: a Total spans accounts, so the account is shown too. */
const LINE_DETAIL: RbDetailField[] = ['date', 'txn_type', 'number', 'contact', 'memo', 'description', 'account'];
const LEDGER_DETAIL: RbDetailField[] = ['date', 'txn_type', 'number', 'contact', 'memo', 'description', 'debit', 'credit', 'running_balance'];

function openItems(
  source: 'ar_open' | 'ap_open', caption: string, groupBy: RbGroupBy[], display: RbSectionNode['display'], total: string, filters: RbFilter[] = [],
): RbSectionNode {
  return section(source === 'ar_open' ? 'receivables' : 'payables', caption, source, 'open_balance', {
    filters, groupBy, display, defaultExpanded: display !== 'summary', totalCaption: total, hideZero: true,
  });
}

/** Open Invoices / Unpaid Bills: the document type their standard report lists (U-119f). */
const docType = (t: 'invoice' | 'bill'): RbFilter => ({ field: 'txn_type', op: 'in', values: [t] });

/**
 * Transaction Detail by Account (U-119f): one section per account type, in
 * the standard General Ledger's order, each in its natural sign (a credit
 * account's balance positive, as the standard report shows it). A single
 * natural section over every account would be MIXED_POLARITY.
 */
const LEDGER_TYPES: Array<[string, string, string]> = [
  ['assets', 'Assets', 'asset'], ['liabilities', 'Liabilities', 'liability'], ['equity', 'Equity', 'equity'],
  ['income', 'Income', 'revenue'], ['cogs', 'Cost of Goods Sold', 'cogs'], ['expenses', 'Expenses', 'expense'],
  ['other_income', 'Other Income', 'other_revenue'], ['other_expenses', 'Other Expenses', 'other_expense'],
];
const ledgerNodes = (): RbNode[] => LEDGER_TYPES.map(([id, caption, type]) => section(id, caption, 'gl', 'amount', {
  filters: [types(type)], display: 'detail', defaultExpanded: true, showTotal: false,
}));

export const BUILDER_STARTERS: BuilderStarter[] = [
  { key: 'profit_loss', title: 'Profit and Loss', tiesTo: 'profit-loss', definition: def('range', 'this_year_to_date', profitLossNodes(), { detailFields: LINE_DETAIL }) },
  {
    key: 'profit_loss_by_month', title: 'Profit and Loss by Month', tiesTo: 'profit-loss',
    definition: def('range', 'this_year_to_date', profitLossNodes(), { detailFields: LINE_DETAIL, periods: 'month' }),
  },
  {
    key: 'profit_loss_pct_income', title: 'Profit and Loss with % of Income', tiesTo: 'profit-loss',
    definition: def('range', 'this_year_to_date', profitLossNodes(), { detailFields: LINE_DETAIL, percentOf: 'income' }),
  },
  {
    key: 'balance_sheet', title: 'Balance Sheet', tiesTo: 'balance-sheet',
    definition: def('asOf', 'today', [
      section('assets', 'Assets', 'gl', 'balance', { filters: [types('asset')], totalCaption: 'Total Assets' }),
      section('liabilities', 'Liabilities', 'gl', 'balance', { filters: [types('liability')], totalCaption: 'Total Liabilities' }),
      section('equity', 'Equity', 'gl', 'balance', { filters: [types('equity')], totalCaption: 'Total Equity', earnings: 'balance_sheet' }),
      { type: 'formula', id: 'liabilities_equity', caption: 'Total Liabilities and Equity', terms: [{ nodeId: 'liabilities', sign: 1 }, { nodeId: 'equity', sign: 1 }] },
    ], { detailFields: LINE_DETAIL }),
  },
  {
    key: 'trial_balance', title: 'Trial Balance', tiesTo: 'trial-balance',
    definition: def('asOf', 'today', [
      section('accounts', 'Trial Balance', 'gl', 'tb_net', { totalCaption: 'Total', earnings: 'trial_balance' }),
    ], { detailFields: LINE_DETAIL }),
  },
  {
    key: 'transaction_detail_by_account', title: 'Transaction Detail by Account', tiesTo: 'general-ledger',
    definition: def('range', 'this_month', ledgerNodes(), { detailFields: LEDGER_DETAIL }),
  },
  {
    key: 'revenue_by_category', title: 'Revenue by Category', tiesTo: 'profit-loss',
    definition: def('range', 'this_year_to_date', [
      section('revenue', 'Revenue', 'gl', 'amount', { filters: [types('revenue', 'other_revenue')], totalCaption: 'Total Revenue' }),
    ], { detailFields: LINE_DETAIL }),
  },
  {
    key: 'expenses_by_category', title: 'Expenses by Category', tiesTo: 'expense-by-category',
    definition: def('range', 'this_year_to_date', [
      section('expenses', 'Expenses', 'gl', 'amount', { filters: [types('cogs', 'expense', 'other_expense')], totalCaption: 'Total Expenses' }),
    ], { detailFields: LINE_DETAIL }),
  },
  {
    key: 'ar_aging_summary', title: 'A/R Aging Summary', tiesTo: 'ar-aging-summary',
    definition: def('asOf', 'today', [openItems('ar_open', 'Accounts Receivable', by('contact'), 'summary', 'Total')], { detailFields: AR_DETAIL, agingBuckets: true }),
  },
  {
    key: 'ar_aging_detail', title: 'A/R Aging Detail', tiesTo: 'ar-aging-detail',
    definition: def('asOf', 'today', [openItems('ar_open', 'Accounts Receivable', by('aging_bucket'), 'detail', 'Total')], { detailFields: AR_DETAIL }),
  },
  {
    key: 'ap_aging_summary', title: 'A/P Aging Summary', tiesTo: 'ap-aging-summary',
    definition: def('asOf', 'today', [openItems('ap_open', 'Accounts Payable', by('contact'), 'summary', 'Total')], { detailFields: AR_DETAIL, agingBuckets: true }),
  },
  {
    key: 'ap_aging_detail', title: 'A/P Aging Detail', tiesTo: 'ap-aging-detail',
    definition: def('asOf', 'today', [openItems('ap_open', 'Accounts Payable', by('aging_bucket'), 'detail', 'Total')], { detailFields: AR_DETAIL }),
  },
  {
    key: 'open_invoices', title: 'Open Invoices', tiesTo: 'invoice-list',
    definition: def('asOf', 'today', [openItems('ar_open', 'Open Invoices', by('contact'), 'detail', 'Total', [docType('invoice')])], { detailFields: AR_DETAIL }),
  },
  {
    key: 'unpaid_bills', title: 'Unpaid Bills', tiesTo: 'unpaid-bills',
    definition: def('asOf', 'today', [openItems('ap_open', 'Unpaid Bills', by('contact'), 'detail', 'Total', [docType('bill')])], { detailFields: AR_DETAIL }),
  },
  {
    key: 'customer_balance_summary', title: 'Customer Balance Summary', tiesTo: 'customer-balance-summary',
    definition: def('asOf', 'today', [openItems('ar_open', 'Customer Balances', by('contact'), 'summary', 'Total')], { detailFields: AR_DETAIL }),
  },
  {
    key: 'vendor_balance_summary', title: 'Vendor Balance Summary', tiesTo: 'vendor-balance-summary',
    definition: def('asOf', 'today', [openItems('ap_open', 'Vendor Balances', by('contact'), 'summary', 'Total')], { detailFields: AR_DETAIL }),
  },
  {
    key: 'sales_by_client', title: 'Sales by Client', tiesTo: 'sales-by-customer',
    definition: def('range', 'this_year_to_date', [
      section('sales', 'Sales', 'sales', 'amount', { groupBy: by('contact'), totalCaption: 'Total' }),
    ], { detailFields: LINE_DETAIL }),
  },
  {
    key: 'sales_by_item', title: 'Sales by Item', tiesTo: 'sales-by-item',
    definition: def('range', 'this_year_to_date', [
      section('sales', 'Sales', 'item_sales', 'amount', { groupBy: by('item'), totalCaption: 'Total' }),
    ], { detailFields: [...LINE_DETAIL, 'item'] }),
  },
  {
    key: 'check_register', title: 'Check Register', tiesTo: 'check-register',
    definition: def('range', 'this_month', [
      section('register', 'Check Register', 'bank', 'amount', { display: 'detail', defaultExpanded: true, showTotal: false }),
    ], { detailFields: ['date', 'txn_type', 'number', 'contact', 'memo', 'cleared', 'debit', 'credit', 'running_balance'] }),
  },
  {
    key: 'bank_balances', title: 'Bank Account Balances', tiesTo: 'bank-balances',
    definition: def('asOf', 'today', [
      section('banks', 'Bank Accounts', 'bank', 'balance', { totalCaption: 'Total', hideZero: false }),
    ], { detailFields: LINE_DETAIL }),
  },
];
