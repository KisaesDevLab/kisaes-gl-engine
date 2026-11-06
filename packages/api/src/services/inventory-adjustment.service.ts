// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * Inventory adjustments (U-157 core; U-159 adds the routes, counts and the
 * opening quantity). An adjustment is a transaction of type
 * inventory_adjustment posted through the ledger core, so the costing walk
 * values it like any other movement:
 * - with a valueChange: Dr/Cr the part's inventory asset account (the part
 *   line, with the quantity change if any) vs the adjustment account; the
 *   movement's value is given.
 * - quantity only: one part line on the adjustment account with the signed
 *   quantity and no amount; the walk values it at average cost and writes
 *   the derived pair (inventory_relief on the asset account, cogs on the
 *   adjustment account).
 */

import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import { items } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import * as ledger from './ledger.service.js';
import { Decimal } from '../utils/inventory-walk.js';

export interface AdjustmentLineInput { itemId: string; quantityChange?: string | null; valueChange?: string | null }
export interface AdjustmentInput { txnDate: string; adjustmentAccountId: string; memo?: string; lines: AdjustmentLineInput[] }

// Signed quantity change: non-zero, |q| < 100,000,000, at most 4 places.
const QTY_CHANGE_RE = /^-?\d{1,8}(\.\d{1,4})?$/;
// Signed money: at most 2 places, below the money column.
const VALUE_CHANGE_RE = /^-?\d{1,15}(\.\d{1,2})?$/;

/** A signed, non-zero quantity change (U-159): 400 VALIDATION_ERROR otherwise. */
export function parseQuantityChange(value: unknown, field: string): InstanceType<typeof Decimal> {
  const s = typeof value === 'string' ? value.trim() : '';
  if (!QTY_CHANGE_RE.test(s) || new Decimal(s).isZero()) {
    throw AppError.badRequest(`${field} must be a non-zero quantity change below 100,000,000 with at most 4 decimal places`, 'VALIDATION_ERROR');
  }
  return new Decimal(s);
}

function parseValueChange(value: unknown, field: string): InstanceType<typeof Decimal> {
  const s = typeof value === 'string' ? value.trim() : '';
  if (!VALUE_CHANGE_RE.test(s) || new Decimal(s).isZero()) {
    throw AppError.badRequest(`${field} must be a non-zero amount with at most 2 decimal places`, 'VALIDATION_ERROR');
  }
  return new Decimal(s);
}

/** Posts an inventory adjustment (one line per part) through the ledger core. */
export async function postAdjustment(tenantId: string, companyId: string | undefined, input: AdjustmentInput, userId?: string) {
  if (input.lines.length === 0) throw AppError.badRequest('An adjustment needs at least one line', 'VALIDATION_ERROR');
  const ids = [...new Set(input.lines.map((l) => l.itemId))];
  if (ids.length !== input.lines.length) throw AppError.badRequest('One line per item', 'VALIDATION_ERROR');
  const parts = await db.select({ id: items.id, assetAccountId: items.assetAccountId, itemType: items.itemType }).from(items)
    .where(and(eq(items.tenantId, tenantId), inArray(items.id, ids)));
  const byId = new Map(parts.map((p) => [p.id, p]));
  const lines: Array<{ accountId: string; itemId?: string; quantity?: string; debit: string; credit: string }> = [];
  input.lines.forEach((l, i) => {
    const part = byId.get(l.itemId);
    if (!part || part.itemType !== 'inventory_part' || !part.assetAccountId) {
      throw AppError.badRequest(`lines[${i}].itemId is not an inventory item of this company`, 'VALIDATION_ERROR');
    }
    const hasQty = l.quantityChange !== undefined && l.quantityChange !== null && l.quantityChange !== '';
    const hasValue = l.valueChange !== undefined && l.valueChange !== null && l.valueChange !== '';
    if (!hasQty && !hasValue) throw AppError.badRequest(`lines[${i}] needs a quantityChange or a valueChange`, 'VALIDATION_ERROR');
    const qty = hasQty ? parseQuantityChange(l.quantityChange, `lines[${i}].quantityChange`).toFixed() : undefined;
    if (hasValue) {
      const v = parseValueChange(l.valueChange, `lines[${i}].valueChange`);
      const amt = v.abs().toFixed(2);
      const up = v.greaterThan(0);
      lines.push({ accountId: part.assetAccountId, itemId: part.id, ...(qty ? { quantity: qty } : {}), debit: up ? amt : '0', credit: up ? '0' : amt });
      lines.push({ accountId: input.adjustmentAccountId, debit: up ? '0' : amt, credit: up ? amt : '0' });
    } else {
      lines.push({ accountId: input.adjustmentAccountId, itemId: part.id, quantity: qty!, debit: '0', credit: '0' });
    }
  });
  return ledger.postTransaction(tenantId, {
    txnType: 'inventory_adjustment', txnDate: input.txnDate, memo: input.memo, lines,
  } as never, userId, companyId);
}
