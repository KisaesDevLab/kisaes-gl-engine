// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../middleware/auth.js';
import { requireResource } from '../middleware/permission.js';
import { companyContext } from '../middleware/company.js';
import { validate } from '../middleware/validate.js';
import { describe } from '../middleware/describe.js';
import { idempotent } from '../middleware/idempotent.js';
import * as statements from '../services/customer-statement.service.js';

/**
 * Customer statements (U-112, U-140; customer-statement-v1,
 * customer-statement-send-v1, idempotency-customer-statements-v1). Under
 * the Sales `invoices` resource: statements are a receivables document.
 * Runs and send events touch no GL, so there is no closing-date check.
 * Names, addresses and email addresses are never logged.
 */
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'a date YYYY-MM-DD');
const format = z.enum(['open_item', 'balance_forward', 'transaction']);

const statementDoc = 'CustomerStatement: {contact: {id, name, address: string[], email?}, asOf, format, start?, openingBalance?, ' +
  'lines: [{date, txnId, txnType, number, description, dueDate?, amount, open?, balance}], aging: {current, days1to30, days31to60, ' +
  'days61to90, over90, total}, amountDue, difference}. open_item: the open items as of asOf (amount = the original A/R amount, open = ' +
  'what is open, running balance over open); balance_forward: openingBalance = the balance on the day before start (default the first ' +
  'of asOf\'s month), lines = each posted transaction dated start..asOf with its own A/R amount; transaction: the same lines, the opening ' +
  'is the previous balance. aging is the client\'s row of GET /reports/ar-aging-summary (same helper); amountDue = aging.total = the ' +
  'client\'s A/R balance as of asOf; difference = exact total - Σ cent figures (0.00 except legacy sub-cent residue; never printed).';

/** GET /reports/customer-statement and /reports/customer-statements (mounted under /api/v1/reports). */
export const customerStatementReportsRouter = Router();
customerStatementReportsRouter.use(authenticate);
customerStatementReportsRouter.use(companyContext);
customerStatementReportsRouter.use(requireResource('reports'));

const statementQuery = z.object({
  contactId: z.string().uuid(), asOf: isoDate, format: format.optional(), start: isoDate.optional(),
});
customerStatementReportsRouter.get('/customer-statement', describe({
  summary: 'A customer statement as of a date (customer-statement-v1)',
  description: `Response {statement: CustomerStatement}. ${statementDoc} A client of another company is 404.`,
  query: statementQuery,
}), async (req, res) => {
  const q = statementQuery.safeParse(req.query);
  if (!q.success) { res.status(400).json({ error: { message: 'contactId and asOf are required', code: 'VALIDATION_ERROR' } }); return; }
  const { db } = await import('../db/index.js');
  res.json({ statement: await statements.buildCustomerStatement(db, req.tenantId, req.companyId, q.data) });
});

const batchQuery = z.object({
  asOf: isoDate,
  minDaysOverdue: z.coerce.number().int().min(0).max(3650).optional(),
  openOnly: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});
customerStatementReportsRouter.get('/customer-statements', describe({
  summary: 'Clients to send statements to (customer-statement-v1)',
  description: 'Response {data: [{contactId, name, amountDue, oldestDaysOverdue, hasEmail, lastStatement?: {date, number}}], total}: active ' +
    'customers of the company with their A/R as of asOf (the open-items helper), by name. openOnly (default true): amountDue <> 0.00; ' +
    'minDaysOverdue (default 0): the oldest open invoice is at least that many days past due. limit (default 200, max 1,000), offset.',
  query: batchQuery,
}), async (req, res) => {
  const q = batchQuery.safeParse(req.query);
  if (!q.success) { res.status(400).json({ error: { message: 'asOf is required', code: 'VALIDATION_ERROR' } }); return; }
  res.json(await statements.listStatementCandidates(req.tenantId, req.companyId, { ...q.data, openOnly: q.data.openOnly !== 'false' }));
});

/** POST /customer-statement-runs. */
export const customerStatementRunsRouter = Router();
customerStatementRunsRouter.use(authenticate);
customerStatementRunsRouter.use(companyContext);
customerStatementRunsRouter.use(requireResource('invoices'));

const runSchema = z.object({
  asOf: isoDate, format: format.optional(), start: isoDate.optional(),
  contactIds: z.array(z.string().uuid()).min(1),
});
customerStatementRunsRouter.post('/', idempotent({
  successStatus: 201,
  replay: async (req, entity) => statements.getRunResult(req.tenantId, entity!.id, req.companyId),
}), validate(runSchema), describe({
  summary: 'Issue numbered customer statements (customer-statement-send-v1)',
  description: 'Response 201 {runId, statements: [{statementId, contactId, number, amountDue}]}. One snapshot per client (1 to 500 clients; more ' +
    'is 400 TOO_MANY_CONTACTS), numbered from the company\'s statement counter, in one database transaction. The snapshot is display data ' +
    'only (no ids): GET /customer-statements/:id returns it for print, PDF, email and later Outbox sends. No GL effect, no closing-date ' +
    'check. Idempotency-Key: the run is the stored entity; a replay rebuilds the response from it.',
  body: runSchema,
}), async (req, res) => {
  res.status(201).json(await statements.createStatementRun(req.tenantId, req.companyId, req.body, req.userId));
});

/** GET /customer-statements, /:id; POST /:id/sent, /:id/email, /:id/email-later. */
export const customerStatementsRouter = Router();
customerStatementsRouter.use(authenticate);
customerStatementsRouter.use(companyContext);
customerStatementsRouter.use(requireResource('invoices'));

const idParams = z.object({ id: z.string().uuid() });
const snapshotDoc = 'CustomerStatementRecord: {id, runId, contactId, number, asOf, amountDue, createdAt, snapshot: {number, contact: {name, ' +
  'address, email?}, asOf, format, start?, openingBalance?, lines: [{date, txnType, number, description, dueDate?, amount, open?, balance}], ' +
  'aging, amountDue, difference}, sendHistory: [{id, method, recipients, sentAt, userId}]}.';

customerStatementsRouter.get('/', describe({
  summary: 'Issued customer statements (customer-statement-v1)',
  description: 'Response {data: [{id, runId, contactId, number, asOf, amountDue, createdAt, lastSentAt}]}, newest first; contactId filters one client.',
  query: z.object({ contactId: z.string().uuid().optional() }),
}), async (req, res) => {
  const contactId = typeof req.query['contactId'] === 'string' && /^[0-9a-f-]{36}$/i.test(req.query['contactId']) ? req.query['contactId'] : undefined;
  res.json(await statements.listStatements(req.tenantId, req.companyId, contactId));
});

customerStatementsRouter.get('/:id', describe({
  summary: 'An issued customer statement (customer-statement-v1)',
  description: `Response {statement: CustomerStatementRecord}. Another company's statement is 404. ${snapshotDoc}`,
  params: idParams,
}), async (req, res) => {
  res.json({ statement: await statements.getStatement(req.tenantId, req.params['id']!, req.companyId) });
});

const sentSchema = z.object({ method: z.enum(['printed', 'email', 'pdf']), recipients: z.array(z.string().max(320)).max(50).optional() });
customerStatementsRouter.post('/:id/sent', idempotent({
  successStatus: 200,
  replay: async (req) => ({ statement: await statements.getStatement(req.tenantId, req.params['id']!, req.companyId) }),
}), validate(sentSchema), describe({
  summary: 'Mark a customer statement as sent (customer-statement-send-v1)',
  description: `Response {statement: CustomerStatementRecord}. Adds a send event (printing counts as sent). Recipients are stored, never logged. ${snapshotDoc}`,
  body: sentSchema, params: idParams,
}), async (req, res) => {
  res.json({ statement: await statements.markStatementSent(req.tenantId, req.params['id']!, req.body, req.userId, req.companyId) });
});

const message = {
  to: z.array(z.string().email()).min(1).max(50), cc: z.array(z.string().email()).max(50).default([]),
  bcc: z.array(z.string().email()).max(50).default([]), subject: z.string().max(500), body: z.string().max(20000),
};
const emailSchema = z.object({
  ...message, pdfFileName: z.string().min(1).max(200), pdfBase64: z.string().min(1), outboxId: z.string().uuid().optional(),
});
customerStatementsRouter.post('/:id/email', idempotent({
  successStatus: 200,
  replay: async (req) => ({ statement: await statements.getStatement(req.tenantId, req.params['id']!, req.companyId) }),
}), validate(emailSchema), describe({
  summary: 'Email a customer statement (customer-statement-send-v1)',
  description: 'Response {statement: CustomerStatementRecord}. As POST /invoices/:id/email (U-127): the client-made PDF of the snapshot ' +
    '(pdfFileName such as Statement-1042.pdf, at most 10 MB; 400 ATTACHMENT_TOO_LARGE), the company mail server (400 SMTP_NOT_CONFIGURED, ' +
    'SMTP_SEND_FAILED {reason}); records an email send event; outboxId removes that Outbox row (404 OUTBOX_ITEM_NOT_FOUND). Recipients, ' +
    'subject and body are never logged.',
  body: emailSchema, params: idParams,
}), async (req, res) => {
  res.json({ statement: await statements.emailStatement(req.tenantId, req.params['id']!, req.body, req.userId, req.companyId) });
});

const laterSchema = z.object(message);
customerStatementsRouter.post('/:id/email-later', idempotent({
  successStatus: 201,
  replay: async (req, entity) => {
    const mail = await import('../services/invoice-email.service.js');
    return { item: await mail.getEmailQueueItem(req.tenantId, entity!.id, req.companyId) };
  },
}), validate(laterSchema), describe({
  summary: 'Put a customer statement email in the Outbox (customer-statement-send-v1)',
  description: 'Response 201 {item}: an Outbox row as GET /forms/email-queue lists it (kind customer_statement, customerStatementId, ' +
    'transactionId null). Nothing is sent until the client sends it with POST /customer-statements/:id/email and outboxId.',
  body: laterSchema, params: idParams,
}), async (req, res) => {
  res.status(201).json({ item: await statements.queueStatementEmail(req.tenantId, req.params['id']!, req.body, req.userId, req.companyId) });
});
