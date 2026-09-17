// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import { authenticate } from '../middleware/auth.js';
import { requirePermission } from '../middleware/permission.js';
import { companyContext } from '../middleware/company.js';
import { expensiveOpLimiter } from '../middleware/expensive-op-limiter.js';
import * as exportService from '../services/export.service.js';
import * as importService from '../services/import.service.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

export const exportRouter = Router();
exportRouter.use(authenticate);
exportRouter.use(companyContext);
// Whole-book export/backup/restore is a company-administration capability:
// it hands over the entire ledger, contacts, attachments and audit trail
// (or deletes/replaces backups). Gate on company_settings:update so
// readonly members and permission-templated bookkeepers / external client
// users cannot exfiltrate the books with only e.g. invoices:read.
exportRouter.use(requirePermission('company_settings', 'update'));
exportRouter.use(expensiveOpLimiter);

// Optional inclusive YYYY-MM-DD window on transaction date. Malformed
// values are a 400 rather than silently exporting everything — an
// accountant who asked for one tax year must not get the whole ledger.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function readDateRange(req: Request, res: Response): exportService.FullExportOptions | null {
  const { start_date, end_date } = req.query as Record<string, string | undefined>;
  const opts: exportService.FullExportOptions = {};
  for (const [key, value] of [['start_date', start_date], ['end_date', end_date]] as const) {
    if (value === undefined || value === '') continue;
    if (!DATE_RE.test(value) || Number.isNaN(Date.parse(value))) {
      res.status(400).json({ error: { message: `${key} must be a date in YYYY-MM-DD format` } });
      return null;
    }
    if (key === 'start_date') opts.startDate = value; else opts.endDate = value;
  }
  if (opts.startDate && opts.endDate && opts.startDate > opts.endDate) {
    res.status(400).json({ error: { message: 'start_date must not be after end_date' } });
    return null;
  }
  return opts;
}

// Full data export as individual CSVs. Returns a manifest (name + row
// count) — the CSV bodies are fetched one at a time via /full/:fileName
// with the same date range, so a large ledger is never serialised into
// a JSON envelope.
exportRouter.get('/full', async (req, res) => {
  const opts = readDateRange(req, res);
  if (!opts) return;
  const files = await exportService.fullExport(req.tenantId, opts);
  res.json({
    files: exportService.EXPORT_FILE_NAMES.map((name) => ({ name, rowCount: files[name].rowCount })),
    startDate: opts.startDate ?? null,
    endDate: opts.endDate ?? null,
  });
});

// Download individual CSV
exportRouter.get('/full/:fileName', async (req, res) => {
  const opts = readDateRange(req, res);
  if (!opts) return;
  const fileName = req.params['fileName']!;
  if (!(exportService.EXPORT_FILE_NAMES as readonly string[]).includes(fileName)) {
    res.status(404).json({ error: { message: 'File not found' } });
    return;
  }
  const files = await exportService.fullExport(req.tenantId, opts);
  const file = files[fileName as exportService.ExportFileName];
  const suffix = opts.startDate || opts.endDate
    ? `_${opts.startDate ?? 'start'}_to_${opts.endDate ?? 'end'}`
    : '';
  const downloadName = fileName.replace(/\.csv$/, `${suffix}.csv`);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${downloadName}"`);
  res.send(file.csv);
});

// Opening balances import
exportRouter.post('/opening-balances', upload.single('file'), async (req, res) => {
  // Optional effective date for the opening JE (multer parses form
  // fields into req.body, so both branches read the same way).
  const asOfDate = typeof req.body?.asOfDate === 'string' && req.body.asOfDate ? req.body.asOfDate : undefined;
  if (req.file) {
    const csvText = req.file.buffer.toString('utf-8');
    const balances = await importService.parseOpeningBalancesCsv(csvText);
    const result = await importService.importOpeningBalances(req.tenantId, balances, req.companyId, asOfDate);
    res.status(201).json(result);
  } else if (req.body.balances) {
    const result = await importService.importOpeningBalances(req.tenantId, req.body.balances, req.companyId, asOfDate);
    res.status(201).json(result);
  } else {
    res.status(400).json({ error: { message: 'No file or balances provided' } });
  }
});
