// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { Router } from 'express';
import { writeCheckSchema, printCheckSchema, checkSettingsSchema } from '@kis-books/shared';
import { authenticate } from '../middleware/auth.js';
import { requireResource } from '../middleware/permission.js';
import { companyContext } from '../middleware/company.js';
import { validate } from '../middleware/validate.js';
import * as checkService from '../services/check.service.js';
import * as checkPdfService from '../services/check-pdf.service.js';
import { parseLimit, parseOffset } from '../utils/pagination.js';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { companies } from '../db/schema/index.js';

export const checksRouter = Router();
checksRouter.use(authenticate);
checksRouter.use(companyContext);
checksRouter.use(requireResource('checks'));

checksRouter.post('/', validate(writeCheckSchema), async (req, res) => {
  const check = await checkService.createCheck(req.tenantId, req.body, req.userId, req.companyId);
  res.status(201).json({ check });
});

checksRouter.get('/', async (req, res) => {
  const result = await checkService.listChecks(req.tenantId, {
    bankAccountId: req.query['bank_account_id'] as string,
    printStatus: req.query['print_status'] as string,
    startDate: req.query['start_date'] as string,
    endDate: req.query['end_date'] as string,
    limit: parseLimit(req.query['limit']),
    offset: parseOffset(req.query['offset']),
  }, req.companyId);
  res.json(result);
});

checksRouter.get('/print-queue', async (req, res) => {
  const data = await checkService.getPrintQueue(req.tenantId, req.query['bank_account_id'] as string, req.companyId);
  res.json({ data });
});

checksRouter.post('/test-print', async (req, res) => {
  const pdf = await checkPdfService.generateTestCheckPdf(req.tenantId, req.body.format || 'voucher');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'inline; filename="test-check.pdf"');
  res.send(pdf);
});

checksRouter.post('/render', async (req, res) => {
  const { checkIds, format, startingCheckNumber } = req.body;
  if (!Array.isArray(checkIds) || checkIds.length === 0) {
    res.status(400).json({ error: 'checkIds is required' });
    return;
  }
  // startingCheckNumber lets the render preview the numbers that the
  // subsequent POST /print will assign (same checkIds order).
  const startNum = Number.isInteger(startingCheckNumber) && startingCheckNumber > 0
    ? startingCheckNumber : null;
  const pdf = await checkPdfService.generateCheckPdf(req.tenantId, checkIds, format || 'voucher', startNum);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'inline; filename="checks.pdf"');
  res.send(pdf);
});

// #10 envelopes for a batch of checks (return + payee mailing address).
checksRouter.post('/envelopes', async (req, res) => {
  const { checkIds } = req.body;
  if (!Array.isArray(checkIds) || checkIds.length === 0) {
    res.status(400).json({ error: 'checkIds is required' });
    return;
  }
  const pdf = await checkPdfService.generateEnvelopePdf(req.tenantId, checkIds);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'inline; filename="envelopes.pdf"');
  res.send(pdf);
});

checksRouter.post('/print', validate(printCheckSchema), async (req, res) => {
  const result = await checkService.printChecks(
    req.tenantId, req.body.bankAccountId, req.body.checkIds,
    req.body.startingCheckNumber, req.body.format, req.userId,
  );
  res.json(result);
});

checksRouter.post('/reprint/:batchId', async (req, res) => {
  await checkService.reprintBatch(req.tenantId, req.params['batchId']!);
  res.json({ message: 'Batch reset to queue' });
});

checksRouter.post('/requeue', async (req, res) => {
  await checkService.requeueChecks(req.tenantId, req.body.checkIds);
  res.json({ message: 'Checks returned to queue' });
});

// Check settings
checksRouter.get('/settings', async (req, res) => {
  const { and: andOp } = await import('drizzle-orm');
  const company = await db.query.companies.findFirst({ where: andOp(eq(companies.tenantId, req.tenantId), eq(companies.id, req.companyId)) });
  res.json({ settings: company?.checkSettings || {} });
});

checksRouter.put('/settings', validate(checkSettingsSchema), async (req, res) => {
  const { and: andOp } = await import('drizzle-orm');
  const company = await db.query.companies.findFirst({ where: andOp(eq(companies.tenantId, req.tenantId), eq(companies.id, req.companyId)) });
  const current = (company?.checkSettings as Record<string, unknown>) || {};
  const merged = { ...current, ...req.body };
  await db.update(companies).set({ checkSettings: merged }).where(andOp(eq(companies.tenantId, req.tenantId), eq(companies.id, req.companyId)));
  res.json({ settings: merged });
});
