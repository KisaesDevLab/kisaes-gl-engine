// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/** Sales item kinds (U-39a, item-kinds-sales-v1). */
export const SALES_ITEM_TYPES = ['service', 'non_inventory', 'other_charge', 'discount', 'subtotal'] as const;
export type SalesItemType = typeof SALES_ITEM_TYPES[number];

export interface Item {
  id: string;
  tenantId: string;
  name: string;
  description: string | null;
  itemType: SalesItemType;
  /** A discount item's percent off (0 < p <= 100), else null. */
  discountPercent: string | null;
  /** The price; for a discount item without discountPercent, the amount off. */
  unitPrice: string | null;
  incomeAccountId: string;
  isTaxable: boolean;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateItemInput {
  name: string;
  description?: string | null;
  itemType?: SalesItemType;
  discountPercent?: string | null;
  unitPrice?: string | null;
  incomeAccountId: string;
  isTaxable?: boolean;
}

export interface UpdateItemInput {
  name?: string;
  description?: string | null;
  itemType?: SalesItemType;
  discountPercent?: string | null;
  unitPrice?: string | null;
  incomeAccountId?: string;
  isTaxable?: boolean;
  isActive?: boolean;
}

export type LineEntryMode = 'category' | 'item';

export type ItemSortKey = 'name' | 'price' | 'taxable' | 'status';

export interface ItemFilters {
  isActive?: boolean;
  itemType?: SalesItemType;
  isTaxable?: boolean;
  search?: string;
  sortBy?: ItemSortKey;
  sortDir?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}
