// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// System-wide tax-code seed administration (Phase 2, ADR-TB-05).
// Super-admin only: the seed library is global reference data shared by
// every tenant, like /admin/feature-flags. Firm custom codes are NOT
// here — they're tenant/firm-scoped on the tb router.

import { Router } from 'express';
import multer from 'multer';
import { adminTaxCodeCreateSchema, adminTaxCodeUpdateSchema, seedImportSchema } from '@kis-books/shared';
import { authenticate, requireSuperAdmin } from '../middleware/auth.js';
import { AppError } from '../utils/errors.js';
import * as seedService from '../services/tb/tax-code-seed.service.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

export const tbAdminRouter = Router();
tbAdminRouter.use(authenticate);
tbAdminRouter.use(requireSuperAdmin);

tbAdminRouter.get('/seed-versions', async (_req, res) => {
  const versions = await seedService.listVersions();
  res.json({ versions });
});

// Upload → validate → dry-run diff (dryRun=true) or import (false).
// Multipart: file field `file`, plus taxYear / label / dryRun fields.
tbAdminRouter.post('/seed-versions/import', upload.single('file'), async (req, res) => {
  if (!req.file) throw AppError.badRequest('No file uploaded', 'TB_SEED_INVALID');
  const { taxYear, label, dryRun } = seedImportSchema.parse(req.body);
  const result = await seedService.importSeed({
    taxYear,
    label,
    buffer: req.file.buffer,
    dryRun,
    userId: req.userId,
  });
  res.status(dryRun || result.unchanged ? 200 : 201).json(result);
});

// Download a version's full code set in the seed-workbook layout —
// hand-edit and re-import it as a new version, or keep as a backup.
// Registered before the CRUD routes for clarity; path has no overlap.
tbAdminRouter.get('/codes/export', async (req, res) => {
  const versionId = typeof req.query['versionId'] === 'string' ? req.query['versionId'] : '';
  if (!versionId) throw AppError.badRequest('versionId is required', 'TB_SEED_INVALID');
  const file = await seedService.exportCodesXlsx(versionId);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${file.fileName}"`);
  res.send(file.buffer);
});

tbAdminRouter.post('/codes', async (req, res) => {
  const { versionId, ...input } = adminTaxCodeCreateSchema.parse(req.body);
  const created = await seedService.createCode(versionId, input, req.userId);
  res.status(201).json({ code: created });
});

tbAdminRouter.put('/codes/:id', async (req, res) => {
  const patch = adminTaxCodeUpdateSchema.parse(req.body);
  const updated = await seedService.updateCode(String(req.params['id']), patch, req.userId);
  res.json({ code: updated });
});

tbAdminRouter.delete('/codes/:id', async (req, res) => {
  await seedService.deleteCode(String(req.params['id']), req.userId);
  res.status(204).end();
});

tbAdminRouter.get('/codes', async (req, res) => {
  const limit = Math.min(Number(req.query['limit']) || 100, 500);
  const offset = Number(req.query['offset']) || 0;
  const result = await seedService.browseCodes({
    versionId: typeof req.query['versionId'] === 'string' ? req.query['versionId'] : undefined,
    returnForm: typeof req.query['returnForm'] === 'string' ? req.query['returnForm'] : undefined,
    activityType: typeof req.query['activityType'] === 'string' ? req.query['activityType'] : undefined,
    search: typeof req.query['search'] === 'string' ? req.query['search'] : undefined,
    m1Only: req.query['m1Only'] === 'true',
    limit,
    offset,
  });
  res.json({ ...result, limit, offset });
});
