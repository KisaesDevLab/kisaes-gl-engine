// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Templates (memorized transactions) without posting — ClientLedger U-62,
// capability templates-v1. A template is a draft of a check, expense,
// deposit, transfer, journal entry or daily-sales entry with an optional
// schedule; saving one posts nothing. Company-scoped: another tenant's or
// company's template is 404. "Enter" posts it (closing date enforced; the
// closingPassword in the body opens a closed period, closing-password-v1).

import { Router } from 'express';
import { z } from 'zod';
import {
  createTxnTemplateSchema, createTxnTemplateFromTransactionSchema, updateTxnTemplateSchema,
  txnTemplateGroupSchema, enterTxnTemplateSchema, resolveOccurrenceSchema,
} from '@kis-books/shared';
import { authenticate } from '../middleware/auth.js';
import { requireResource } from '../middleware/permission.js';
import { companyContext } from '../middleware/company.js';
import { validate } from '../middleware/validate.js';
import { describe } from '../middleware/describe.js';
import { closingPasswordLimiter } from '../middleware/closing-password-limiter.js';
import { lockContextMiddleware } from '../services/lock-context.js';
import * as templates from '../services/templates/templates.service.js';
import * as occurrences from '../services/templates/occurrences.service.js';
import * as ledger from '../services/ledger.service.js';
import { AppError } from '../utils/errors.js';

export const templatesRouter = Router();
templatesRouter.use(authenticate);
templatesRouter.use(companyContext);
templatesRouter.use(requireResource('recurring'));

const idParams = z.object({ id: z.string().uuid() });
const occurrenceParams = z.object({ id: z.string().uuid(), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });
const isoDate = /^\d{4}-\d{2}-\d{2}$/;

function uuidParam(value: string | undefined): string {
  if (!value || !z.string().uuid().safeParse(value).success) throw AppError.notFound('Template not found');
  return value;
}

function dateParam(value: string | undefined): string {
  if (!value || !isoDate.test(value)) throw AppError.badRequest('date must be YYYY-MM-DD', 'VALIDATION_ERROR');
  return value;
}

const actor = (req: { tenantId: string; companyId: string; userId?: string }) =>
  ({ tenantId: req.tenantId, companyId: req.companyId, userId: req.userId });

// ── Groups (before /:id) ───────────────────────────────────────────

templatesRouter.get('/groups', describe({ summary: 'List template groups (templates-v1)' }), async (req, res) => {
  res.json({ groups: await templates.listGroups(req.tenantId, req.companyId) });
});

templatesRouter.post('/groups', describe({ summary: 'Create a template group (templates-v1); name taken: 409 TEMPLATE_GROUP_NAME_TAKEN' }),
  validate(txnTemplateGroupSchema), async (req, res) => {
    res.status(201).json({ group: await templates.createGroup(req.tenantId, req.companyId, req.userId, req.body.name) });
  });

templatesRouter.put('/groups/:id', describe({ summary: 'Rename a template group (templates-v1)', params: idParams }),
  validate(txnTemplateGroupSchema), async (req, res) => {
    const id = uuidParam(req.params['id']);
    res.json({ group: await templates.updateGroup(req.tenantId, req.companyId, req.userId, id, req.body.name) });
  });

templatesRouter.delete('/groups/:id', describe({ summary: 'Delete a template group; its templates move to no group (templates-v1)', params: idParams }),
  async (req, res) => {
    await templates.deleteGroup(req.tenantId, req.companyId, req.userId, uuidParam(req.params['id']));
    res.status(204).end();
  });

// ── Templates ──────────────────────────────────────────────────────

const listQuery = z.object({
  groupId: z.string().uuid().optional(),
  kind: z.enum(['check', 'expense', 'deposit', 'transfer', 'journal_entry', 'daily_sales', 'legacy']).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

templatesRouter.get('/', describe({
  summary: 'List templates (templates-v1)',
  description: 'Response `{templates:[{id,name,kind,draftKind,clientForm,groupId,groupName,accountId,contactId,total,schedule,lastEnteredDate,openSkipped,legacy,version}], total}`. `total` is the header amount as a 4-place decimal string.',
  query: listQuery,
}), async (req, res) => {
  const q = listQuery.parse(req.query);
  res.json(await templates.listTemplates(req.tenantId, req.companyId, q));
});

templatesRouter.post('/', describe({
  summary: 'Create a template; posts nothing (templates-v1)',
  description: 'The draft is the create body of the kind minus the date and numbers; amounts are decimal strings. 400 TEMPLATE_FIELD_NOT_ALLOWED (details.field), TEMPLATE_DEPOSIT_GROUPING, TEMPLATE_AUTO_UNSUPPORTED, VALIDATION_ERROR; 409 TEMPLATE_NAME_TAKEN.',
}), validate(createTxnTemplateSchema), async (req, res) => {
  res.status(201).json({ template: await templates.createTemplate(req.tenantId, req.companyId, req.userId, req.body) });
});

templatesRouter.post('/from-transaction', describe({
  summary: 'Save a posted transaction as a template (templates-v1)',
  description: 'Kinds templates cannot hold (invoice, bill...) become a legacy template. 400 TEMPLATE_SOURCE_INVALID (void/deleted), TEMPLATE_DEPOSIT_GROUPING; 404 another company.',
}), validate(createTxnTemplateFromTransactionSchema), async (req, res) => {
  res.status(201).json({ template: await templates.createFromTransaction(req.tenantId, req.companyId, req.userId, req.body) });
});

templatesRouter.get('/:id', describe({ summary: 'Get a template with its draft and schedule (templates-v1)', params: idParams }), async (req, res) => {
  res.json({ template: await templates.getTemplate(req.tenantId, req.companyId, uuidParam(req.params['id'])) });
});

templatesRouter.put('/:id', describe({
  summary: 'Change a template (templates-v1); version mismatch: 409 STALE (details.version); schedule null removes it',
  params: idParams,
}), validate(updateTxnTemplateSchema), async (req, res) => {
  res.json({ template: await templates.updateTemplate(req.tenantId, req.companyId, req.userId, uuidParam(req.params['id']), req.body) });
});

const deleteQuery = z.object({ version: z.coerce.number().int().min(1) });

templatesRouter.delete('/:id', describe({
  summary: 'Delete a template (soft); its schedule stops; posted transactions stay (templates-v1)',
  params: idParams, query: deleteQuery,
}), async (req, res) => {
  const { version } = deleteQuery.parse(req.query);
  await templates.deleteTemplate(req.tenantId, req.companyId, req.userId, uuidParam(req.params['id']), version);
  res.status(204).end();
});

templatesRouter.get('/:id/draft', describe({
  summary: 'The template as a create body for the normal form; posts nothing (templates-v1)',
  description: 'Response `{kind, clientForm, draft, warnings:[{field, code: ACCOUNT_INACTIVE|CONTACT_INACTIVE|TAG_INACTIVE|NOT_FOUND, id}]}`; a missing reference is nulled in the draft.',
  params: idParams,
}), async (req, res) => {
  res.json(await templates.getDraftForUse(req.tenantId, req.companyId, uuidParam(req.params['id'])));
});

const enterBodyDoc = enterTxnTemplateSchema.extend({
  closingPassword: z.string().optional().describe('closing-date password (closing-password-v1); never stored or echoed'),
});

templatesRouter.post('/:id/enter', closingPasswordLimiter, lockContextMiddleware, describe({
  summary: 'Post the template now (templates-v1)',
  description: 'occurrenceDate defaults to the schedule’s next date (today without a schedule); the next date (even early) or an open skipped date only, else 400 OCCURRENCE_NOT_DUE; a date already done: 409 OCCURRENCE_TAKEN. Response 201 `{transaction, occurrence}`.',
  params: idParams,
  body: enterBodyDoc,
}), validate(enterTxnTemplateSchema), async (req, res) => {
  const r = await occurrences.enterTemplate(actor(req), uuidParam(req.params['id']), req.body);
  const transaction = await ledger.getTransaction(req.tenantId, r.transactionId);
  res.status(201).json({ transaction, occurrence: r.occurrence });
});

templatesRouter.post('/:id/occurrences/:date/skip', describe({
  summary: 'Skip a date (dismissed); the schedule moves on when it is the next date (templates-v1)',
  params: occurrenceParams,
}), async (req, res) => {
  const occurrence = await occurrences.skipOccurrence(actor(req), uuidParam(req.params['id']), dateParam(req.params['date']));
  res.json({ occurrence });
});

templatesRouter.post('/:id/occurrences/:date/resolve', describe({
  summary: 'Link a transaction saved through the normal form to a date (entered) (templates-v1)',
  description: '400 OCCURRENCE_RESOLVE_INVALID (not posted, other company, other kind, already linked); 409 OCCURRENCE_TAKEN.',
  params: occurrenceParams,
}), validate(resolveOccurrenceSchema), async (req, res) => {
  const occurrence = await occurrences.resolveOccurrence(actor(req), uuidParam(req.params['id']), dateParam(req.params['date']), req.body.transactionId);
  res.json({ occurrence });
});
