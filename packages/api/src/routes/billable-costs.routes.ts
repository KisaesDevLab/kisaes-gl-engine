// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { Router } from 'express';
import { z } from 'zod';
import { billableCostFiltersSchema } from '@kis-books/shared';
import { authenticate } from '../middleware/auth.js';
import { requireResource } from '../middleware/permission.js';
import { companyContext } from '../middleware/company.js';
import { describe } from '../middleware/describe.js';
import { AppError } from '../utils/errors.js';
import * as billableCosts from '../services/billable-costs.service.js';

// Billable costs (U-128, billable-costs-v1). They are billed on invoices,
// so they share the invoices permission.
export const billableCostsRouter = Router();
billableCostsRouter.use(authenticate);
billableCostsRouter.use(companyContext);
billableCostsRouter.use(requireResource('invoices'));

const itemDoc = z.object({
  sourceLineId: z.string().uuid(),
  sourceTransactionId: z.string().uuid(),
  sourceTxnType: z.string(),
  sourceNumber: z.string().nullable(),
  sourceDate: z.string(),
  contactId: z.string().uuid().nullable(),
  vendorName: z.string().nullable(),
  description: z.string().nullable(),
  expenseAccountId: z.string().uuid(),
  itemId: z.string().uuid().nullable(),
  quantity: z.string().nullable(),
  unitCost: z.string().nullable(),
  sourceAmount: z.string().describe('the cost line\'s debit - credit, 4 places, signed'),
  costAmount: z.string().describe('round2(sourceAmount), half away from zero: what the invoice bills before markup'),
  suggestedIncomeAccountId: z.string().uuid().nullable(),
  suggestedIncomeAccountSource: z.enum(['item']).nullable(),
});

billableCostsRouter.get('/', describe({
  summary: 'List unbilled billable costs (billable-costs-v1)',
  description: 'The costs marked billable to a customer (check, expense, card charge or bill lines with isBillable and a line customer) that no invoice bills yet: '
    + 'posted sources of the request\'s company (or of none), contactId = the line customer, sorted by source date then sourceLineId. '
    + 'totalCount and totalAmount (the sum of costAmount, 2 places) are over every page. defaultMarkupPercent: the client\'s (contactId) suggested markup '
    + 'percent, or null. suggestedIncomeAccountId: the cost item\'s income account (source "item"), else null; a suggestion the client sends back as the '
    + 'invoice line\'s accountId. projectId is accepted and ignored until projects-v1. Bill a cost with an invoice line {billableSourceLineId, accountId, '
    + 'markupPercent?} on POST / PUT /invoices.',
  query: billableCostFiltersSchema,
  response: z.object({
    items: z.array(itemDoc), totalCount: z.number().int(), totalAmount: z.string(), defaultMarkupPercent: z.string().nullable(),
    limit: z.number().int(), offset: z.number().int(),
  }),
}), async (req, res) => {
  const parsed = billableCostFiltersSchema.safeParse(req.query);
  if (!parsed.success) throw AppError.badRequest(parsed.error.issues[0]?.message ?? 'Invalid query', 'VALIDATION_ERROR');
  res.json(await billableCosts.listBillableCosts(req.tenantId, parsed.data, req.companyId));
});
