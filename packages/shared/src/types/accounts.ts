export type AccountType = 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';

export interface Account {
  id: string;
  tenantId: string;
  accountNumber: string | null;
  name: string;
  accountType: AccountType;
  detailType: string | null;
  description: string | null;
  isActive: boolean;
  isSystem: boolean;
  systemTag: string | null;
  parentId: string | null;
  balance: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateAccountInput {
  accountNumber?: string | null;
  name: string;
  accountType: AccountType;
  detailType?: string | null;
  description?: string | null;
  parentId?: string | null;
}

export interface UpdateAccountInput {
  accountNumber?: string | null;
  name?: string;
  accountType?: AccountType;
  detailType?: string | null;
  description?: string | null;
  parentId?: string | null;
  isActive?: boolean;
}

export interface AccountFilters {
  accountType?: AccountType;
  isActive?: boolean;
  search?: string;
  limit?: number;
  offset?: number;
}

export const ACCOUNT_TYPES: AccountType[] = ['asset', 'liability', 'equity', 'revenue', 'expense'];

export const DETAIL_TYPES: Record<AccountType, string[]> = {
  asset: ['bank', 'accounts_receivable', 'other_current_asset', 'fixed_asset', 'other_asset'],
  liability: ['accounts_payable', 'credit_card', 'other_current_liability', 'long_term_liability'],
  equity: ['owners_equity', 'retained_earnings', 'opening_balance'],
  revenue: ['service', 'sales_of_product', 'other_income', 'interest_earned'],
  expense: [
    'advertising', 'bank_charges', 'cost_of_goods_sold', 'other_cost_of_service',
    'insurance', 'meals_entertainment', 'office_supplies', 'legal_professional',
    'rent_or_lease', 'repairs_maintenance', 'utilities', 'travel',
    'payroll_expenses', 'other_expense',
  ],
};
