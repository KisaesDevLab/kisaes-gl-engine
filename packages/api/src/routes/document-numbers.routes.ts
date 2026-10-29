// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../middleware/auth.js';
import { requirePermission, requireResource } from '../middleware/permission.js';
import { companyContext } from '../middleware/company.js';
import { validate } from '../middleware/validate.js';
import { describe } from '../middleware/describe.js';
import * as documentNumbers from '../services/document-number.service.js';
import { AppError } from '../utils/errors.js';

// Document numbering per company (U-111, document-numbers-v1): invoice,
// cash_sale, credit_memo and statement each have a prefix and a next number.
// Invoices, cash sales and credit memos take the next number when created
// without a txnNumber; a statement takes one with POST /claim.
export const documentNumbersRouter = Router();
documentNumbersRouter.use(authenticate);
documentNumbersRouter.use(companyContext);
documentNumbersRouter.use(requireResource('invoices'));

const typeEnum = z.enum(documentNumbers.DOCUMENT_NUMBER_TYPES);
const settingDoc = z.object({
  type: typeEnum,
  prefix: z.string(),
  nextNumber: z.number().int(),
  next: z.string().describe('prefix + nextNumber: what the next document gets'),
});

function parseType(raw: unknown): documentNumbers.DocumentNumberType {
  if (!documentNumbers.isDocumentNumberType(raw)) {
    throw AppError.badRequest(`type must be one of ${documentNumbers.DOCUMENT_NUMBER_TYPES.join(', ')}`, 'VALIDATION_ERROR');
  }
  return raw;
}

documentNumbersRouter.get('/', describe({
  summary: 'Prefix and next number of every document type for the company (document-numbers-v1)',
  response: z.object({ numbers: z.array(settingDoc) }),
}), async (req, res) => {
  res.json({ numbers: await documentNumbers.list(req.tenantId, req.companyId) });
});

documentNumbersRouter.get('/next', describe({
  summary: 'The number the next document of a type would get; nothing is taken (document-numbers-v1)',
  query: z.object({ type: typeEnum }),
  response: settingDoc,
}), async (req, res) => {
  res.json(await documentNumbers.peek(req.tenantId, parseType(req.query['type']), req.companyId));
});

const claimBody = z.object({ type: typeEnum });
documentNumbersRouter.post('/claim', validate(claimBody), describe({
  summary: 'Take the next number of a type (statements, which have no create route) (document-numbers-v1)',
  response: z.object({ type: typeEnum, number: z.number().int(), txnNumber: z.string() }),
}), async (req, res) => {
  res.status(201).json(await documentNumbers.claim(req.tenantId, req.body.type, req.companyId));
});

const updateBody = z.object({
  prefix: z.string().max(20).regex(/^[^\s]*$/, 'No spaces').optional(),
  nextNumber: z.number().int().min(1).max(999_999_999).optional(),
}).refine((b) => b.prefix !== undefined || b.nextNumber !== undefined, { message: 'Send prefix or nextNumber' });

documentNumbersRouter.put('/:type', requirePermission('company_settings', 'update'), validate(updateBody), describe({
  summary: 'Set the prefix and/or next number of a document type for the company (document-numbers-v1)',
  description: 'Invoices write the company invoicePrefix / invoiceNextNumber; the other types companies.document_numbers.',
  params: z.object({ type: typeEnum }),
  response: settingDoc,
}), async (req, res) => {
  res.json(await documentNumbers.update(req.tenantId, parseType(req.params['type']), req.body, req.companyId));
});
