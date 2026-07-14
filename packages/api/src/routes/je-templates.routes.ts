// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { Router } from 'express';
import {
  createJeTemplateSchema,
  updateJeTemplateSchema,
  replaceJeTemplateLinesSchema,
} from '@kis-books/shared';
import { authenticate } from '../middleware/auth.js';
import { requireResource } from '../middleware/permission.js';
import { companyContext } from '../middleware/company.js';
import { validate } from '../middleware/validate.js';
import * as service from '../services/je-templates.service.js';

export const jeTemplatesRouter = Router();
jeTemplatesRouter.use(authenticate);
jeTemplatesRouter.use(companyContext);
// Journal templates drive journal entries — gate on the transactions
// resource, same permission a user needs to post the resulting JE.
jeTemplatesRouter.use(requireResource('transactions'));

jeTemplatesRouter.get('/', async (req, res) => {
  res.json({ templates: await service.listTemplates(req.tenantId) });
});

jeTemplatesRouter.post('/', validate(createJeTemplateSchema), async (req, res) => {
  const template = await service.createTemplate(req.tenantId, req.body, req.userId, req.companyId);
  res.status(201).json({ template });
});

jeTemplatesRouter.get('/:id', async (req, res) => {
  res.json({ template: await service.getTemplate(req.tenantId, req.params['id']!) });
});

jeTemplatesRouter.put('/:id', validate(updateJeTemplateSchema), async (req, res) => {
  res.json({ template: await service.updateTemplate(req.tenantId, req.params['id']!, req.body, req.userId) });
});

jeTemplatesRouter.delete('/:id', async (req, res) => {
  await service.deleteTemplate(req.tenantId, req.params['id']!, req.userId);
  res.json({ deleted: true });
});

jeTemplatesRouter.put('/:id/lines', validate(replaceJeTemplateLinesSchema), async (req, res) => {
  const template = await service.replaceTemplateLines(req.tenantId, req.params['id']!, req.body.lines, req.userId);
  res.json({ template });
});
