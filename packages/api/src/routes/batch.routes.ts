// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { Router } from 'express';
import multer from 'multer';
import { batchValidateSchema, batchSaveSchema, batchParseCsvSchema } from '@kis-books/shared';
import { authenticate } from '../middleware/auth.js';
import { requireResource } from '../middleware/permission.js';
import { companyContext } from '../middleware/company.js';
import { validate } from '../middleware/validate.js';
import * as batchService from '../services/batch.service.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

export const batchRouter = Router();
batchRouter.use(authenticate);
batchRouter.use(companyContext);
batchRouter.use(requireResource('batch_entry'));

batchRouter.post('/validate', validate(batchValidateSchema), async (req, res) => {
  const { txn_type, context_account_id, rows } = req.body;
  const result = await batchService.validateBatch(req.tenantId, txn_type, context_account_id ?? null, rows);
  res.json(result);
});

batchRouter.post('/save', validate(batchSaveSchema), async (req, res) => {
  const { txn_type, context_account_id, rows, auto_create_contacts, skip_invalid } = req.body;
  const result = await batchService.saveBatch(
    req.tenantId, txn_type, context_account_id ?? null, rows,
    { autoCreateContacts: auto_create_contacts, skipInvalid: skip_invalid },
    req.userId, req.companyId,
  );
  res.status(201).json(result);
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
