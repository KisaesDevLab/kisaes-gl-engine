// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { Router } from 'express';
import multer from 'multer';
import { authenticate } from '../middleware/auth.js';
import { companyContext } from '../middleware/company.js';
import { expensiveOpLimiter } from '../middleware/expensive-op-limiter.js';
import * as exportService from '../services/export.service.js';
import * as importService from '../services/import.service.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

export const exportRouter = Router();
exportRouter.use(authenticate);
exportRouter.use(companyContext);
exportRouter.use(expensiveOpLimiter);

// Full data export as individual CSVs (JSON response with file contents)
exportRouter.get('/full', async (req, res) => {
  const files = await exportService.fullExport(req.tenantId);
  res.json({ files });
});

// Download individual CSV
exportRouter.get('/full/:fileName', async (req, res) => {
  const files = await exportService.fullExport(req.tenantId);
  const fileName = req.params['fileName']!;
  const content = files[fileName];
  if (!content) { res.status(404).json({ error: { message: 'File not found' } }); return; }
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  res.send(content);
});

// Opening balances import
exportRouter.post('/opening-balances', upload.single('file'), async (req, res) => {
  if (req.file) {
    const csvText = req.file.buffer.toString('utf-8');
    const balances = await importService.parseOpeningBalancesCsv(csvText);
    const result = await importService.importOpeningBalances(req.tenantId, balances, req.companyId);
    res.status(201).json(result);
  } else if (req.body.balances) {
    const result = await importService.importOpeningBalances(req.tenantId, req.body.balances, req.companyId);
    res.status(201).json(result);
  } else {
    res.status(400).json({ error: { message: 'No file or balances provided' } });
  }
});
