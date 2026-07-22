// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { Router } from 'express';
import { createContactSchema, updateContactSchema, contactFiltersSchema, mergeContactsSchema, contactsImportSchema, bulkUpdateContactTypeSchema } from '@kis-books/shared';
import { authenticate } from '../middleware/auth.js';
import { requireResource } from '../middleware/permission.js';
import { validate } from '../middleware/validate.js';
import * as contactsService from '../services/contacts.service.js';
import * as batchService from '../services/batch.service.js';
import { parseLimit, parseOffset } from '../utils/pagination.js';

export const contactsRouter = Router();
contactsRouter.use(authenticate);
contactsRouter.use(requireResource('contacts'));

contactsRouter.get('/', async (req, res) => {
  const filters = contactFiltersSchema.parse(req.query);
  const result = await contactsService.list(req.tenantId, filters);
  res.json(result);
});

contactsRouter.post('/', validate(createContactSchema), async (req, res) => {
  const contact = await contactsService.create(req.tenantId, req.body, req.userId);
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

contactsRouter.post('/merge', validate(mergeContactsSchema), async (req, res) => {
  const result = await contactsService.merge(req.tenantId, req.body.sourceId, req.body.targetId, req.userId);
  res.json({ contact: result });
});

// Bulk-change the customer/vendor/both type on the selected contacts. Placed
// before /:id so the literal path wins over the param route.
contactsRouter.post('/bulk-type', validate(bulkUpdateContactTypeSchema), async (req, res) => {
  const result = await contactsService.bulkUpdateType(req.tenantId, req.body.ids, req.body.contactType, req.userId);
  res.json(result);
});

contactsRouter.get('/:id', async (req, res) => {
  const contact = await contactsService.getById(req.tenantId, req.params['id']!);
  res.json({ contact });
});

contactsRouter.put('/:id', validate(updateContactSchema), async (req, res) => {
  const contact = await contactsService.update(req.tenantId, req.params['id']!, req.body, req.userId);
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

contactsRouter.get('/:id/transactions', async (req, res) => {
  const result = await contactsService.getTransactionHistory(req.tenantId, req.params['id']!, {
    limit: parseLimit(req.query['limit']),
    offset: parseOffset(req.query['offset']),
  });
  res.json(result);
});
