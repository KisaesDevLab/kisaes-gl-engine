// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { z } from 'zod';

// Inventory adjustments and physical counts (U-159, inventory-adjust-v1).
// Quantities are decimal strings in the item's base unit, at most 4 places;
// money is a decimal string with at most 2 places. Never JS numbers.

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'a date YYYY-MM-DD');
const MAX_LINES = 500;

/**
 * One line per item. quantityChange: signed, non-zero, |q| < 100,000,000.
 * valueChange: signed, non-zero money. At least one of the two. Quantity
 * only: the units go in or out at average cost. With a value: the value is
 * what the asset account moves (a value-only line needs stock on hand at
 * its date, 400 INVENTORY_NO_STOCK).
 */
export const inventoryAdjustmentLineSchema = z.object({
  itemId: z.string().uuid(),
  quantityChange: z.string().min(1).max(20).nullable().optional(),
  valueChange: z.string().min(1).max(20).nullable().optional(),
});

/** POST /inventory/adjustments, PUT /inventory/adjustments/:id. */
export const inventoryAdjustmentSchema = z.object({
  txnDate: isoDate,
  // The account the change is booked against (shrinkage, write-offs, ...):
  // an active account of the company that is not an inventory asset account.
  adjustmentAccountId: z.string().uuid(),
  memo: z.string().max(4000).optional(),
  lines: z.array(inventoryAdjustmentLineSchema).min(1).max(MAX_LINES),
  // PUT: updatedAt as last read (409 STALE when it no longer matches).
  expectedUpdatedAt: z.string().datetime({ offset: true }).optional(),
});

export const inventoryAdjustmentVoidSchema = z.object({
  reason: z.string().max(1000).optional(),
  expectedUpdatedAt: z.string().datetime({ offset: true }).optional(),
});

/** GET /inventory/count-sheet?asOf=YYYY-MM-DD (default today). */
export const inventoryCountSheetQuerySchema = z.object({
  asOf: isoDate.optional(),
});

/**
 * POST /inventory/counts: the counted quantities against the sheet's on hand.
 * Under the item locks the engine recomputes on hand as of asOf; any line
 * whose sheetOnHand no longer matches is 409 STALE (details.items). Lines
 * whose count equals on hand post nothing; the rest become one adjustment
 * dated asOf.
 */
export const inventoryCountSchema = z.object({
  asOf: isoDate,
  adjustmentAccountId: z.string().uuid(),
  memo: z.string().max(4000).optional(),
  lines: z.array(z.object({
    itemId: z.string().uuid(),
    sheetOnHand: z.string().min(1).max(20),
    countedQuantity: z.string().min(1).max(20),
  })).min(1).max(MAX_LINES),
});

/**
 * An inventory part's opening stock on item create (U-159, Q-P24h):
 * quantity above 0, value 0 or more (2 places), dated asOf; posted as an
 * inventory adjustment against the Opening Balances equity account.
 */
export const itemOpeningSchema = z.object({
  quantity: z.string().min(1).max(20),
  value: z.string().min(1).max(20),
  asOf: isoDate,
});

export type InventoryAdjustmentInput = z.infer<typeof inventoryAdjustmentSchema>;
export type InventoryCountInput = z.infer<typeof inventoryCountSchema>;
export type ItemOpeningInput = z.infer<typeof itemOpeningSchema>;
