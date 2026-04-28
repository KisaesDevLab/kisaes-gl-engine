// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { Router } from 'express';
import { z } from 'zod';
import {
  recurringDocRequestCreateSchema,
  recurringDocRequestUpdateSchema,
  documentRequestListFiltersSchema,
  RECURRING_FREQUENCIES,
  type RecurringFrequency,
} from '@kis-books/shared';
import { authenticate } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { AppError } from '../utils/errors.js';
import * as svc from '../services/recurring-doc-request.service.js';
import * as remind from '../services/portal-reminders.service.js';
import * as flags from '../services/feature-flags.service.js';
import * as stmtRouting from '../services/statement-routing.service.js';
import { db } from '../db/index.js';
import { bankConnections } from '../db/schema/index.js';
import { eq } from 'drizzle-orm';

// RECURRING_DOC_REQUESTS_V1 — bookkeeper-side admin for the calendar-
// cadence document-request feature. Two routers under the same prefix:
//   /api/v1/practice/recurring-doc-requests  → standing rules CRUD
//   /api/v1/practice/document-requests       → issued-instance grid

export const recurringDocRequestsRouter = Router();
recurringDocRequestsRouter.use(authenticate);

// Common gate: client user_type doesn't see this; readonly can read but not write;
// feature flag must be on for this tenant.
recurringDocRequestsRouter.use(async (req, _res, next) => {
  if (req.userType === 'client') throw AppError.notFound('Feature not available');
  if (req.userRole === 'readonly' && req.method !== 'GET') {
    throw AppError.forbidden('Read-only role cannot manage document requests');
  }
  const enabled = await flags.isEnabled(req.tenantId, 'RECURRING_DOC_REQUESTS_V1');
  if (!enabled) throw AppError.notFound('Feature not enabled');
  next();
});

// ── Standing rules CRUD ─────────────────────────────────────────

recurringDocRequestsRouter.get('/recurring-doc-requests', async (req, res) => {
  const list = await svc.listRules(req.tenantId);
  res.json({ rules: list });
});

recurringDocRequestsRouter.post(
  '/recurring-doc-requests',
  validate(recurringDocRequestCreateSchema),
  async (req, res) => {
    const result = await svc.createRule(req.tenantId, req.userId, req.body);
    res.status(201).json(result);
  },
);

recurringDocRequestsRouter.patch(
  '/recurring-doc-requests/:id',
  validate(recurringDocRequestUpdateSchema),
  async (req, res) => {
    await svc.updateRule(req.tenantId, req.userId, req.params['id']!, req.body);
    res.json({ ok: true });
  },
);

// "Cancel" = set active=false. The historical issued document_requests
// rows are preserved (recurring_id stays set with ON DELETE SET NULL
// in the schema) so the audit trail isn't lost.
recurringDocRequestsRouter.delete('/recurring-doc-requests/:id', async (req, res) => {
  await svc.cancelRule(req.tenantId, req.userId, req.params['id']!);
  res.json({ ok: true });
});

const previewSchema = z.object({
  cadenceKind: z.enum(['frequency', 'cron']).default('frequency'),
  frequency: z.enum(RECURRING_FREQUENCIES).default('monthly'),
  intervalValue: z.number().int().min(1).max(12).default(1),
  dayOfMonth: z.number().int().min(1).max(28).nullable().optional(),
  cronExpression: z.string().min(1).max(120).nullable().optional(),
  cronTimezone: z.string().max(64).nullable().optional(),
  startAt: z.string().datetime().optional(),
  count: z.number().int().min(1).max(12).default(3),
});

recurringDocRequestsRouter.post(
  '/recurring-doc-requests/preview',
  validate(previewSchema),
  (req, res) => {
    const body = req.body as z.infer<typeof previewSchema>;
    const out = svc.previewNext(
      body.cadenceKind,
      body.frequency as RecurringFrequency,
      body.intervalValue,
      body.dayOfMonth ?? null,
      body.cronExpression ?? null,
      body.cronTimezone ?? null,
      body.startAt ? new Date(body.startAt) : undefined,
      body.count,
    );
    res.json({ next: out });
  },
);

// ── Issued document_requests grid + actions ─────────────────────

recurringDocRequestsRouter.get('/document-requests', async (req, res) => {
  const filters = documentRequestListFiltersSchema.parse(req.query);
  const result = await svc.listOpenRequests(req.tenantId, filters);
  res.json(result);
});

recurringDocRequestsRouter.get('/document-requests/dashboard', async (req, res) => {
  const counts = await svc.dashboardCounts(req.tenantId);
  res.json(counts);
});

recurringDocRequestsRouter.get('/document-requests/:id/sends', async (req, res) => {
  const sends = await svc.listSendsForRequest(req.tenantId, req.params['id']!);
  res.json({ sends });
});

recurringDocRequestsRouter.post('/document-requests/:id/remind', async (req, res) => {
  const result = await remind.forceNudgeForDocRequest(
    req.tenantId,
    req.params['id']!,
    req.userId,
  );
  if (result === 'not_found') throw AppError.notFound('Document request not found');
  res.json({ result });
});

recurringDocRequestsRouter.post('/document-requests/:id/mark-received', async (req, res) => {
  await svc.markReceivedManually(req.tenantId, req.userId, req.params['id']!);
  res.json({ ok: true });
});

recurringDocRequestsRouter.post('/document-requests/:id/cancel', async (req, res) => {
  await svc.cancelRequest(req.tenantId, req.userId, req.params['id']!);
  res.json({ ok: true });
});

// Per-contact rollup for the ContactDetailPage panel.
recurringDocRequestsRouter.get('/contacts/:contactId/document-requests', async (req, res) => {
  const items = await svc.listForContactDetail(req.tenantId, req.params['contactId']!);
  res.json({ items });
});

// STATEMENT_AUTO_IMPORT_V1 — list the firm's bank connections so the
// rule editor can populate its picker. Read-only, tenant-scoped.
recurringDocRequestsRouter.get('/bank-connections', async (req, res) => {
  const rows = await db
    .select({
      id: bankConnections.id,
      institutionName: bankConnections.institutionName,
      mask: bankConnections.mask,
      companyId: bankConnections.companyId,
    })
    .from(bankConnections)
    .where(eq(bankConnections.tenantId, req.tenantId));
  res.json({ connections: rows });
});

// STATEMENT_AUTO_IMPORT_V1 — manual route action for a receipt that
// landed in awaits_routing. The CPA picks the bank connection from
// the inbox and the parsed transactions land in bank_feed_items.
const manualRouteSchema = z.object({
  bankConnectionId: z.string().uuid(),
});
recurringDocRequestsRouter.post(
  '/portal-receipts/:receiptId/route-statement',
  validate(manualRouteSchema),
  async (req, res) => {
    const result = await stmtRouting.manualRouteStatement(
      req.tenantId,
      req.userId,
      req.params['receiptId']!,
      req.body.bankConnectionId,
    );
    res.json(result);
  },
);
