// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { Router } from 'express';
import { z } from 'zod';
import { createContactSchema, updateContactSchema, contactFiltersSchema, mergeContactsSchema, contactsImportSchema, bulkUpdateContactTypeSchema } from '@kis-books/shared';
import { authenticate } from '../middleware/auth.js';
import { requireResource } from '../middleware/permission.js';
import { companyContext } from '../middleware/company.js';
import { validate } from '../middleware/validate.js';
import { idempotent } from '../middleware/idempotent.js';
import * as contactsService from '../services/contacts.service.js';
import * as batchService from '../services/batch.service.js';
import * as checkPdfService from '../services/check-pdf.service.js';
import { parseLimit, parseOffset } from '../utils/pagination.js';
import { describe } from '../middleware/describe.js';
import { closingPasswordLimiter } from '../middleware/closing-password-limiter.js';
import { lockContextMiddleware } from '../services/lock-context.js';

export const contactsRouter = Router();
contactsRouter.use(authenticate);
contactsRouter.use(requireResource('contacts'));

const balanceDoc = 'Each contact carries its open balances (contact-balance-v1): openBalance (A/R: posted lines on the receivable account named for the contact, '
  + 'invoices less payments and credits) and oldestOpenDate (oldest posted invoice with a balance due), payableBalance and oldestOpenBillDate (A/P, bills). '
  + 'Money as 4-place decimal strings; void and deleted transactions are out; the request company (X-Company-Id) and rows without a company.';

contactsRouter.get('/', companyContext, describe({
  summary: 'List contacts',
  description: balanceDoc,
  query: contactFiltersSchema,
}), async (req, res) => {
  const filters = contactFiltersSchema.parse(req.query);
  const result = await contactsService.list(req.tenantId, filters, req.companyId);
  res.json(result);
});

// Idempotency-Key (idempotency-v1, U-18).
contactsRouter.post('/', idempotent({
  successStatus: 201,
  replay: async (req, entity) => ({ contact: await contactsService.getById(req.tenantId, entity!.id) }),
}), validate(createContactSchema), async (req, res) => {
  const contact = await contactsService.create(req.tenantId, req.body, req.userId, req.companyId);
  res.status(201).json({ contact });
});

contactsRouter.get('/export', async (req, res) => {
  const csv = await contactsService.exportToCsv(req.tenantId, req.query['contactType'] as string | undefined);
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="contacts.csv"');
  res.send(csv);
});

contactsRouter.post('/import', validate(contactsImportSchema), async (req, res) => {
  const result = await contactsService.importFromCsv(
    req.tenantId,
    req.body.contacts,
    req.body.contactType || 'customer',
    req.userId,
  );
  res.status(201).json({ imported: result.length, contacts: result });
});

// A merge repoints the duplicate's transactions of every date. When one is
// dated on or before the closing date it is a closed-period edit (U-47,
// merge-closing-date-v1): 423 TB_PERIOD_LOCKED without `closingPassword`,
// 403 CLOSING_PASSWORD_INVALID when wrong (rate limited, 429); nothing
// changes either way.
const mergeContactsBodyDoc = mergeContactsSchema.extend({
  closingPassword: z.string().optional().describe('closing-date password (closing-password-v1); needed when a moved transaction is in a closed period; never stored or echoed'),
});

contactsRouter.post('/merge', closingPasswordLimiter, lockContextMiddleware, validate(mergeContactsSchema), describe({
  summary: 'Merge a duplicate contact into another (closing date enforced; merge-closing-date-v1)',
  body: mergeContactsBodyDoc,
}), async (req, res) => {
  const result = await contactsService.merge(req.tenantId, req.body.sourceId, req.body.targetId, req.userId);
  res.json({ contact: result });
});

// Bulk-change the customer/vendor/both type on the selected contacts. Placed
// before /:id so the literal path wins over the param route.
contactsRouter.post('/bulk-type', validate(bulkUpdateContactTypeSchema), async (req, res) => {
  const result = await contactsService.bulkUpdateType(req.tenantId, req.body.ids, req.body.contactType, req.userId);
  res.json(result);
});

contactsRouter.get('/:id', companyContext, describe({
  summary: 'Get a contact',
  description: balanceDoc,
  params: z.object({ id: z.string().uuid() }),
}), async (req, res) => {
  const contact = await contactsService.getWithBalance(req.tenantId, req.params['id']!, req.companyId);
  res.json({ contact });
});

contactsRouter.put('/:id', validate(updateContactSchema), async (req, res) => {
  const contact = await contactsService.update(req.tenantId, req.params['id']!, req.body, req.userId, req.companyId);
  res.json({ contact });
});

contactsRouter.delete('/:id', async (req, res) => {
  const contact = await contactsService.deactivate(req.tenantId, req.params['id']!, req.userId);
  res.json({ contact });
});

// Category autofill for entry forms: the account to prefill when this contact
// is selected — the contact's configured default, else the category account
// from its most recent transaction. Delegates to the SHARED resolver that
// batch-entry and the bank feed also use, so behavior stays identical across
// surfaces. Read-only; rides the `contacts` permission. Returns
// { accountId: string | null, source: 'default' | 'recent' | null }.
contactsRouter.get('/:id/suggest-account', async (req, res) => {
  const result = await batchService.suggestAccountForContact(req.tenantId, req.params['id']!);
  res.json(result);
});

// #10 envelope PDF addressed to this contact: company return address
// top-left, contact mailing address in the USPS read zone. Same renderer
// as the check-batch envelopes (POST /checks/envelopes).
contactsRouter.get('/:id/envelope', async (req, res) => {
  const pdf = await checkPdfService.generateContactEnvelopePdf(req.tenantId, req.params['id']!);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'inline; filename="envelope.pdf"');
  res.send(pdf);
});

// companyContext scopes the history to the active company (X-Company-Id),
// matching what the Transactions page shows for the same payee.
contactsRouter.get('/:id/transactions', companyContext, async (req, res) => {
  const result = await contactsService.getTransactionHistory(req.tenantId, req.params['id']!, {
    limit: parseLimit(req.query['limit']),
    offset: parseOffset(req.query['offset']),
  }, req.companyId);
  res.json(result);
});
