import type { AccountType } from '../types/accounts.js';

export const INCOME_TYPES: AccountType[] = ['revenue', 'other_revenue'];
export const COST_TYPES: AccountType[] = ['cogs', 'expense', 'other_expense'];
export const PL_TYPES: AccountType[] = [...INCOME_TYPES, ...COST_TYPES];
export const BALANCE_SHEET_TYPES: AccountType[] = ['asset', 'liability', 'equity'];

export function isIncomeType(t: AccountType | string): boolean {
  return INCOME_TYPES.includes(t as AccountType);
}

export function isCostType(t: AccountType | string): boolean {
  return COST_TYPES.includes(t as AccountType);
}

export function isPLType(t: AccountType | string): boolean {
  return PL_TYPES.includes(t as AccountType);
}

// Normal-balance side for each account type. Debit-normal accounts grow
// with debits and shrink with credits (asset, cogs, expense, other_expense);
// credit-normal accounts are the reverse (liability, equity, revenue,
// other_revenue). Used anywhere we compute running balances, render the
// register, or pick a side for opening balances and trial balance.
// Explicit Set<AccountType> type arg so the inferred element type is the
// AccountType union rather than `string`. Strict tsconfigs (and the
// default config tsc falls back to when an extends chain fails to load)
// reject `Set<string>` assigned to `Set<AccountType>` without this.
const DEBIT_NORMAL_TYPES = new Set<AccountType>([
  'asset', 'cogs', 'expense', 'other_expense',
]);

export function isDebitNormal(t: AccountType | string): boolean {
  return DEBIT_NORMAL_TYPES.has(t as AccountType);
}

const ACCOUNT_TYPE_LABELS: Record<AccountType, string> = {
  asset: 'Asset',
  liability: 'Liability',
  equity: 'Equity',
  revenue: 'Revenue',
  cogs: 'Cost of Goods Sold',
  expense: 'Expense',
  other_revenue: 'Other Revenue',
  other_expense: 'Other Expense',
};

export function formatAccountTypeLabel(t: AccountType | string): string {
  return ACCOUNT_TYPE_LABELS[t as AccountType] ?? t;
}
