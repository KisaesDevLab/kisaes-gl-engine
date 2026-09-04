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
  /**
   * Canonical type. Used when the role's account is CREATED, and the default
   * answer to "what type must this be?" when `allowedAccountTypes` is absent.
   */
  accountType: AccountType;
  /**
   * Types an operator may ASSIGN this role to, when the accounting genuinely
   * admits a choice. Defaults to `[accountType]`, which is the right answer
   * for every role whose type is dictated by the flows that consume it (A/R
   * must be an asset, sales tax must be a liability, and so on).
   *
   * Widened only for `suspense`: a holding account is legitimately either a
   * P&L account (QuickBooks' "Uncategorized", visible on the income
   * statement as a nag) or a balance-sheet one (a true suspense account that
   * keeps unclassified amounts out of profit entirely). Different firms want
   * different answers, so the role lets them choose.
   */
  allowedAccountTypes?: AccountType[];
  /**
   * Detail types that can never play this role even when the account type
   * matches. Needed once `allowedAccountTypes` widens to `asset`/`liability`,
   * because otherwise a checking account or the A/P control account becomes a
   * selectable "suspense account".
   */
  forbiddenDetailTypes?: string[];
  /**
   * May the TENANT's own admin assign this, or is it super-admin only?
   *
   * Off for every role the ledger's core flows depend on: getting A/R or
   * retained earnings wrong breaks posting and the year-end close, so those
   * stay with whoever supports the appliance. Suspense is opt-in per firm and
   * breaks nothing if changed, so its own admin owns it.
   */
  tenantAssignable?: boolean;
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
  // Suspense — the holding account for amounts that must post now but are
  // not yet classified. Created/adopted lazily by
  // getOrCreateSystemAccount() in system-accounts.service.ts, which prefers
  // an existing untagged `89999 Uncategorized` (every built-in COA template
  // but two seeds one) over minting a new account. Consumers: the staff
  // "Post to Suspense" bulk action, imports carrying an account the COA does
  // not have, and the Uncategorized review page that clears it again.
  // Deliberately other_expense, not a balance-sheet account, so an
  // unclassified amount stays visible on the P&L until someone deals with it.
  {
    tag: 'suspense',
    label: 'Suspense (Uncategorized)',
    description: 'Holding account for amounts posted before they are categorized. Cleared from Practice \u2192 Uncategorized.',
    accountType: 'other_expense',
    // Either school of thought is defensible, so the firm picks. Expense keeps
    // the nag on the P&L; a balance-sheet account keeps guesses out of profit.
    allowedAccountTypes: ['other_expense', 'expense', 'asset', 'liability'],
    // Money and control accounts are never a category, so never suspense.
    forbiddenDetailTypes: [
      'bank', 'checking', 'savings',
      'credit_card', 'line_of_credit',
      'accounts_receivable', 'accounts_payable',
    ],
    tenantAssignable: true,
    required: false,
  },
];

export const SYSTEM_ACCOUNT_ROLE_BY_TAG: Record<string, SystemAccountRole> =
  Object.fromEntries(SYSTEM_ACCOUNT_ROLES.map((r) => [r.tag, r]));

export const SYSTEM_ACCOUNT_TAGS = SYSTEM_ACCOUNT_ROLES.map((r) => r.tag);

/** The account types this role may be assigned to. */
export function allowedTypesForRole(role: SystemAccountRole): AccountType[] {
  return role.allowedAccountTypes ?? [role.accountType];
}

/** Roles a tenant's own admin may assign, without super-admin. */
export const TENANT_ASSIGNABLE_SYSTEM_ROLES: SystemAccountRole[] =
  SYSTEM_ACCOUNT_ROLES.filter((r) => r.tenantAssignable === true);

/**
 * Why this account cannot play this role, or null when it can. Shared so the
 * admin screen, the tenant screen and the API all answer identically.
 */
export function roleEligibilityError(
  role: SystemAccountRole,
  account: { accountType: string; detailType?: string | null; isActive?: boolean | null },
): string | null {
  const allowed = allowedTypesForRole(role);
  if (!allowed.includes(account.accountType as AccountType)) {
    return `${role.label} must be ${allowed.length === 1 ? 'a' : 'one of'} ${allowed.join(' / ')} account (selected account is ${account.accountType})`;
  }
  if (account.isActive === false) return 'That account is inactive.';
  if (role.forbiddenDetailTypes && account.detailType
      && role.forbiddenDetailTypes.includes(account.detailType)) {
    return `A ${account.detailType.replace(/_/g, ' ')} account cannot be the ${role.label} account.`;
  }
  return null;
}
