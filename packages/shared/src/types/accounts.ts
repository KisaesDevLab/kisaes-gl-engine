// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

export type AccountType =
  | 'asset'
  | 'liability'
  | 'equity'
  | 'revenue'
  | 'cogs'
  | 'expense'
  | 'other_revenue'
  | 'other_expense';

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

export const ACCOUNT_TYPES: AccountType[] = [
  'asset', 'liability', 'equity',
  'revenue', 'cogs', 'expense', 'other_revenue', 'other_expense',
];

// One option in a detail-type dropdown: built-ins come from DETAIL_TYPES
// below (isCustom: false, id: null); tenant-defined ones come from the
// tenant_detail_types table (isCustom: true, id set).
export interface DetailTypeOption {
  value: string;
  label: string;
  isCustom: boolean;
  id: string | null;
}

// GET /tenant-settings/detail-types response: merged builtin + custom
// options per account type.
export type MergedDetailTypes = Record<AccountType, DetailTypeOption[]>;

export interface CustomDetailType {
  id: string;
  tenantId: string;
  accountType: AccountType;
  value: string;
  label: string;
  createdAt: string;
  updatedAt: string;
}

export const DETAIL_TYPES: Record<AccountType, string[]> = {
  asset: ['bank', 'accounts_receivable', 'other_current_asset', 'fixed_asset', 'other_asset'],
  liability: ['accounts_payable', 'credit_card', 'other_current_liability', 'long_term_liability'],
  equity: ['owners_equity', 'retained_earnings', 'opening_balance'],
  revenue: ['service', 'sales_of_product'],
  cogs: ['cost_of_goods_sold', 'other_cost_of_service'],
  expense: [
    'advertising', 'bank_charges',
    'insurance', 'meals_entertainment', 'office_supplies', 'legal_professional',
    'rent_or_lease', 'repairs_maintenance', 'utilities', 'travel',
    'payroll_expenses',
  ],
  other_revenue: ['other_income', 'interest_earned'],
  other_expense: ['other_expense', 'interest_expense', 'depreciation', 'amortization'],
};
