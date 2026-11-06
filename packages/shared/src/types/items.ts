// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/** Sales item kinds (U-39a, item-kinds-sales-v1). */
export const SALES_ITEM_TYPES = ['service', 'non_inventory', 'other_charge', 'discount', 'subtotal'] as const;
/** Every item kind: the sales kinds plus inventory_part (U-39b, item-types-v1). */
export const ITEM_TYPES = [...SALES_ITEM_TYPES, 'inventory_part'] as const;
export type SalesItemType = typeof SALES_ITEM_TYPES[number];
export type ItemType = typeof ITEM_TYPES[number];

export interface Item {
  id: string;
  tenantId: string;
  name: string;
  description: string | null;
  itemType: ItemType;
  /** A discount item's percent off (0 < p <= 100), else null. */
  discountPercent: string | null;
  /** The price; for a discount item without discountPercent, the amount off. */
  unitPrice: string | null;
  incomeAccountId: string;
  isTaxable: boolean;
  isActive: boolean;
  /** Purchase side on every kind (U-39b, item-types-v1). */
  purchaseDescription: string | null;
  purchaseCost: string | null;
  expenseAccountId: string | null;
  preferredVendorId: string | null;
  /** Inventory parts only (U-39b). */
  assetAccountId: string | null;
  cogsAccountId: string | null;
  reorderPoint: string | null;
  reorderQuantity: string | null;
  unitLabel: string | null;
  /** Units of measure (U-161): the unit set and default units (null = base). */
  unitSetId: string | null;
  defaultPurchaseUnitId: string | null;
  defaultSaleUnitId: string | null;
  /** Read-only on parts (null on other kinds): quantity (4 places), average cost (6), asset value (2). */
  quantityOnHand: string | null;
  averageCost: string | null;
  assetValue: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateItemInput {
  /** An inventory part's opening stock (U-159): quantity > 0, value >= 0 (2 places), asOf YYYY-MM-DD. */
  opening?: { quantity: string; value: string; asOf: string };
  name: string;
  description?: string | null;
  itemType?: ItemType;
  discountPercent?: string | null;
  unitPrice?: string | null;
  incomeAccountId: string;
  isTaxable?: boolean;
  purchaseDescription?: string | null;
  purchaseCost?: string | null;
  expenseAccountId?: string | null;
  preferredVendorId?: string | null;
  assetAccountId?: string | null;
  cogsAccountId?: string | null;
  reorderPoint?: string | null;
  reorderQuantity?: string | null;
  unitLabel?: string | null;
  unitSetId?: string | null;
  defaultPurchaseUnitId?: string | null;
  defaultSaleUnitId?: string | null;
}

export interface UpdateItemInput {
  name?: string;
  description?: string | null;
  itemType?: ItemType;
  discountPercent?: string | null;
  unitPrice?: string | null;
  incomeAccountId?: string;
  isTaxable?: boolean;
  isActive?: boolean;
  purchaseDescription?: string | null;
  purchaseCost?: string | null;
  expenseAccountId?: string | null;
  preferredVendorId?: string | null;
  assetAccountId?: string | null;
  cogsAccountId?: string | null;
  reorderPoint?: string | null;
  reorderQuantity?: string | null;
  unitLabel?: string | null;
  unitSetId?: string | null;
  defaultPurchaseUnitId?: string | null;
  defaultSaleUnitId?: string | null;
  /** updatedAt as last read (item-types-v1); a mismatch is 409 STALE. */
  expectedUpdatedAt?: string;
}

export type LineEntryMode = 'category' | 'item';

export type ItemSortKey = 'name' | 'price' | 'taxable' | 'status';

export interface ItemFilters {
  isActive?: boolean;
  itemType?: ItemType;
  isTaxable?: boolean;
  search?: string;
  sortBy?: ItemSortKey;
  sortDir?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}
