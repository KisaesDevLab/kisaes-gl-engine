import { Router } from 'express';
import multer from 'multer';
import { authenticate } from '../middleware/auth.js';
import { companyContext } from '../middleware/company.js';
import * as batchService from '../services/batch.service.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

export const batchRouter = Router();
batchRouter.use(authenticate);
batchRouter.use(companyContext);

batchRouter.post('/validate', async (req, res) => {
  const { txn_type, context_account_id, rows } = req.body;
  const result = await batchService.validateBatch(req.tenantId, txn_type, context_account_id, rows);
  res.json(result);
});

batchRouter.post('/save', async (req, res) => {
  const { txn_type, context_account_id, rows, auto_create_contacts, skip_invalid } = req.body;
  const result = await batchService.saveBatch(
    req.tenantId, txn_type, context_account_id, rows,
    { autoCreateContacts: auto_create_contacts, skipInvalid: skip_invalid },
    req.userId, req.companyId,
  );
  res.status(201).json(result);
});

batchRouter.post('/parse-csv', upload.single('file'), async (req, res) => {
  if (!req.file) { res.status(400).json({ error: { message: 'No file' } }); return; }
  const { txn_type, column_mapping } = req.body;
  const mapping = column_mapping ? (typeof column_mapping === 'string' ? JSON.parse(column_mapping) : column_mapping) : undefined;
  const rows = batchService.parseCsv(req.file.buffer.toString('utf-8'), txn_type || 'expense', mapping);
  res.json({ rows, count: rows.length });
});
