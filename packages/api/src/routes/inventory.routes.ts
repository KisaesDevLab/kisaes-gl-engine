// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Inventory adjustments and physical counts (U-159, inventory-adjust-v1).
// Every write goes through the ledger core's costing hook, so adjustments
// are valued and re-walked like any other stock movement. Middleware order
// as the posting routers (bills.routes.ts): closing-password limiter and
// lock context, then Idempotency-Key, then validation. Permission: the
// items resource (inventory_adjustment maps to it, templates/permissions).

import { Router } from 'express';
import { z } from 'zod';
import {
  inventoryAdjustmentSchema, inventoryAdjustmentVoidSchema, inventoryCountSchema, inventoryCountSheetQuerySchema,
} from '@kis-books/shared';
import { authenticate } from '../middleware/auth.js';
import { requireResource } from '../middleware/permission.js';
import { companyContext } from '../middleware/company.js';
import { validate } from '../middleware/validate.js';
import { idempotent } from '../middleware/idempotent.js';
import { describe } from '../middleware/describe.js';
import { closingPasswordLimiter } from '../middleware/closing-password-limiter.js';
import { lockContextMiddleware } from '../services/lock-context.js';
import { db } from '../db/index.js';
import { AppError } from '../utils/errors.js';
import * as adjustments from '../services/inventory-adjustment.service.js';
import { resolveToday } from '../services/dashboard.service.js';
import { inventoryWarningsContext } from '../services/inventory-warnings-context.js';

export const inventoryRouter = Router();
inventoryRouter.use(authenticate);
inventoryRouter.use(companyContext);
inventoryRouter.use(requireResource('items'));
// NEGATIVE_STOCK warnings of the costing walk on the reply (U-158).
inventoryRouter.use(inventoryWarningsContext);

const idParams = z.object({ id: z.string().uuid() });
const uuidOr404 = (id: string | undefined) => {
  if (!id || !z.string().uuid().safeParse(id).success) throw AppError.notFound('Inventory adjustment not found');
  return id;
};

const rules = 'inventory-adjust-v1: one line per inventory item {itemId, quantityChange?, valueChange?} (at least one): quantityChange a signed, '
  + 'non-zero decimal string (at most 4 places, |q| < 100,000,000) in the item\'s base unit; valueChange signed money (at most 2 places). '
  + 'Quantity only: the units go in or out at average cost (the walk writes the asset / adjustment account pair, inventoryLines). With a value: '
  + 'the asset account moves by it; a value-only line needs the item on hand at its date (400 INVENTORY_NO_STOCK, Q-P24s). adjustmentAccountId: '
  + 'an active account of the company that is not an inventory asset account (400 VALIDATION_ERROR). Inventory off: 400 INVENTORY_OFF. Dated on '
  + 'or before the closing date (for an edit, the old or the new date): 409 INVENTORY_PERIOD_CLOSED, closingPassword or not. 409 RETRY after a '
  + 'deadlock or lock timeout (nothing saved). The reply\'s warnings[] carries NEGATIVE_STOCK {code, itemId, date, onHand} when an item\'s on hand '
  + 'newly went below 0. Record: {id, date, adjustmentAccountId, memo, status, updatedAt, lines: [{itemId, quantityChange, valueChange, value '
  + '(as costed), movementId}], inventoryLines: [{role, accountId, amount, movementId}]}. Units (units-of-measure-v1): a line may take unitId, the '
  + 'unit quantityChange is in (a unit of the item\'s set; null = base): stock moves by round4(quantityChange x factor) (400 UNIT_NOT_IN_SET, 400 '
  + 'UNIT_QUANTITY_TOO_SMALL); the record\'s lines add unitId and baseQuantityChange.';

const readAdjustment = (req: { tenantId: string; companyId?: string }, id: string) => adjustments.getAdjustment(db, req.tenantId, id, req.companyId);

inventoryRouter.post('/adjustments', closingPasswordLimiter, lockContextMiddleware, idempotent({
  successStatus: 201,
  replay: async (req, entity) => ({ adjustment: await readAdjustment(req, entity!.id) }),
}), validate(inventoryAdjustmentSchema), describe({
  summary: 'Adjust inventory quantities or values',
  description: `Response 201 {adjustment}. ${rules}`,
  body: inventoryAdjustmentSchema,
}), async (req, res) => {
  const t = await adjustments.postAdjustment(req.tenantId, req.companyId, req.body, req.userId);
  res.status(201).json({ adjustment: await readAdjustment(req, t.id) });
});

inventoryRouter.get('/adjustments/:id', describe({
  summary: 'Get an inventory adjustment',
  description: `Response {adjustment}. Of another company: 404. ${rules}`,
  params: idParams,
}), async (req, res) => {
  res.json({ adjustment: await readAdjustment(req, uuidOr404(req.params['id'])) });
});

inventoryRouter.put('/adjustments/:id', closingPasswordLimiter, lockContextMiddleware, idempotent({
  successStatus: 200,
  replay: async (req) => ({ adjustment: await readAdjustment(req, req.params['id']!) }),
}), validate(inventoryAdjustmentSchema), describe({
  summary: 'Edit an inventory adjustment',
  description: `Response {adjustment}. The row is locked; expectedUpdatedAt (updatedAt as last read) that no longer matches is 409 STALE. A void `
    + `adjustment is 400. ${rules}`,
  body: inventoryAdjustmentSchema,
  params: idParams,
}), async (req, res) => {
  res.json({ adjustment: await adjustments.updateAdjustment(req.tenantId, uuidOr404(req.params['id']), req.body, req.userId, req.companyId) });
});

inventoryRouter.post('/adjustments/:id/void', closingPasswordLimiter, lockContextMiddleware, idempotent({
  successStatus: 200,
  replay: async (req) => ({ adjustment: await readAdjustment(req, req.params['id']!) }),
}), validate(inventoryAdjustmentVoidSchema), describe({
  summary: 'Void an inventory adjustment',
  description: `Response {adjustment} (status void): its movements are voided and every later row re-walked; reversal lines mirror it. `
    + `expectedUpdatedAt mismatch is 409 STALE; already void 400. ${rules}`,
  body: inventoryAdjustmentVoidSchema,
  params: idParams,
}), async (req, res) => {
  const id = uuidOr404(req.params['id']);
  res.json({ adjustment: await adjustments.voidAdjustment(req.tenantId, id, req.body.reason ?? 'Voided', req.userId, {
    expectedUpdatedAt: req.body.expectedUpdatedAt, companyId: req.companyId,
  }) });
});

inventoryRouter.delete('/adjustments/:id', closingPasswordLimiter, lockContextMiddleware, idempotent({
  successStatus: 200,
  replay: async (req) => ({ id: req.params['id'], status: 'deleted' }),
}), (req, _res, next) => {
  if (!req.body || typeof req.body !== 'object') req.body = {};
  next();
}, validate(inventoryAdjustmentVoidSchema), describe({
  summary: 'Delete an inventory adjustment',
  description: `Response {id, status: deleted}: its movements are voided and every later row re-walked. expectedUpdatedAt mismatch is 409 STALE. ${rules}`,
  body: inventoryAdjustmentVoidSchema,
  params: idParams,
}), async (req, res) => {
  const id = uuidOr404(req.params['id']);
  const r = await adjustments.deleteAdjustment(req.tenantId, id, req.userId, { expectedUpdatedAt: req.body.expectedUpdatedAt, companyId: req.companyId,
    reason: req.body.reason });
  res.json({ id: r.id, status: r.status });
});

inventoryRouter.get('/count-sheet', describe({
  summary: 'The physical count sheet',
  description: 'inventory-adjust-v1: Response {asOf, items: [{itemId, name, description, unit, preferredVendor {id, name} | null, onHand '
    + '(4 places, base unit), value (2 places)}]} for every active inventory item of the company, by name; on hand and value as of asOf (default '
    + 'today), from the stock ledger. Send each onHand back as sheetOnHand with POST /inventory/counts. Inventory off: 400 INVENTORY_OFF. '
    + 'units-of-measure-v1: unit is the base unit name of an item with a unit set (else its unitLabel); items add unitSetId.',
  query: inventoryCountSheetQuerySchema,
}), async (req, res) => {
  const q = inventoryCountSheetQuerySchema.safeParse(req.query);
  if (!q.success) throw AppError.badRequest('asOf must be a date YYYY-MM-DD', 'VALIDATION_ERROR', { field: 'asOf' });
  // Default: the database's today (CURRENT_DATE, the engine's "today" as in dashboard.resolveToday), not Node's UTC date.
  const asOf = q.data.asOf ?? await resolveToday();
  res.json(await adjustments.countSheet(req.tenantId, asOf, req.companyId));
});

inventoryRouter.post('/counts', closingPasswordLimiter, lockContextMiddleware, idempotent({
  successStatus: 201,
  replay: async (req, entity) => ({ adjustment: entity?.type === 'transaction' ? await readAdjustment(req, entity.id) : null }),
}), validate(inventoryCountSchema), describe({
  summary: 'Post a physical count',
  description: 'inventory-adjust-v1 (Q-P24g): lines [{itemId, sheetOnHand (the sheet\'s onHand), countedQuantity (0 or more, at most 4 places)}]. '
    + 'Under the item locks the engine recomputes on hand as of asOf; when any line\'s sheetOnHand no longer matches it is 409 STALE with '
    + 'details.items [{itemId, sheetOnHand, onHand}] for every such line, and nothing is saved. Otherwise one adjustment dated asOf moves each '
    + 'item by countedQuantity - onHand at average cost (lines with no difference are left out): Response 201 {adjustment}; with no difference '
    + 'at all nothing is posted, Response 201 {adjustment: null}. asOf on or before the closing date: 409 INVENTORY_PERIOD_CLOSED. '
    + 'adjustmentAccountId as for adjustments. A line may take unitId (units-of-measure-v1): countedQuantity is in that unit of the item\'s set and '
    + 'counts as round4(countedQuantity x factor) base units (400 UNIT_NOT_IN_SET, 400 UNIT_QUANTITY_TOO_SMALL); sheetOnHand stays in the base unit.',
  body: inventoryCountSchema,
}), async (req, res) => {
  res.status(201).json(await adjustments.postCount(req.tenantId, req.body, req.userId, req.companyId));
});
