// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { Router } from 'express';
import { classificationThresholdsSchema } from '@kis-books/shared';
import { authenticate } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { auditLog } from '../middleware/audit.js';
import { AppError } from '../utils/errors.js';
import * as thresholdsService from '../services/practice-thresholds.service.js';

export const practiceSettingsRouter = Router();

practiceSettingsRouter.use(authenticate);

// Block client user_type from Practice config endpoints. Readonly
// staff is allowed for GET (thresholds are non-sensitive view-only
// info) but the PUT below additionally enforces owner role.
practiceSettingsRouter.use((req, _res, next) => {
  if (req.userType === 'client') {
    throw AppError.notFound('Feature not available');
  }
  next();
});

// GET — every staff role can read thresholds (useful for
// surfacing the values in the review UI). Readonly is allowed
// because the thresholds aren't sensitive.
practiceSettingsRouter.get('/', async (req, res) => {
  const thresholds = await thresholdsService.getThresholds(req.tenantId);
  res.json({ classificationThresholds: thresholds });
});

// PUT — owner only. Mutating thresholds changes how every
// bucket row is computed at next upsert, which is a meaningful
// config change deserving an audit log entry.
practiceSettingsRouter.put(
  '/',
  validate(classificationThresholdsSchema),
  async (req, res) => {
    if (req.userRole !== 'owner') {
      throw AppError.forbidden('Owner role required to change thresholds');
    }
    const before = await thresholdsService.getThresholds(req.tenantId);
    const after = await thresholdsService.setThresholds(req.tenantId, req.body);
    await auditLog(
      req.tenantId,
      'update',
      'practice_settings',
      null,
      { classificationThresholds: before },
      { classificationThresholds: after },
      req.userId,
    );
    res.json({ classificationThresholds: after });
  },
);
