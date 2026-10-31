// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../middleware/auth.js';
import { requireResource } from '../middleware/permission.js';
import { companyContext } from '../middleware/company.js';
import { validate } from '../middleware/validate.js';
import { describe } from '../middleware/describe.js';
import * as formsPrint from '../services/forms-print.service.js';
import { AppError } from '../utils/errors.js';

// Forms print queue (U-113, forms-print-queue-v1): invoices, cash sales and
// credit memos created or edited with printLater: true.
export const formsRouter = Router();
formsRouter.use(authenticate);
formsRouter.use(companyContext);
formsRouter.use(requireResource('invoices'));

const typeEnum = z.enum(formsPrint.PRINTABLE_FORM_TYPES);

formsRouter.get('/print-queue', describe({
  summary: 'Invoices, cash sales and credit memos waiting to be printed (forms-print-queue-v1)',
  query: z.object({ type: typeEnum.optional() }),
  response: z.object({
    data: z.array(z.object({
      id: z.string().uuid(),
      type: typeEnum,
      txnNumber: z.string().nullable(),
      txnDate: z.string(),
      contactName: z.string().nullable(),
      total: z.string().nullable().describe('decimal string'),
    })),
  }),
}), async (req, res) => {
  const type = req.query['type'];
  if (type !== undefined && !formsPrint.isPrintableFormType(type)) {
    throw AppError.badRequest('type must be invoice, cash_sale or credit_memo', 'VALIDATION_ERROR');
  }
  res.json({ data: await formsPrint.getQueue(req.tenantId, type as formsPrint.PrintableFormType | undefined, req.companyId) });
});

const markBody = z.object({ ids: z.array(z.string().uuid()).min(1).max(500) });
formsRouter.post('/mark-printed', validate(markBody), describe({
  summary: 'Clear the print-later mark of forms after printing; one audit row each (forms-print-queue-v1)',
  description: 'Every id must be an invoice, cash sale or credit memo of this company, else 404 and nothing changes. '
    + 'Each form taken out of the queue (posted) also gets a "printed" send event (invoice-sent-history-v1); a draft invoice becomes sent.',
  response: z.object({ marked: z.number().int(), alreadyPrinted: z.number().int() }),
}), async (req, res) => {
  res.json(await formsPrint.markPrinted(req.tenantId, req.body.ids, req.userId, req.companyId));
});
