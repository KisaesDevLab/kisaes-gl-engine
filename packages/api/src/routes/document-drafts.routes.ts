// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Document drafts and vendor layout templates (U-92, document-drafts-v1;
// idempotency-docs-v1). Company-scoped like every books router: another
// company's draft or layout is 404. See document-draft.service.ts and
// docs/DESKTOP.md "Document drafts".

import { Router } from 'express';
import { z } from 'zod';
import {
  createDocumentDraftSchema, updateDocumentDraftSchema, documentDraftListQuerySchema, convertDocumentDraftSchema,
  putVendorLayoutTemplateSchema, vendorLayoutTemplateListQuerySchema, deleteVendorLayoutTemplateSchema,
  convertBillBodySchema, convertExpenseBodySchema, convertCheckBodySchema, DOCUMENT_DRAFT_LIST_MAX_OFFSET,
} from '@kis-books/shared';
import { authenticate } from '../middleware/auth.js';
import { companyContext } from '../middleware/company.js';
import { validate } from '../middleware/validate.js';
import { describe } from '../middleware/describe.js';
import { idempotent } from '../middleware/idempotent.js';
import { closingPasswordLimiter } from '../middleware/closing-password-limiter.js';
import { lockContextMiddleware } from '../services/lock-context.js';
import {
  requireAnyDocumentResource, requireCreateKindPermission, requireConvertKindPermission, canChangeKind,
} from '../middleware/document-draft-permission.js';
import * as draftService from '../services/document-draft.service.js';

export const documentDraftsRouter = Router();
documentDraftsRouter.use(authenticate);
documentDraftsRouter.use(companyContext);
documentDraftsRouter.use(requireAnyDocumentResource());

const idParams = z.object({ id: z.string().uuid() });
const closingPasswordDoc = z.string().optional().describe('closing-date password (closing-password-v1), top level only; never stored or echoed');
const permissionNote = 'Permission by kind: bill and unknown need bills, check needs checks, card_charge and cash_expense need transactions (full access to change, view of any of the three to read).';

// Idempotency-Key (idempotency-docs-v1) on create and convert. The readers
// replay the draft as it is now when no stored response is left.
const keyedCreate = idempotent({
  successStatus: 201,
  replay: async (req, entity) => ({ draft: await draftService.get(req.tenantId, req.companyId, entity!.id) }),
});
const keyedConvert = idempotent({
  successStatus: 201,
  replay: async (req) => draftService.convertResponse(req.tenantId, req.companyId, req.params['id']!),
});

documentDraftsRouter.post('/', requireCreateKindPermission, keyedCreate, validate(createDocumentDraftSchema), describe({
  summary: 'Claim an uploaded file as a document draft',
  description: 'Response 201 `{draft}`. `attachmentId` names a draft attachment (attachable type `draft`) visible to the company (else 404; ' +
    'another type 422 ATTACHMENT_NOT_DRAFT). The engine hashes the stored file: a file this company already has as a draft that is not ' +
    'discarded is 409 DOCUMENT_ALREADY_CLAIMED (`details.draftId`); two concurrent claims of one file give one draft. The attachment ' +
    `is left a draft attachment and takes the company. ${permissionNote} Keyed: idempotency-docs-v1.`,
}), async (req, res) => {
  const draft = await draftService.create(req.tenantId, req.companyId, req.userId, req.body);
  res.status(201).json({ draft });
});

documentDraftsRouter.get('/', describe({
  summary: 'List document drafts',
  description: 'Response `{drafts, total}`, newest first. `status` is one or a comma-joined set of new, ready, failed, converted, discarded. ' +
    `\`limit\` 1-200 (default 50), \`offset\` 0-${DOCUMENT_DRAFT_LIST_MAX_OFFSET}. ` + '`view=summary` leaves each draft\'s reading (`fields`, `lines`, `checks`) out; ' +
    'GET /:id returns it. Readable with view access to any of bills, checks or transactions, whatever the drafts\' kinds.',
  query: documentDraftListQuerySchema,
}), async (req, res) => {
  const q = documentDraftListQuerySchema.parse(req.query);
  res.json(await draftService.list(req.tenantId, req.companyId, q));
});

documentDraftsRouter.get('/:id', describe({ summary: 'Get a document draft', description: 'Response `{draft}`.', params: idParams }), async (req, res) => {
  res.json({ draft: await draftService.get(req.tenantId, req.companyId, req.params['id']!) });
});

documentDraftsRouter.get('/:id/duplicates', describe({
  summary: 'Possible duplicates of a document draft',
  description: 'Response `{matches: [{source: "transaction"|"draft", id, reason: "reference"|"amount_date", txnType, kind, date, total, reference}]}`: ' +
    'posted bills, expenses and checks (not void or deleted) and other live drafts of the draft\'s vendor (`suggestedContactId`) with the same ' +
    `normalized reference (leading zeros of every digit run dropped, lower case, ASCII letters and digits only: INV-00123 = inv123) or the same total within ${draftService.DUPLICATE_WINDOW_DAYS} days of its date. ` +
    'Empty without a vendor. Totals compare as numeric.',
  params: idParams,
}), async (req, res) => {
  res.json(await draftService.duplicates(req.tenantId, req.companyId, req.params['id']!));
});

documentDraftsRouter.put('/:id', validate(updateDocumentDraftSchema), describe({
  summary: 'Store a reading on a document draft',
  description: 'Response 200 `{draft}`. `status` ready (a reading) or failed (`failureReason`). Omitted fields keep their value. ' +
    '`expectedUpdatedAt` is required: the draft\'s updatedAt as last read; a mismatch is 409 STALE (`details.updatedAt`). A converted or ' +
    'discarded draft is 409 DOCUMENT_DRAFT_CLOSED. `fields`, `lines`, `checks`: JSON with decimal-string amounts and integer numbers only ' +
    `(bounded). ${permissionNote} Changing the kind also needs the new kind's permission.`,
  params: idParams,
}), async (req, res) => {
  const draft = await draftService.update(req.tenantId, req.companyId, req.userId, req.params['id']!, req.body, (k) => canChangeKind(req, k));
  res.json({ draft });
});

documentDraftsRouter.post('/:id/discard', describe({
  summary: 'Discard a document draft',
  description: 'Response 200 `{draft}`. Frees the file\'s claim; the file itself is left (delete it with DELETE /attachments/:id afterwards). ' +
    `Already discarded: 200, nothing changes. Converted: 409 DOCUMENT_DRAFT_CLOSED. ${permissionNote}`,
  params: idParams,
}), async (req, res) => {
  const draft = await draftService.discard(req.tenantId, req.companyId, req.userId, req.params['id']!, (k) => canChangeKind(req, k));
  res.json({ draft });
});

const convertBodyDoc = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('bill'), body: convertBillBodySchema }),
  z.object({ kind: z.literal('card_charge'), body: convertExpenseBodySchema }),
  z.object({ kind: z.literal('cash_expense'), body: convertExpenseBodySchema }),
  z.object({ kind: z.literal('check'), body: convertCheckBodySchema }),
]).and(z.object({
  expectedUpdatedAt: z.string().datetime({ offset: true }),
  acknowledgeDuplicateOf: z.array(z.string().uuid()).max(50).optional(),
  closingPassword: closingPasswordDoc,
  overrideConfirmed: z.boolean().optional(),
}));

documentDraftsRouter.post('/:id/convert', requireConvertKindPermission, keyedConvert, closingPasswordLimiter, lockContextMiddleware,
  validate(convertDocumentDraftSchema), describe({
    summary: 'Convert a document draft into a bill, card charge, cash expense or check',
    description: 'Response 201 `{draft, transaction, draftMatches}`. `body` is the kind\'s own create body (bill: POST /bills; card_charge and cash_expense: ' +
      'POST /transactions expense with payFromAccountId; check: POST /checks), without draftAttachmentId. One database transaction: the draft ' +
      'is locked (converted or discarded 409 DOCUMENT_DRAFT_CLOSED with details.transactionId; stale 409 STALE; the draft\'s current kind ' +
      'needs its permission too, 403), the vendor must be tenant-wide or the company\'s (404), the record posts through ' +
      'the kind\'s service (a date on or before the closing date needs the top-level closingPassword: 423 TB_PERIOD_LOCKED / 403 ' +
      'CLOSING_PASSWORD_INVALID), then posted bills, expenses and checks of the same vendor with the same reference, or the same total within ' +
      `${draftService.DUPLICATE_WINDOW_DAYS} days, that are not in acknowledgeDuplicateOf are 409 POSSIBLE_DUPLICATE (details.matches); ` +
      'other live drafts that match are listed in details.draftMatches (and in the 201 response\'s draftMatches) but never block. The draft\'s ' +
      'file, and other files on its draft key that no other live draft reads, move to the new record (attachable type bill, or expense for ' +
      'the other kinds) with an audit row each; the draft is marked converted. ' +
      'Any refusal leaves nothing written. Missing or other kind: 400 INVALID_KIND. ' +
      `${permissionNote} Keyed: idempotency-docs-v1 (the permission is checked before a replay).`,
    body: convertBodyDoc,
    params: idParams,
  }), async (req, res) => {
    const { transactionId: _t } = await draftService.convert(req.tenantId, req.companyId, req.userId, req.params['id']!, req.body, (k) => canChangeKind(req, k));
    res.status(201).json(await draftService.convertResponse(req.tenantId, req.companyId, req.params['id']!));
  });

// ── Vendor layout templates ──────────────────────────────────────────

export const vendorLayoutTemplatesRouter = Router();
vendorLayoutTemplatesRouter.use(authenticate);
vendorLayoutTemplatesRouter.use(companyContext);
vendorLayoutTemplatesRouter.use(requireAnyDocumentResource());

vendorLayoutTemplatesRouter.get('/', describe({
  summary: 'List vendor layout templates',
  description: 'Response `{templates}` of the company (at most 500), newest first; `contactId` filters by vendor.',
  query: vendorLayoutTemplateListQuerySchema,
}), async (req, res) => {
  const q = vendorLayoutTemplateListQuerySchema.parse(req.query);
  res.json(await draftService.listTemplates(req.tenantId, req.companyId, q.contactId));
});

vendorLayoutTemplatesRouter.put('/', validate(putVendorLayoutTemplateSchema), describe({
  summary: 'Create or replace a vendor layout template',
  description: 'Response 201 `{template}` when created, 200 when replaced. Keyed by (company, contactId, fingerprint). `expectedUpdatedAt` null ' +
    'creates only (409 STALE when it exists); otherwise it must equal the stored updatedAt (409 STALE). The vendor must be tenant-wide or the ' +
    'company\'s (404). At most 500 per company (409 TEMPLATE_LIMIT). Audited.',
}), async (req, res) => {
  const { template, created } = await draftService.putTemplate(req.tenantId, req.companyId, req.userId, req.body);
  res.status(created ? 201 : 200).json({ template });
});

vendorLayoutTemplatesRouter.delete('/:id', describe({
  summary: 'Delete a vendor layout template',
  description: 'Response 204. Optional query `expectedUpdatedAt` (409 STALE on a mismatch). Audited.',
  params: idParams,
  query: deleteVendorLayoutTemplateSchema,
}), async (req, res) => {
  const q = deleteVendorLayoutTemplateSchema.parse(req.query);
  await draftService.deleteTemplate(req.tenantId, req.companyId, req.userId, req.params['id']!, q.expectedUpdatedAt);
  res.status(204).end();
});
