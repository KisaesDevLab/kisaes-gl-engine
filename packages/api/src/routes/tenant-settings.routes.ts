// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { Router } from 'express';
import {
  updateTenantReportSettingsSchema,
  resolvePLLabels,
  resolveBSLabels,
  resolveCFLabels,
} from '@kis-books/shared';
import { authenticate } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import * as service from '../services/tenant-report-settings.service.js';

export const tenantSettingsRouter = Router();
tenantSettingsRouter.use(authenticate);

function shape(settings: Awaited<ReturnType<typeof service.getSettings>>) {
  return {
    plLabels: settings.plLabels ?? {},
    bsLabels: settings.bsLabels ?? {},
    cfLabels: settings.cfLabels ?? {},
    reportFooter: settings.reportFooter ?? '',
    resolvedPLLabels: resolvePLLabels(settings.plLabels),
    resolvedBSLabels: resolveBSLabels(settings.bsLabels),
    resolvedCFLabels: resolveCFLabels(settings.cfLabels),
  };
}

tenantSettingsRouter.get('/report', async (req, res) => {
  const settings = await service.getSettings(req.tenantId);
  res.json(shape(settings));
});

tenantSettingsRouter.put('/report', validate(updateTenantReportSettingsSchema), async (req, res) => {
  const next = await service.updateSettings(req.tenantId, req.body, req.userId);
  res.json(shape(next));
});
