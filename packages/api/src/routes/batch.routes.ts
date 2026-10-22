// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { Router, type Request, type Response, type NextFunction } from 'express';
import multer from 'multer';
import { z } from 'zod';
import {
  batchValidateSchema, batchSaveSchema, batchParseCsvSchema,
  batchValidateGroupsSchema, batchSaveGroupsSchema, BATCH_MAX_ROWS,
} from '@kis-books/shared';
import { authenticate } from '../middleware/auth.js';
import { requireResource } from '../middleware/permission.js';
import { companyContext } from '../middleware/company.js';
import { validate } from '../middleware/validate.js';
import { describe } from '../middleware/describe.js';
import { closingPasswordLimiter } from '../middleware/closing-password-limiter.js';
import { lockContextMiddleware } from '../services/lock-context.js';
import { AppError } from '../utils/errors.js';
import * as batchService from '../services/batch.service.js';
import * as batchGroups from '../services/batch-groups.service.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

export const batchRouter = Router();
batchRouter.use(authenticate);
batchRouter.use(companyContext);
batchRouter.use(requireResource('batch_entry'));

/** The grouped shape (U-69) is told apart from the single-type one by `groups`. */
function isGrouped(req: Request): boolean {
  const body = req.body as Record<string, unknown> | undefined;
  return !!body && typeof body === 'object' && 'groups' in body;
}

/** validate() with the schema of the body's shape. */
function validateShape(single: Parameters<typeof validate>[0], grouped: Parameters<typeof validate>[0]) {
  const v1 = validate(single);
  const v2 = validate(grouped);
  return (req: Request, res: Response, next: NextFunction) => (isGrouped(req) ? v2 : v1)(req, res, next);
}

const groupsDoc = 'Grouped shape (ClientLedger Bulk Entry, batch-mixed-v1): `{groups: [{txn_type: check|expense|credit_card_charge|credit_card_credit|deposit|journal_entry, context_account_id, rows}]}`, '
  + `at most ${BATCH_MAX_ROWS} rows in all, rowNumber unique across groups; amount / debit / credit are decimal strings (a JSON number is 400 VALIDATION_ERROR), at most 4 places, never rounded. `
  + 'The single-type shape `{txn_type, context_account_id, rows}` (numbers or strings, every txn_type) is unchanged.';

batchRouter.post('/validate', describe({
  summary: 'Validate batch rows; saves nothing',
  description: `${groupsDoc} Grouped response: \`{validCount, invalidCount, closingDate, closingPasswordRequired, closedPeriodRowNumbers, rows: [{rowNumber, groupIndex, txnType, status: valid|warning|invalid, resolvedContactId, resolvedAccountId, errors: [{field, message, code?}], newContact?, closedPeriod, entryKey?}]}\`; a missing or wrong context account is 400 BATCH_CONTEXT_ACCOUNT_REQUIRED / BATCH_CONTEXT_ACCOUNT_INVALID with \`details.groupIndex\`.`,
  body: z.union([batchValidateSchema, batchValidateGroupsSchema]),
}), validateShape(batchValidateSchema, batchValidateGroupsSchema), async (req, res) => {
  if (isGrouped(req)) {
    res.json(await batchGroups.validateBatchGroups(req.tenantId, req.companyId, req.body.groups));
    return;
  }
  const { txn_type, context_account_id, rows } = req.body;
  const result = await batchService.validateBatch(req.tenantId, txn_type, context_account_id ?? null, rows);
  res.json(result);
});

// The grouped shape saves every group in ONE database transaction
// (batch-atomic-v1): a failing row rolls back the whole request. Rows dated
// on or before the closing date take the closing-date password like the
// single forms (batch-closing-v1). An Idempotency-Key header replays the
// stored result of the same body and refuses a different one (409)
// (batch-idempotent-v1); the single-type shape does not take one.
batchRouter.post('/save', closingPasswordLimiter, lockContextMiddleware, describe({
  summary: 'Save batch rows',
  description: `${groupsDoc} Grouped save: all or nothing. 201 \`{batchId, savedCount, createdContacts: [{displayName, id, contactType}], transactions: [{rowNumber, id, txnType, txnNumber, checkNumber?}]}\`; every transaction has source 'batch' and source_id = batchId. `
    + 'Errors (nothing posted): 400 BATCH_INVALID / BATCH_CONTACT_NOT_FOUND with `details.rowNumbers` and `details.rows: [{rowNumber, errors}]`; a posting failure keeps its status and code and adds `details.rowNumbers` / `details.rows`; '
    + '423 TB_PERIOD_LOCKED and 403 CLOSING_PASSWORD_INVALID add `details.rowNumbers` (the rows dated on or before the closing date); 409 IDEMPOTENCY_KEY_REUSED (same Idempotency-Key, different body); 400 IDEMPOTENCY_KEY_INVALID / IDEMPOTENCY_UNSUPPORTED. A replay answers 201 with the stored body and header `Idempotent-Replayed: true`. '
    + 'Check rows: refNo is the check number (unique per bank account, counter advanced; empty = next number), printLater queues it (no number). Card credits post as a deposit into the card account. Journal entry rows with the same `entry` key (else the same date and refNo) form one entry that must balance exactly; an A/R or A/P row needs a name. auto_create_contacts creates unknown vendors (customers on deposit rows); without it an unknown name is 400 BATCH_CONTACT_NOT_FOUND.',
  body: z.union([
    batchSaveSchema,
    batchSaveGroupsSchema.innerType().extend({
      closingPassword: z.string().optional().describe('closing-date password (closing-password-v1); never stored or echoed'),
    }),
  ]),
}), validateShape(batchSaveSchema, batchSaveGroupsSchema), async (req, res) => {
  const header = req.get('Idempotency-Key');
  if (isGrouped(req)) {
    const outcome = await batchGroups.saveBatchGroups(req.tenantId, req.companyId, req.body, {
      userId: req.userId, ...(header !== undefined ? { idempotencyKey: header } : {}),
    });
    if (outcome.replayed) res.setHeader('Idempotent-Replayed', 'true');
    res.status(outcome.status).json(outcome.body);
    return;
  }
  if (header !== undefined) {
    throw AppError.badRequest('Idempotency-Key is supported on the grouped batch shape only', 'IDEMPOTENCY_UNSUPPORTED');
  }
  const { txn_type, context_account_id, rows, auto_create_contacts, skip_invalid } = req.body;
  const result = await batchService.saveBatch(
    req.tenantId, txn_type, context_account_id ?? null, rows,
    { autoCreateContacts: auto_create_contacts, skipInvalid: skip_invalid },
    req.userId, req.companyId,
  );
  res.status(201).json(result);
});

// Suggest the category account to prefill when a contact is picked on a
// batch line (contact default → most-recently-used category account).
batchRouter.get('/suggest-account', async (req, res) => {
  const contactId = typeof req.query['contact_id'] === 'string' ? req.query['contact_id'] : '';
  if (!contactId) { res.status(400).json({ error: { message: 'contact_id is required' } }); return; }
  const result = await batchService.suggestAccountForContact(req.tenantId, contactId);
  res.json(result);
});

// `parse-csv` is multipart — validate() can't pre-validate multipart
// bodies before multer parses them, so validate the remaining form
// fields after the file is loaded.
batchRouter.post('/parse-csv', upload.single('file'), async (req, res) => {
  if (!req.file) { res.status(400).json({ error: { message: 'No file' } }); return; }
  const parsed = batchParseCsvSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.message } });
    return;
  }
  const { txn_type, column_mapping } = parsed.data;
  let mapping: Record<string, number> | undefined;
  if (column_mapping) {
    if (typeof column_mapping === 'string') {
      try {
        mapping = JSON.parse(column_mapping);
      } catch {
        res.status(400).json({ error: { message: 'column_mapping must be valid JSON' } });
        return;
      }
    } else {
      mapping = column_mapping;
    }
  }
  const rows = batchService.parseCsv(req.file.buffer.toString('utf-8'), txn_type || 'expense', mapping);
  res.json({ rows, count: rows.length });
});
