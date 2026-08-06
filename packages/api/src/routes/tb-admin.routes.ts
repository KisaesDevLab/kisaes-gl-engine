// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// System-wide tax-code seed administration (Phase 2, ADR-TB-05).
// Super-admin only: the seed library is global reference data shared by
// every tenant, like /admin/feature-flags. Firm custom codes are NOT
// here — they're tenant/firm-scoped on the tb router.

import { Router } from 'express';
import multer from 'multer';
import { seedImportSchema } from '@kis-books/shared';
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
