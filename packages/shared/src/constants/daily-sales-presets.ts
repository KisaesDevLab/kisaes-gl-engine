// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import type { AccountType } from '../types/accounts.js';

// Daily Sales (POS X/Z report) template engine — see Build Plans/DAILY_SALES_POS_PLAN.md.
// Presets are STARTING POINTS the user edits. System-account lines (systemTag)
// resolve via getOrCreateSystemAccount on the server; revenue/expense/contra
// lines are seeded unmapped (account_id null) with a `suggestedType` so the
// template builder can pre-filter the account picker — the user maps them.

export type DailySalesSection =
  | 'sales'
  | 'tax'
  | 'tips'
  | 'discount'
  | 'payment'
  | 'payout'
  | 'other';

export type DailySalesNormalSide = 'debit' | 'credit';

export const DAILY_SALES_SECTIONS: { key: DailySalesSection; label: string }[] = [
  { key: 'sales', label: 'Sales' },
  { key: 'tax', label: 'Sales Tax' },
  { key: 'tips', label: 'Tips / Gratuity' },
  { key: 'discount', label: 'Discounts / Comps' },
  { key: 'payment', label: 'Payments / Tenders' },
  { key: 'payout', label: 'Payouts' },
  { key: 'other', label: 'Other' },
];

export interface DailySalesPresetLine {
  section: DailySalesSection;
  label: string;
  normalSide: DailySalesNormalSide;
  /** Resolve to this system account (get-or-create) when seeding the template. */
  systemTag?: string;
  /** Otherwise leave unmapped; hint the builder's account picker. */
  suggestedType?: AccountType;
  required?: boolean;
  allowTag?: boolean;
}

export interface DailySalesPreset {
  key: 'restaurant' | 'retail';
  label: string;
  lines: DailySalesPresetLine[];
}

export const DAILY_SALES_PRESETS: DailySalesPreset[] = [
  {
    key: 'restaurant',
    label: 'Restaurant / Bar',
    lines: [
      { section: 'sales', label: 'Food Sales', normalSide: 'credit', suggestedType: 'revenue', required: true },
      { section: 'sales', label: 'Beverage / Liquor Sales', normalSide: 'credit', suggestedType: 'revenue' },
      { section: 'discount', label: 'Comps / Discounts', normalSide: 'debit', suggestedType: 'revenue' },
      { section: 'tax', label: 'Sales Tax Collected', normalSide: 'credit', systemTag: 'sales_tax_payable' },
      { section: 'tips', label: 'Tips / Gratuity', normalSide: 'credit', systemTag: 'tips_payable' },
      { section: 'payment', label: 'Cash', normalSide: 'debit', systemTag: 'payments_clearing' },
      { section: 'payment', label: 'Visa / Mastercard', normalSide: 'debit', systemTag: 'payments_clearing' },
      { section: 'payment', label: 'American Express', normalSide: 'debit', systemTag: 'payments_clearing' },
      { section: 'payment', label: 'Gift Card Redeemed', normalSide: 'debit', systemTag: 'payments_clearing' },
      { section: 'other', label: 'Gift Cards Sold', normalSide: 'credit', systemTag: 'gift_card_liability' },
      { section: 'payout', label: 'Paid-Outs (from drawer)', normalSide: 'debit', suggestedType: 'expense' },
    ],
  },
  {
    key: 'retail',
    label: 'Retail',
    lines: [
      { section: 'sales', label: 'Department 1 Sales', normalSide: 'credit', suggestedType: 'revenue', required: true },
      { section: 'sales', label: 'Department 2 Sales', normalSide: 'credit', suggestedType: 'revenue' },
      { section: 'discount', label: 'Returns / Discounts', normalSide: 'debit', suggestedType: 'revenue' },
      { section: 'tax', label: 'Sales Tax Collected', normalSide: 'credit', systemTag: 'sales_tax_payable' },
      { section: 'payment', label: 'Cash', normalSide: 'debit', systemTag: 'payments_clearing' },
      { section: 'payment', label: 'Credit / Debit Cards', normalSide: 'debit', systemTag: 'payments_clearing' },
      { section: 'payment', label: 'Other Tender', normalSide: 'debit', systemTag: 'payments_clearing' },
      { section: 'payment', label: 'Gift Card Redeemed', normalSide: 'debit', systemTag: 'payments_clearing' },
      { section: 'other', label: 'Gift Cards Sold', normalSide: 'credit', systemTag: 'gift_card_liability' },
      { section: 'payout', label: 'Petty-Cash Payouts', normalSide: 'debit', suggestedType: 'expense' },
    ],
  },
];

// System accounts the feature creates lazily (get-or-create) beyond the ones
// already in every COA template (payments_clearing, sales_tax_payable).
export interface DailySalesSystemAccountSpec {
  systemTag: string;
  name: string;
  accountType: AccountType;
  detailType: string;
  accountNumber: string;
}

export const DAILY_SALES_SYSTEM_ACCOUNTS: DailySalesSystemAccountSpec[] = [
  { systemTag: 'cash_over_short', name: 'Cash Over/Short', accountType: 'expense', detailType: 'other_expense', accountNumber: '60900' },
  { systemTag: 'tips_payable', name: 'Tips Payable', accountType: 'liability', detailType: 'other_current_liability', accountNumber: '21000' },
  { systemTag: 'gift_card_liability', name: 'Gift Card Liability', accountType: 'liability', detailType: 'other_current_liability', accountNumber: '21100' },
];
