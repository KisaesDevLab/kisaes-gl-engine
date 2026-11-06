// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Inventory reports (U-160, inventory-reports-v1) and the reorder report
// (U-78, reorder-alerts-v1), mounted under /api/v1/reports before the
// reports router. Read-only; the reports resource. Figures come from the
// stock ledger (inventory_movements) as decimal strings.

import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../middleware/auth.js';
import { requireResource } from '../middleware/permission.js';
import { companyContext } from '../middleware/company.js';
import { describe } from '../middleware/describe.js';
import { AppError } from '../utils/errors.js';
import * as inventoryReports from '../services/inventory-report.service.js';
import { resolveToday } from '../services/dashboard.service.js';

export const inventoryReportsRouter = Router();
inventoryReportsRouter.use(authenticate);
inventoryReportsRouter.use(companyContext);
inventoryReportsRouter.use(requireResource('reports'));

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'a date YYYY-MM-DD');
// The engine's today: the database's CURRENT_DATE (dashboard.resolveToday), not Node's UTC date.
const today = () => resolveToday();
function parse<T extends z.ZodTypeAny>(schema: T, query: unknown): z.infer<T> {
  const q = schema.safeParse(query);
  if (!q.success) {
    const issue = q.error.issues[0];
    throw AppError.badRequest(issue ? `${issue.path.join('.') || 'query'}: ${issue.message}` : 'invalid query', 'VALIDATION_ERROR',
      issue ? { field: issue.path.join('.') } : undefined);
  }
  return q.data;
}

const common = 'Inventory off for the company: 400 INVENTORY_OFF. A bad query is 400 VALIDATION_ERROR. Quantities are 4-place strings in each '
  + 'item\'s base unit, money 2-place strings, average cost 6-place strings (value / on hand while on hand is above 0, else the last positive average).';

const valuationQuery = z.object({ asOf: isoDate.optional() });
inventoryReportsRouter.get('/inventory-valuation', describe({
  summary: 'Inventory valuation summary (inventory-reports-v1)',
  description: 'Response {title, asOf, basis: accrual, rows: [{itemId, name, description, assetAccountId, unitLabel, onHand, averageCost, value, '
    + 'percentOfTotal (2 places, null when the total is 0)}], accounts: [{accountId, name, valuation, glBalance, difference}], totalValue, '
    + 'basisNote}. On hand and value as of asOf (default today) are the running figures of each inventory item\'s latest movement dated on or '
    + 'before it; rows list active items and inactive ones still holding stock or value, by name. accounts: every inventory asset account '
    + '(tagged inventory_asset or named by an item): valuation = the sum of its items\' values, glBalance = its accrual balance from posted '
    + 'lines dated on or before asOf, difference = glBalance - valuation ("0.00" unless a journal entry posted to the account directly). '
    + `basisNote: a note string on cash-basis companies (the figures stay accrual), else null. ${common}`,
  query: valuationQuery,
}), async (req, res) => {
  const q = parse(valuationQuery, req.query);
  res.json(await inventoryReports.valuationSummary(req.tenantId, q.asOf ?? await today(), req.companyId));
});

const detailQuery = z.object({
  from: isoDate, to: isoDate, itemId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(5000).optional(), offset: z.coerce.number().int().min(0).optional(),
});
inventoryReportsRouter.get('/inventory-valuation-detail', describe({
  summary: 'Inventory valuation detail (inventory-reports-v1)',
  description: 'Response {title, from, to, itemId, opening: [{itemId, onHand, value}], data: [{movementId, itemId, date, transactionId, txnType, '
    + 'txnNumber, kind (receipt | sale | customer_return | vendor_return | adjust_qty | adjust_value), quantity (signed), value, movementValue, '
    + 'correction, residual, runningQuantity, runningValue, averageCost}], total}. Every stock movement dated from..to (both required, to '
    + 'before from is 400 VALIDATION_ERROR) of every inventory item, or of itemId (not an inventory item of this company: 404), in posting '
    + 'order (date, the document\'s entry time, its id). value is the row\'s whole effect on the asset account (movementValue + correction + '
    + 'residual), so runningValue = the previous row\'s runningValue + value. opening: each item\'s on hand and value just before from. '
    + `limit (1-5000) and offset page the rows; total counts them all. ${common}`,
  query: detailQuery,
}), async (req, res) => {
  const q = parse(detailQuery, req.query);
  res.json(await inventoryReports.valuationDetail(req.tenantId, q, req.companyId));
});

const statusQuery = z.object({ asOf: isoDate.optional() });
const statusRow = '{itemId, name, description, unitLabel, preferredVendorId, preferredVendor {id, name} | null, reorderPoint, reorderQuantity, '
  + 'onHand, value, reorder}';
inventoryReportsRouter.get('/inventory-stock-status', describe({
  summary: 'Inventory stock status (inventory-reports-v1)',
  description: `Response {title, asOf, data: [${statusRow}]}: every active inventory item by name with on hand as of asOf (default today); `
    + `reorder is true when the item has a reorder point and on hand is at or below it. ${common}`,
  query: statusQuery,
}), async (req, res) => {
  const q = parse(statusQuery, req.query);
  res.json(await inventoryReports.stockStatus(req.tenantId, q.asOf ?? await today(), req.companyId));
});

inventoryReportsRouter.get('/reorder', describe({
  summary: 'Items to reorder (reorder-alerts-v1)',
  description: `Response {title, asOf, data: [${statusRow}]}: the active inventory items with a reorder point whose on hand now (every date) `
    + 'is at or below it, by name, with reorderQuantity (how many to order, base unit) and the preferred vendor. The same rows as GET '
    + `/items/reorder-alerts. ${common}`,
}), async (req, res) => {
  res.json(await inventoryReports.reorderReport(req.tenantId, req.companyId));
});
