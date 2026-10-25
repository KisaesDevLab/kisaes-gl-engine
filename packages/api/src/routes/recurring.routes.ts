// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../middleware/auth.js';
import { requireResource } from '../middleware/permission.js';
import { validate } from '../middleware/validate.js';
import * as recurringService from '../services/recurring.service.js';
import * as occurrences from '../services/templates/occurrences.service.js';
import { companyContext } from '../middleware/company.js';
import { describe } from '../middleware/describe.js';
import { runDueSchema } from '@kis-books/shared';
import { pickEnum } from '../utils/list-query.js';

// Explicit field allowlists — the previous `{...req.body}` spread into
// .set() let a caller write tenantId/companyId/nextOccurrence/lastPostedAt/
// isActive directly (a schedule moved to another tenant would then post
// transactions there).
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const frequency = z.enum(['daily', 'weekly', 'biweekly', 'semimonthly', 'monthly', 'quarterly', 'annually']);
const mode = z.enum(['auto', 'reminder']);
export const createScheduleSchema = z.object({
  templateTransactionId: z.string().uuid(),
  name: z.string().trim().max(255).nullable().optional(),
  frequency,
  intervalValue: z.number().int().min(1).max(365).optional(),
  mode: mode.optional(),
  startDate: isoDate,
  endDate: isoDate.nullable().optional(),
}).strict();
export const updateScheduleSchema = z.object({
  name: z.string().trim().max(255).nullable().optional(),
  frequency: frequency.optional(),
  intervalValue: z.number().int().min(1).max(365).optional(),
  mode: mode.optional(),
  startDate: isoDate.optional(),
  endDate: isoDate.nullable().optional(),
  // Optimistic concurrency (U-66, recurring-guard-v1): the schedule's
  // updatedAt as last read. A mismatch is 409 STALE_SCHEDULE.
  expectedUpdatedAt: z.string().datetime({ offset: true }).optional()
    .describe('updatedAt of the schedule as last read (recurring-guard-v1); a mismatch is 409 STALE_SCHEDULE'),
}).strict();

export const recurringRouter = Router();
recurringRouter.use(authenticate);
recurringRouter.use(requireResource('recurring'));

recurringRouter.get('/', async (req, res) => {
  const limit = req.query['limit'] ? Number(req.query['limit']) : undefined;
  const offset = req.query['offset'] ? Number(req.query['offset']) : undefined;
  const result = await recurringService.list(req.tenantId, {
    limit, offset,
    sortBy: pickEnum(req.query['sortBy'], recurringService.RECURRING_SORT_KEYS),
    sortDir: pickEnum(req.query['sortDir'], ['asc', 'desc'] as const),
  });
  res.json({ schedules: result.data, total: result.total, limit: result.limit, offset: result.offset });
});

recurringRouter.post('/', validate(createScheduleSchema), async (req, res) => {
  const { templateTransactionId, ...schedule } = req.body;
  const sched = await recurringService.create(req.tenantId, templateTransactionId, schedule, req.userId);
  res.status(201).json({ schedule: sched });
});

recurringRouter.put('/:id', validate(updateScheduleSchema), async (req, res) => {
  const sched = await recurringService.update(req.tenantId, req.params['id']!, req.body, req.userId);
  res.json({ schedule: sched });
});

recurringRouter.delete('/:id', async (req, res) => {
  await recurringService.deactivate(req.tenantId, req.params['id']!, req.userId);
  res.json({ message: 'Deactivated' });
});

// The catch-up run (U-63, recurring-run-due-v1). Company-scoped. Not behind
// lockContextMiddleware and the body is strict: a closingPassword is 400,
// and the runner itself never opens a closed period (runWithoutOverride).
recurringRouter.post('/run-due', companyContext, describe({
  summary: 'Post every due auto template occurrence once (recurring-run-due-v1)',
  description: 'Response `{asOf, runId, more, posted:[{templateId,templateName,kind,clientForm,occurrenceDate,transactionId,total}], reminders:[{templateId,templateName,kind,clientForm,dueDates,dueCount,truncated,total}], remindersTruncated, skipped:[{templateId,templateName,kind,clientForm,occurrenceDate,reason,new}], skippedTotal, failed:[{templateId,reason}]}`. `posted` includes earlier posts with the same runId. A run posts or skips at most 31 dates per schedule; a schedule with more due is listed in `skipped` with reason CATCH_UP_CAPPED (its next due date; nothing recorded, the next run continues) and does not set `more`. A template posts only while its owner (last editor, else creator) holds write access to its kind, else the date is skipped with reason PERMISSION. `skipped` lists at most 200 open dates (oldest first) plus the capped schedules; `skippedTotal` counts them all. Reminders: at most 500 schedules (`remindersTruncated`) and 400 due dates each (`truncated`). asOf later than tomorrow: 400 RUN_DUE_FUTURE. Optional template filter (run-due-filter-v1): `templateIds` (1-500 uuids) runs only these templates, `excludeTemplateIds` (0-500 uuids) runs all but these; both together mean only these minus the excluded; ids matching no due template are ignored; a malformed id is 400 VALIDATION_ERROR. Filtered-out templates are untouched and stay due; `more` counts only templates the filter lets through; `reminders` and `skipped` stay company-wide. The runId is only a label: replaying it with a different filter posts what the new filter allows (never a date twice), and `posted` lists every post with that runId.',
}), validate(runDueSchema), async (req, res) => {
  const result = await occurrences.runDue({ tenantId: req.tenantId, companyId: req.companyId, userId: req.userId }, req.body);
  res.json(result);
});

const attentionQuery = z.object({ asOf: isoDate.optional() });

recurringRouter.get('/attention', companyContext, describe({
  summary: 'Due reminders and open skipped dates; changes nothing (recurring-run-due-v1)',
  description: 'Response `{asOf, reminders, remindersTruncated, skipped, skippedTotal}` with the run-due shapes and bounds.',
  query: attentionQuery,
}), async (req, res) => {
  const { asOf } = attentionQuery.parse(req.query);
  res.json(await occurrences.attention({ tenantId: req.tenantId, companyId: req.companyId, userId: req.userId }, asOf));
});

recurringRouter.post('/:id/post-now', async (req, res) => {
  const txn = await recurringService.postNext(req.tenantId, req.params['id']!);
  res.status(201).json({ transaction: txn });
});

recurringRouter.post('/:id/archive', async (req, res) => {
  const schedule = await recurringService.archive(req.tenantId, req.params['id']!, req.userId);
  res.json({ schedule });
});

recurringRouter.post('/:id/unarchive', async (req, res) => {
  const schedule = await recurringService.unarchive(req.tenantId, req.params['id']!, req.userId);
  res.json({ schedule });
});
