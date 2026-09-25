// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Close workspace report catalog. Each review check is presented as an
// exception-only report inside one section of the month-end close, in the
// order a reviewer works them (Double-HQ style). Checks not listed here
// land in "Other checks" so nothing a run produces is ever hidden.

export const CLOSE_SECTIONS = [
  { key: 'transactions', title: 'Transaction review', blurb: 'Coding, payees, documentation and unusual items for the month.' },
  { key: 'payees', title: 'Payee review', blurb: 'New and duplicate vendors, customers and accounts; 1099 readiness.' },
  { key: 'final', title: 'Final review', blurb: 'Balances and period-over-period changes before the month is signed off.' },
  { key: 'other', title: 'Other checks', blurb: 'Checks not assigned to a section.' },
] as const;
export type CloseSectionKey = typeof CLOSE_SECTIONS[number]['key'];

export interface CloseReportDef {
  checkKey: string;
  section: CloseSectionKey;
  title: string;
}

export const CLOSE_REPORTS: readonly CloseReportDef[] = [
  // Transaction review
  { checkKey: 'uncategorized_stale', section: 'transactions', title: 'Uncategorized bank lines' },
  { checkKey: 'expense_without_payee', section: 'transactions', title: 'Transactions without a payee' },
  { checkKey: 'account_inconsistency_vs_history', section: 'transactions', title: 'Expense inconsistency vs history' },
  { checkKey: 'tag_inconsistency_vs_history', section: 'transactions', title: 'Tag inconsistency vs history' },
  { checkKey: 'parent_account_posting', section: 'transactions', title: 'Posted to a parent account' },
  { checkKey: 'transaction_above_materiality', section: 'transactions', title: 'Large transactions' },
  { checkKey: 'duplicate_candidate', section: 'transactions', title: 'Possible duplicate transactions' },
  { checkKey: 'missing_attachment_above_threshold', section: 'transactions', title: 'Expenses and bills without attachments' },
  { checkKey: 'journal_entry_without_attachment', section: 'transactions', title: 'Journal entries without attachments' },
  { checkKey: 'receipt_amount_mismatch', section: 'transactions', title: 'Receipt amount differs from bank' },
  { checkKey: 'missing_required_customer', section: 'transactions', title: 'Invoices and payments without a customer' },
  { checkKey: 'auto_posted_by_rule_sampling', section: 'transactions', title: 'Posted by a bank rule (sample)' },
  { checkKey: 'round_dollar_above_threshold', section: 'transactions', title: 'Round-dollar amounts' },
  { checkKey: 'weekend_holiday_posting', section: 'transactions', title: 'Dated on a weekend' },
  { checkKey: 'ai_personal_expense_review', section: 'transactions', title: 'Possibly personal (AI)' },
  // Payee review
  { checkKey: 'new_entities_review', section: 'payees', title: 'New vendors, customers and accounts' },
  { checkKey: 'duplicate_entity_names', section: 'payees', title: 'Duplicate names' },
  { checkKey: 'vendor_1099_threshold_no_w9', section: 'payees', title: '1099 vendors missing a W-9' },
  // Final review
  { checkKey: 'flux_variance', section: 'final', title: 'P&L changes vs trailing average' },
  { checkKey: 'negative_non_liability', section: 'final', title: 'Balances on the wrong side' },
  { checkKey: 'posted_into_reconciled_range', section: 'final', title: 'Posted into a reconciled range' },
  { checkKey: 'closed_period_posting', section: 'final', title: 'Posted into a closed period' },
  { checkKey: 'plaid_connection_health', section: 'final', title: 'Bank connections needing attention' },
];

export function closeReportFor(checkKey: string): CloseReportDef {
  return CLOSE_REPORTS.find((r) => r.checkKey === checkKey)
    ?? { checkKey, section: 'other', title: checkKey.replace(/_/g, ' ') };
}

// Close sign-off lifecycle for one company + month.
export const CLOSE_STATUSES = ['not_started', 'in_progress', 'prepared', 'closed'] as const;
export type CloseStatus = typeof CLOSE_STATUSES[number];
