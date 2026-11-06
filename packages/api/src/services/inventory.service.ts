// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * Inventory setup (U-39b item-types-v1, U-156 inventory-account-v1, U-25
 * company-inventory-flag-v1): the company switch, the inventory asset
 * account, the read-only stock figures on items and the guards that keep
 * the accounts parts post to in place.
 *
 * Stock figures and "has stock" checks read the costing ledger
 * (inventory_movements, U-157). Until that table lands (migration 0259)
 * no part can hold stock, so they report zero.
 */

import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { accounts, companies, items } from '../db/schema/index.js';
import type { DbOrTx } from '../db/index.js';
import { AppError } from '../utils/errors.js';
import { auditLog } from '../middleware/audit.js';

/** The system tag of the inventory asset account (U-156). */
export const INVENTORY_ASSET_TAG = 'inventory_asset';
/** The name an existing account must have to be adopted, and the name of a created one. */
export const INVENTORY_ASSET_NAME = 'Inventory Asset';
export const DEFAULT_COGS_NAME = 'Cost of Goods Sold';

/** The inventory fields of GET/PUT /company/settings (U-25; company-inventory-flag-v1). Stored NULL = off. */
export function inventorySettings(company: { inventoryEnabled?: boolean | null }) {
  return { inventoryEnabled: company.inventoryEnabled === true };
}

/** Whether the company has inventory turned on (NULL = off). */
export async function inventoryEnabled(executor: DbOrTx, tenantId: string, companyId: string | null | undefined): Promise<boolean> {
  const rows = await executor.select({ on: companies.inventoryEnabled }).from(companies)
    .where(companyId ? and(eq(companies.tenantId, tenantId), eq(companies.id, companyId)) : eq(companies.tenantId, tenantId));
  return rows.length > 0 && rows.every((r) => r.on === true);
}

/** 400 INVENTORY_OFF while the company has inventory turned off. */
export async function assertInventoryOn(executor: DbOrTx, tenantId: string, companyId: string | null | undefined): Promise<void> {
  if (!(await inventoryEnabled(executor, tenantId, companyId))) {
    throw AppError.badRequest('Inventory is turned off for this company. Turn it on in company settings first.', 'INVENTORY_OFF');
  }
}

const accountScope = (tenantId: string, companyId: string | null | undefined) => (companyId
  ? and(eq(accounts.tenantId, tenantId), or(isNull(accounts.companyId), eq(accounts.companyId, companyId)))
  : eq(accounts.tenantId, tenantId));

/**
 * Turning inventory on (U-156): adopts the company's inventory asset
 * account or makes one, and makes sure a COGS account exists. The asset
 * account is, in order: the account already tagged inventory_asset; the
 * active other-current-asset account named "Inventory Asset" (the oldest
 * when several carry the name); a new "Inventory Asset" account. It is
 * tagged inventory_asset (not a system account: the ACCOUNT_IN_USE guards
 * keep it in place). The COGS account: any active account of type cogs,
 * else a new "Cost of Goods Sold". Idempotent; runs in the settings
 * transaction with the company row locked.
 */
export async function ensureInventoryAccounts(tx: DbOrTx, tenantId: string, companyId: string, userId?: string) {
  const scope = accountScope(tenantId, companyId);
  let [asset] = await tx.select().from(accounts)
    .where(and(scope, eq(accounts.systemTag, INVENTORY_ASSET_TAG)))
    .orderBy(accounts.createdAt).limit(1);
  if (!asset) {
    const [adopt] = await tx.select().from(accounts)
      .where(and(scope, eq(accounts.isActive, true), eq(accounts.accountType, 'asset'), eq(accounts.detailType, 'other_current_asset'),
        isNull(accounts.systemTag), sql`lower(${accounts.name}) = lower(${INVENTORY_ASSET_NAME})`))
      .orderBy(accounts.createdAt, accounts.id).limit(1);
    if (adopt) {
      [asset] = await tx.update(accounts).set({ systemTag: INVENTORY_ASSET_TAG, updatedAt: new Date() })
        .where(and(eq(accounts.tenantId, tenantId), eq(accounts.id, adopt.id))).returning();
      await auditLog(tenantId, 'update', 'account', adopt.id, { systemTag: null }, { systemTag: INVENTORY_ASSET_TAG }, userId, tx);
    } else {
      [asset] = await tx.insert(accounts).values({
        tenantId, companyId, name: INVENTORY_ASSET_NAME, accountType: 'asset', detailType: 'other_current_asset',
        systemTag: INVENTORY_ASSET_TAG, isSystem: false,
      }).returning();
      if (asset) await auditLog(tenantId, 'create', 'account', asset.id, null, asset, userId, tx);
    }
  }
  let [cogs] = await tx.select().from(accounts)
    .where(and(scope, eq(accounts.isActive, true), eq(accounts.accountType, 'cogs')))
    .orderBy(accounts.createdAt, accounts.id).limit(1);
  if (!cogs) {
    [cogs] = await tx.insert(accounts).values({
      tenantId, companyId, name: DEFAULT_COGS_NAME, accountType: 'cogs', detailType: 'cost_of_goods_sold', isSystem: false,
    }).returning();
    if (cogs) await auditLog(tenantId, 'create', 'account', cogs.id, null, cogs, userId, tx);
  }
  return { assetAccountId: asset!.id, cogsAccountId: cogs!.id };
}

/**
 * Whether any part of the company still holds stock or value (U-25:
 * turning inventory off is 409 INVENTORY_IN_USE then). Reads the costing
 * ledger (U-157); before it exists no part can hold stock.
 */
export async function stockRemains(executor: DbOrTx, tenantId: string, companyId: string): Promise<boolean> {
  void executor; void tenantId; void companyId;
  return false;
}

/** Whether an item has any stock movement (U-157); before the costing ledger exists, none. */
export async function itemHasMovements(executor: DbOrTx, tenantId: string, itemId: string): Promise<boolean> {
  void executor; void tenantId; void itemId;
  return false;
}

/**
 * Inventory switch on a settings PUT (U-25, U-156): turning it on adopts or
 * makes the accounts; turning it off while stock or value remains is 409
 * INVENTORY_IN_USE. Runs in the settings transaction with the company row
 * locked.
 */
export async function applyInventorySwitch(
  tx: DbOrTx, tenantId: string, companyId: string, wasOn: boolean, updates: Record<string, unknown>, userId?: string,
): Promise<void> {
  const next = updates['inventoryEnabled'];
  if (next === true) {
    await ensureInventoryAccounts(tx, tenantId, companyId, userId);
  } else if (next === false && wasOn && await stockRemains(tx, tenantId, companyId)) {
    throw AppError.conflict('Some items still have stock or value. Adjust them to zero before turning inventory off.', 'INVENTORY_IN_USE');
  }
}

/** Read-only stock figures of a part (strings: quantity 4 places, average cost 6, value 2); null on other kinds. */
export interface StockFigures { quantityOnHand: string | null; averageCost: string | null; assetValue: string | null }

const NO_FIGURES: StockFigures = { quantityOnHand: null, averageCost: null, assetValue: null };
const ZERO_FIGURES: StockFigures = { quantityOnHand: '0.0000', averageCost: '0.000000', assetValue: '0.00' };

/**
 * Stock figures per item id, from the latest movement of each part (U-157).
 * Items are tenant-wide and stock is kept per company: `companyId` (the
 * request's company) picks whose stock; without it, the tenant's oldest
 * company's (where a posting without a company keeps its stock).
 */
export async function stockFigures(executor: DbOrTx, tenantId: string, rows: ReadonlyArray<{ id: string; itemType: string | null }>,
  companyId?: string | null): Promise<Map<string, StockFigures>> {
  void executor; void tenantId; void companyId;
  const out = new Map<string, StockFigures>();
  for (const r of rows) out.set(r.id, r.itemType === 'inventory_part' ? { ...ZERO_FIGURES } : { ...NO_FIGURES });
  return out;
}

/** Items with their stock figures, for the item routes. */
export async function withStockFigures<T extends { id: string; itemType: string | null }>(executor: DbOrTx, tenantId: string, rows: T[],
  companyId?: string | null): Promise<Array<T & StockFigures>> {
  const figures = await stockFigures(executor, tenantId, rows, companyId);
  return rows.map((r) => ({ ...r, ...(figures.get(r.id) ?? NO_FIGURES) }));
}

/**
 * Accounts the inventory needs kept (U-156, S12): the tagged inventory
 * asset account and every account a part names as its asset, COGS or
 * expense account, where the part is active or, inactive, still has stock
 * movements (its stock and history post there). Deactivating, deleting,
 * merging away or retyping one is 409 ACCOUNT_IN_USE.
 */
export async function assertAccountNotInventory(executor: DbOrTx, tenantId: string, accountIds: readonly string[]): Promise<void> {
  const ids = [...new Set(accountIds)];
  if (ids.length === 0) return;
  const tagged = await executor.select({ id: accounts.id }).from(accounts)
    .where(and(eq(accounts.tenantId, tenantId), inArray(accounts.id, ids), eq(accounts.systemTag, INVENTORY_ASSET_TAG))).limit(1);
  if (tagged.length > 0) {
    throw AppError.conflict('This is the inventory asset account. It stays active while inventory is in use.', 'ACCOUNT_IN_USE', { accountId: tagged[0]!.id });
  }
  const parts = await executor.select({ id: items.id, isActive: items.isActive }).from(items)
    .where(and(eq(items.tenantId, tenantId), eq(items.itemType, 'inventory_part'),
      or(inArray(items.assetAccountId, ids), inArray(items.cogsAccountId, ids), inArray(items.expenseAccountId, ids))))
    .orderBy(items.id);
  const used: string[] = [];
  for (const p of parts) {
    if (used.length >= 5) break;
    if (p.isActive !== false || await itemHasMovements(executor, tenantId, p.id)) used.push(p.id);
  }
  if (used.length > 0) {
    throw AppError.conflict('Inventory items post to this account (active items, or inactive items with stock history). Change their accounts first.',
      'ACCOUNT_IN_USE', { itemIds: used });
  }
}
