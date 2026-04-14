import { Router } from 'express';
import { updateTenantReportSettingsSchema, resolvePLLabels } from '@kis-books/shared';
import { authenticate } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import * as service from '../services/tenant-report-settings.service.js';

export const tenantSettingsRouter = Router();
tenantSettingsRouter.use(authenticate);

tenantSettingsRouter.get('/report', async (req, res) => {
  const settings = await service.getSettings(req.tenantId);
  res.json({
    plLabels: settings.plLabels ?? {},
    resolvedPLLabels: resolvePLLabels(settings.plLabels),
  });
});

tenantSettingsRouter.put('/report', validate(updateTenantReportSettingsSchema), async (req, res) => {
  const next = await service.updateSettings(req.tenantId, req.body);
  res.json({
    plLabels: next.plLabels ?? {},
    resolvedPLLabels: resolvePLLabels(next.plLabels),
  });
});
