// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { Router } from 'express';
import { createBankRuleSchema, updateBankRuleSchema } from '@kis-books/shared';
import { authenticate } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import * as bankRulesService from '../services/bank-rules.service.js';

export const bankRulesRouter = Router();
bankRulesRouter.use(authenticate);

bankRulesRouter.get('/', async (req, res) => {
  const rules = await bankRulesService.list(req.tenantId);
  res.json({ rules });
});

bankRulesRouter.post('/', validate(createBankRuleSchema), async (req, res) => {
  const rule = await bankRulesService.create(req.tenantId, req.body);
  res.status(201).json({ rule });
});

bankRulesRouter.get('/:id', async (req, res) => {
  const rule = await bankRulesService.getById(req.tenantId, req.params['id']!);
  res.json({ rule });
});

bankRulesRouter.put('/:id', validate(updateBankRuleSchema), async (req, res) => {
  const rule = await bankRulesService.update(req.tenantId, req.params['id']!, req.body);
  res.json({ rule });
});

bankRulesRouter.delete('/:id', async (req, res) => {
  await bankRulesService.remove(req.tenantId, req.params['id']!);
  res.json({ message: 'Rule deleted' });
});

bankRulesRouter.put('/reorder', async (req, res) => {
  await bankRulesService.reorder(req.tenantId, req.body.orderedIds);
  res.json({ message: 'Reordered' });
});

bankRulesRouter.post('/test', async (req, res) => {
  const result = await bankRulesService.evaluateRules(req.tenantId, {
    description: req.body.description,
    amount: parseFloat(req.body.amount),
  });
  res.json(result);
});

bankRulesRouter.post('/:id/submit-global', async (req, res) => {
  const user = await import('../services/auth.service.js').then((m) => m.getMe(req.userId));
  const submission = await bankRulesService.submitRuleForGlobal(
    req.userId, user.email, req.tenantId, req.params['id']!, req.body.note,
  );
  res.status(201).json({ submission });
});

bankRulesRouter.get('/global/list', async (req, res) => {
  const rules = await bankRulesService.listGlobal();
  res.json({ rules });
});
