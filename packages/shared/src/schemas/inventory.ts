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
  // The unit quantityChange is in (U-161, units-of-measure-v1): a unit of the item's set; null = the base unit.
  unitId: z.string().uuid().nullable().optional(),
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
    // The unit countedQuantity is in (U-161); null = the base unit. sheetOnHand stays in the base unit.
    unitId: z.string().uuid().nullable().optional(),
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

// Units of measure (U-161, units-of-measure-v1, Q-P24i). A unit set has a
// base unit and other units, each a fixed factor = base units per unit
// (> 0, at most 6 places, at most 1,000,000). A unit named on a line keeps
// its factor and set (409 UNIT_IN_USE, Q-P24w); new units can be added.
const unitNameSchema = z.string().trim().min(1).max(30);
const unitAbbreviationSchema = z.string().trim().max(10).nullish();
export const unitFactorSchema = z.string().trim().regex(/^\d{1,7}(\.\d{1,6})?$/, 'A factor above 0 with at most 6 decimal places')
  .refine((v) => Number(v) > 0 && Number(v) <= 1_000_000, 'The factor must be above 0 and at most 1,000,000');
export const unitSetUnitSchema = z.object({
  // PUT: the id of a unit kept; omitted = a new unit.
  id: z.string().uuid().optional(),
  name: unitNameSchema,
  abbreviation: unitAbbreviationSchema,
  factor: unitFactorSchema,
});
export const createUnitSetSchema = z.object({
  name: z.string().trim().min(1).max(100),
  baseUnitName: unitNameSchema,
  baseUnitAbbreviation: unitAbbreviationSchema,
  units: z.array(unitSetUnitSchema).max(50).default([]),
});
export const updateUnitSetSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  baseUnitName: unitNameSchema.optional(),
  baseUnitAbbreviation: unitAbbreviationSchema,
  isActive: z.boolean().optional(),
  // The whole list of units: kept units by id, new ones without; a unit left out is removed.
  units: z.array(unitSetUnitSchema).max(50).optional(),
  expectedUpdatedAt: z.string().datetime({ offset: true }).optional(),
});
export type CreateUnitSetInput = z.infer<typeof createUnitSetSchema>;
export type UpdateUnitSetInput = z.infer<typeof updateUnitSetSchema>;

export type InventoryAdjustmentInput = z.infer<typeof inventoryAdjustmentSchema>;
export type InventoryCountInput = z.infer<typeof inventoryCountSchema>;
export type ItemOpeningInput = z.infer<typeof itemOpeningSchema>;
