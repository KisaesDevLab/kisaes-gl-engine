import { Router } from 'express';
import { createContactSchema, updateContactSchema, contactFiltersSchema, mergeContactsSchema } from '@kis-books/shared';
import { authenticate } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import * as contactsService from '../services/contacts.service.js';

export const contactsRouter = Router();
contactsRouter.use(authenticate);

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

contactsRouter.post('/import', async (req, res) => {
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

contactsRouter.get('/:id/transactions', async (req, res) => {
  const result = await contactsService.getTransactionHistory(req.tenantId, req.params['id']!, {
    limit: req.query['limit'] ? parseInt(req.query['limit'] as string) : 50,
    offset: req.query['offset'] ? parseInt(req.query['offset'] as string) : 0,
  });
  res.json(result);
});
