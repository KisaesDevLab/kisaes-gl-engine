// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import type { AccountType } from '../types/accounts.js';

// ─── System-account roles ───────────────────────────────────────
//
// A tenant's ledger flows resolve certain accounts by ROLE rather than by id:
// `accounts.system_tag` marks which GL account plays each role. This catalog
// is the single source of truth for the full set of roles the API resolves —
// the admin "System Accounts" repair tool (see admin.service.ts) reads it to
// show which roles are assigned/missing and to validate re-assignment when a
// tenant's system accounts were deleted or mis-tagged.
//
// Keep in lockstep with the consumers listed per role. Adding a new
// `systemTag` lookup anywhere in the API means adding a row here.

export interface SystemAccountRole {
  /** The accounts.system_tag value. */
  tag: string;
  /** Human label for admin UI. */
  label: string;
  /** What the role does / which flows break when it's missing. */
  description: string;
  /** Account type the tagged account must have. */
  accountType: AccountType;
  /**
   * Detail type stamped onto the account when the role is (re)assigned, for
   * roles where reports/registers key off detail_type as well as system_tag
   * (AR/AP cash-basis conversion, balance-sheet RE fold). Roles without a
   * canonical detail type leave the account's detail type untouched.
   */
  canonicalDetailType?: string;
  /**
   * Required roles are seeded by every built-in COA template; a missing
   * required role breaks core posting flows. Optional roles are created
   * lazily on first use (daily-sales feature) — missing is normal until
   * the feature is used.
   */
  required: boolean;
}

export const SYSTEM_ACCOUNT_ROLES: SystemAccountRole[] = [
  {
    tag: 'accounts_receivable',
    label: 'Accounts Receivable',
    description: 'Invoice posting, customer payments, credit memos, customer refunds, batch invoicing, Stripe payouts.',
    accountType: 'asset',
    canonicalDetailType: 'accounts_receivable',
    required: true,
  },
  {
    tag: 'accounts_payable',
    label: 'Accounts Payable',
    description: 'Bill posting, bill payments, vendor credits, recurring bills, A/P dashboard aging.',
    accountType: 'liability',
    canonicalDetailType: 'accounts_payable',
    required: true,
  },
  {
    tag: 'sales_tax_payable',
    label: 'Sales Tax Payable',
    description: 'Sales tax collected on invoices, cash sales, recurring invoices, and daily-sales entries.',
    accountType: 'liability',
    required: true,
  },
  {
    tag: 'retained_earnings',
    label: 'Retained Earnings',
    description: 'Balance-sheet retained-earnings fold, year-end close target, system-account protection.',
    accountType: 'equity',
    canonicalDetailType: 'retained_earnings',
    required: true,
  },
  {
    tag: 'payments_clearing',
    label: 'Payments Clearing',
    description: 'Customer-payment clearing (undeposited funds), Stripe payout matching, daily-sales tender lines.',
    accountType: 'asset',
    required: true,
  },
  {
    tag: 'opening_balances',
    label: 'Opening Balances',
    description: 'Offset account for imported opening balances.',
    accountType: 'equity',
    required: true,
  },
  {
    tag: 'cash_on_hand',
    label: 'Cash',
    description: 'Default cash/bank account (demo data seeding, template default).',
    accountType: 'asset',
    required: true,
  },
  // Daily-sales roles — created lazily by getOrCreateSystemAccount() on first
  // use of the daily-sales feature; missing is normal for tenants that have
  // never used it.
  {
    tag: 'cash_over_short',
    label: 'Cash Over/Short',
    description: 'Daily-sales drawer over/short expense line.',
    accountType: 'expense',
    required: false,
  },
  {
    tag: 'tips_payable',
    label: 'Tips Payable',
    description: 'Daily-sales tips/gratuity liability line.',
    accountType: 'liability',
    required: false,
  },
  {
    tag: 'gift_card_liability',
    label: 'Gift Card Liability',
    description: 'Daily-sales gift-cards-sold liability line.',
    accountType: 'liability',
    required: false,
  },
];

export const SYSTEM_ACCOUNT_ROLE_BY_TAG: Record<string, SystemAccountRole> =
  Object.fromEntries(SYSTEM_ACCOUNT_ROLES.map((r) => [r.tag, r]));

export const SYSTEM_ACCOUNT_TAGS = SYSTEM_ACCOUNT_ROLES.map((r) => r.tag);
