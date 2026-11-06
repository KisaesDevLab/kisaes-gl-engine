// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * Units of measure on document lines (U-161, units-of-measure-v1): the
 * ledger core's unit resolution (no service imports, so the ledger and the
 * costing core can use it without an import cycle). See units.service.ts.
 */

import { and, asc, eq, inArray } from 'drizzle-orm';
import type { DbOrTx } from '../db/index.js';
import { items, unitSetUnits } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import { Decimal, type Dec } from '../utils/inventory-walk.js';

/** round4 half away from zero (Q-P24v). */
const round4 = (v: Dec) => v.toDecimalPlaces(4, Decimal.ROUND_HALF_UP);

// ─── Lines (ledger core) ─────────────────────────────────────────────

/** A quantity in a unit as base units: round4(quantity x factor), half away from zero; 0 for a non-zero quantity is 400 UNIT_QUANTITY_TOO_SMALL. */
export function toBase(quantity: Dec, factor: Dec, lineIndex?: number): Dec {
  const base = round4(quantity.times(factor));
  if (base.isZero() && !quantity.isZero()) {
    throw AppError.badRequest(
      `${lineIndex === undefined ? 'The quantity' : `Line ${lineIndex + 1}: the quantity`} is too small for this unit: it is 0 in the base unit after rounding to 4 places.`,
      'UNIT_QUANTITY_TOO_SMALL', lineIndex === undefined ? undefined : { lineIndex },
    );
  }
  return base;
}

interface UnitLine { itemId?: string | null; unitId?: string | null; quantity?: string | null; baseQuantity?: string | null }

/**
 * Resolves the units of a posting's lines (U-161), before the costing lock:
 * each line naming a unitId needs an itemId whose unit set holds that unit
 * (400 UNIT_NOT_IN_SET; without an item 400 VALIDATION_ERROR); its
 * baseQuantity is set to round4(quantity x factor) (400
 * UNIT_QUANTITY_TOO_SMALL when that is 0). Lines without a unit carry no
 * baseQuantity (the base unit: quantity is base). The units named are
 * share-locked until commit (a unit-set edit waits for this posting).
 * Mutates and returns `lines`.
 */
export async function resolveLineUnits<L extends UnitLine>(executor: DbOrTx, tenantId: string, lines: L[]): Promise<L[]> {
  const withUnit = lines.filter((l) => !!l.unitId);
  for (const l of lines) if (!l.unitId) delete l.baseQuantity;
  if (withUnit.length === 0) return lines;
  const unitIds = [...new Set(withUnit.map((l) => l.unitId!))];
  const unitRows = await executor.select({ id: unitSetUnits.id, setId: unitSetUnits.unitSetId, factor: unitSetUnits.factor }).from(unitSetUnits)
    .where(and(eq(unitSetUnits.tenantId, tenantId), inArray(unitSetUnits.id, unitIds))).orderBy(asc(unitSetUnits.id)).for('share');
  const unitById = new Map(unitRows.map((u) => [u.id, u]));
  const itemIds = [...new Set(withUnit.map((l) => l.itemId).filter((v): v is string => !!v))];
  const itemRows = itemIds.length === 0 ? [] : await executor.select({ id: items.id, setId: items.unitSetId }).from(items)
    .where(and(eq(items.tenantId, tenantId), inArray(items.id, itemIds)));
  const setByItem = new Map(itemRows.map((i) => [i.id, i.setId]));
  lines.forEach((l, i) => {
    if (!l.unitId) return;
    if (!l.itemId) throw AppError.badRequest(`Line ${i + 1}: unitId needs an itemId`, 'VALIDATION_ERROR', { lineIndex: i, field: 'unitId' });
    const unit = unitById.get(l.unitId);
    const setId = setByItem.get(l.itemId);
    if (!unit || !setId || unit.setId !== setId) {
      throw AppError.badRequest(`Line ${i + 1}: unitId is not a unit of the item's unit set`, 'UNIT_NOT_IN_SET', { lineIndex: i, unitId: l.unitId });
    }
    const hasQty = l.quantity !== undefined && l.quantity !== null && l.quantity !== '';
    let q: Dec | null = null;
    try { q = hasQty ? new Decimal(String(l.quantity)) : null; } catch { q = null; }
    l.baseQuantity = q === null ? null : toBase(q, new Decimal(unit.factor), i).toFixed(4);
  });
  return lines;
}

/** OpenAPI note for every route whose item lines take unitId (units-of-measure-v1). */
export const UNIT_LINE_NOTE = 'Units of measure (units-of-measure-v1): an item line may take unitId, a unit of the item\'s unit set (GET /unit-sets; '
  + 'null or omitted = the base unit). quantity and unitPrice are in that unit and the amount stays round2(quantity x unitPrice); the engine stores '
  + 'baseQuantity = round4(quantity x factor), half away from zero, which stock, costing and reports use. A unit outside the item\'s set is 400 '
  + 'UNIT_NOT_IN_SET; unitId without itemId is 400 VALIDATION_ERROR; a quantity that is 0 in the base unit after rounding is 400 '
  + 'UNIT_QUANTITY_TOO_SMALL. Lines come back with unitId and baseQuantity.';
