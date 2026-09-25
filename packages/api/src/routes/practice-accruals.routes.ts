// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { Router } from 'express';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { ACCRUAL_KINDS, ACCRUAL_METHODS } from '@kis-books/shared';
import { authenticate } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { requirePracticeAccess } from '../middleware/practice-access.js';
import { AppError } from '../utils/errors.js';
import { db } from '../db/index.js';
import { companies } from '../db/schema/index.js';
import * as accruals from '../services/accruals.service.js';

// Close Review → Accruals (ACCRUALS_V1). Posting is always a reviewer click.
export const practiceAccrualsRouter = Router();
practiceAccrualsRouter.use(authenticate);
practiceAccrualsRouter.use(requirePracticeAccess('ACCRUALS_V1'));

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}/, 'Must be a date (YYYY-MM-DD)');
const money = z.string().regex(/^\d+(\.\d{1,4})?$/, 'Must be an amount like 1200.00');

const scheduleSchema = z.object({
  companyId: z.string().uuid().nullable().optional(),
  kind: z.enum(ACCRUAL_KINDS),
  description: z.string().trim().min(1).max(300),
  contactId: z.string().uuid().nullable().optional(),
  sourceTransactionId: z.string().uuid().nullable().optional(),
  balanceAccountId: z.string().uuid(),
  recognitionAccountId: z.string().uuid(),
  totalAmount: money,
  startDate: dateStr,
  months: z.number().int().min(1).max(600),
  method: z.enum(ACCRUAL_METHODS),
  postFrom: dateStr.nullable().optional(),
});

async function assertCompany(tenantId: string, companyId: string | null | undefined) {
  if (!companyId) return;
  const rows = await db.select({ id: companies.id }).from(companies)
    .where(and(eq(companies.tenantId, tenantId), eq(companies.id, companyId))).limit(1);
  if (rows.length === 0) throw AppError.notFound('Company not found');
}
const qCompany = (q: unknown) => (typeof q === 'string' && q ? q : null);

practiceAccrualsRouter.get('/schedules', async (req, res) => {
  const companyId = qCompany(req.query['companyId']);
  await assertCompany(req.tenantId, companyId);
  res.json({ schedules: await accruals.listSchedules(req.tenantId, companyId) });
});

practiceAccrualsRouter.post('/schedules', validate(scheduleSchema), async (req, res) => {
  const b = req.body as z.infer<typeof scheduleSchema>;
  await assertCompany(req.tenantId, b.companyId);
  res.status(201).json({ schedule: await accruals.createSchedule(req.tenantId, { ...b, companyId: b.companyId ?? null }, req.userId) });
});

practiceAccrualsRouter.put('/schedules/:id', validate(scheduleSchema), async (req, res) => {
  const b = req.body as z.infer<typeof scheduleSchema>;
  res.json({ schedule: await accruals.updateSchedule(req.tenantId, req.params['id']!, b, req.userId) });
});

practiceAccrualsRouter.delete('/schedules/:id', async (req, res) => {
  await accruals.deleteSchedule(req.tenantId, req.params['id']!, req.userId);
  res.json({ deleted: true });
});

practiceAccrualsRouter.post('/schedules/:id/cancel', async (req, res) => {
  await accruals.cancelSchedule(req.tenantId, req.params['id']!, req.userId);
  res.json({ cancelled: true });
});

practiceAccrualsRouter.get('/schedules/:id/entries', async (req, res) => {
  res.json({ entries: await accruals.scheduleEntries(req.tenantId, req.params['id']!) });
});

practiceAccrualsRouter.get('/entries', async (req, res) => {
  const companyId = qCompany(req.query['companyId']);
  const periodStart = dateStr.parse(req.query['periodStart']);
  await assertCompany(req.tenantId, companyId);
  res.json({ entries: await accruals.entriesForMonth(req.tenantId, companyId, periodStart) });
});

practiceAccrualsRouter.post('/entries/:id/post', async (req, res) => {
  res.json(await accruals.postEntry(req.tenantId, req.params['id']!, req.userId));
});

practiceAccrualsRouter.post('/entries/:id/unpost', async (req, res) => {
  await accruals.unpostEntry(req.tenantId, req.params['id']!, req.userId);
  res.json({ unposted: true });
});

const postAllSchema = z.object({ companyId: z.string().uuid().nullable().optional(), periodStart: dateStr });
practiceAccrualsRouter.post('/post-all', validate(postAllSchema), async (req, res) => {
  const b = req.body as z.infer<typeof postAllSchema>;
  await assertCompany(req.tenantId, b.companyId);
  res.json(await accruals.postAllForMonth(req.tenantId, b.companyId ?? null, b.periodStart, req.userId));
});

practiceAccrualsRouter.get('/candidates', async (req, res) => {
  const companyId = qCompany(req.query['companyId']);
  await assertCompany(req.tenantId, companyId);
  res.json(await accruals.candidates(
    req.tenantId, companyId, dateStr.parse(req.query['periodStart']), dateStr.parse(req.query['periodEnd']),
  ));
});

practiceAccrualsRouter.get('/tie-out', async (req, res) => {
  const companyId = qCompany(req.query['companyId']);
  await assertCompany(req.tenantId, companyId);
  res.json({ rows: await accruals.tieOut(req.tenantId, companyId, dateStr.parse(req.query['periodEnd'])) });
});

const importSchema = z.object({ companyId: z.string().uuid().nullable().optional(), csv: z.string().min(1).max(2_000_000) });
practiceAccrualsRouter.post('/import', validate(importSchema), async (req, res) => {
  const b = req.body as z.infer<typeof importSchema>;
  await assertCompany(req.tenantId, b.companyId);
  res.json(await accruals.importCsv(req.tenantId, b.companyId ?? null, b.csv, req.userId));
});
