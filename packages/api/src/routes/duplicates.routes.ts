// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../middleware/auth.js';
import { requireResource } from '../middleware/permission.js';
import { validate } from '../middleware/validate.js';
import * as duplicateService from '../services/duplicate-detection.service.js';

export const duplicatesRouter = Router();
duplicatesRouter.use(authenticate);
duplicatesRouter.use(requireResource('duplicates'));

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');
const rangeSchema = z.object({ startDate: isoDate, endDate: isoDate })
  .refine((r) => r.startDate <= r.endDate, { message: 'startDate must not be after endDate' });

function defaultRange() {
  const end = new Date();
  const start = new Date(end);
  start.setMonth(start.getMonth() - 3);
  return { startDate: start.toISOString().split('T')[0]!, endDate: end.toISOString().split('T')[0]! };
}

// Response shape: { pairs: DuplicatePair[], count, limit } — nested a/b
// transactions (see duplicate-detection.service). The Duplicates page
// reads `pairs`; `limit` lets it say when the scan was capped.
async function respondScan(req: { tenantId: string }, res: { json: (b: unknown) => void }, range: { startDate: string; endDate: string }) {
  const pairs = await duplicateService.scanDateRange(req.tenantId, range.startDate, range.endDate);
  res.json({ pairs, count: pairs.length, limit: duplicateService.SCAN_LIMIT, ...range });
}

duplicatesRouter.get('/', async (req, res) => {
  const d = defaultRange();
  const range = rangeSchema.parse({
    startDate: (req.query['start_date'] as string | undefined) || d.startDate,
    endDate: (req.query['end_date'] as string | undefined) || d.endDate,
  });
  await respondScan(req, res, range);
});

duplicatesRouter.post('/scan', validate(rangeSchema), async (req, res) => {
  await respondScan(req, res, req.body);
});

duplicatesRouter.get('/for-transaction/:id', async (req, res) => {
  const duplicates = await duplicateService.findDuplicates(req.tenantId, req.params['id']!);
  res.json({ duplicates });
});

duplicatesRouter.post('/:idA/dismiss/:idB', async (req, res) => {
  await duplicateService.dismissDuplicate(req.tenantId, req.params['idA']!, req.params['idB']!, req.userId);
  res.json({ message: 'Dismissed' });
});

const mergeSchema = z.object({ keepId: z.string().uuid(), voidId: z.string().uuid() })
  .refine((b) => b.keepId !== b.voidId, { message: 'keepId and voidId must differ' });

duplicatesRouter.post('/merge', validate(mergeSchema), async (req, res) => {
  await duplicateService.mergeDuplicate(req.tenantId, req.body.keepId, req.body.voidId, req.userId);
  res.json({ message: 'Merged' });
});
