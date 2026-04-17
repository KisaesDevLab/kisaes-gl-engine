// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { Router } from 'express';
import { createAccountSchema, updateAccountSchema, accountFiltersSchema, mergeAccountsSchema } from '@kis-books/shared';
import { authenticate } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import * as accountsService from '../services/accounts.service.js';
import * as registerService from '../services/register.service.js';
import { parseLimit, parseOffset } from '../utils/pagination.js';

export const accountsRouter = Router();
accountsRouter.use(authenticate);

accountsRouter.get('/', async (req, res) => {
  const filters = accountFiltersSchema.parse(req.query);
  const result = await accountsService.list(req.tenantId, filters);
  res.json(result);
});

accountsRouter.post('/', validate(createAccountSchema), async (req, res) => {
  const account = await accountsService.create(req.tenantId, req.body, req.userId);
  res.status(201).json({ account });
});

accountsRouter.get('/export', async (req, res) => {
  const csv = await accountsService.exportToCsv(req.tenantId);
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="chart-of-accounts.csv"');
  res.send(csv);
});

accountsRouter.post('/import', async (req, res) => {
  const result = await accountsService.importFromCsv(req.tenantId, req.body.accounts, req.userId);
  res.status(201).json({ imported: result.length, accounts: result });
});

accountsRouter.post('/merge', validate(mergeAccountsSchema), async (req, res) => {
  const result = await accountsService.merge(req.tenantId, req.body.sourceId, req.body.targetId, req.userId);
  res.json({ account: result });
});

accountsRouter.get('/:id', async (req, res) => {
  const account = await accountsService.getById(req.tenantId, req.params['id']!);
  res.json({ account });
});

accountsRouter.put('/:id', validate(updateAccountSchema), async (req, res) => {
  const account = await accountsService.update(req.tenantId, req.params['id']!, req.body, req.userId);
  res.json({ account });
});

accountsRouter.delete('/:id', async (req, res) => {
  const account = await accountsService.deactivate(req.tenantId, req.params['id']!, req.userId);
  res.json({ account });
});

accountsRouter.get('/:id/ledger', async (req, res) => {
  const result = await accountsService.getAccountLedger(req.tenantId, req.params['id']!, {
    limit: parseLimit(req.query['limit']),
    offset: parseOffset(req.query['offset']),
  });
  res.json(result);
});

accountsRouter.get('/:id/register', async (req, res) => {
  const q = req.query as Record<string, string>;
  const result = await registerService.getRegister(req.tenantId, req.params['id']!, {
    startDate: q['start_date'],
    endDate: q['end_date'],
    txnType: q['txn_type'],
    payee: q['payee'],
    search: q['search'],
    reconciled: q['reconciled'] as any,
    minAmount: q['min_amount'] ? parseFloat(q['min_amount']) : undefined,
    maxAmount: q['max_amount'] ? parseFloat(q['max_amount']) : undefined,
    includeVoid: q['include_void'] === 'true',
    sortBy: q['sort_by'] as any,
    sortDir: q['sort_dir'] as any,
    page: q['page'] ? parseInt(q['page']) : undefined,
    perPage: q['per_page'] ? parseInt(q['per_page']) : undefined,
  });
  res.json(result);
});

accountsRouter.get('/:id/register/summary', async (req, res) => {
  const result = await registerService.getRegisterSummary(req.tenantId, req.params['id']!);
  res.json(result);
});
