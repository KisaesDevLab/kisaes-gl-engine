// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { Router } from 'express';
import {
  updateTenantReportSettingsSchema,
  createDetailTypeSchema,
  resolvePLLabels,
  resolveBSLabels,
  resolveCFLabels,
} from '@kis-books/shared';
import { authenticate } from '../middleware/auth.js';
import { requireResource } from '../middleware/permission.js';
import { validate } from '../middleware/validate.js';
import * as service from '../services/tenant-report-settings.service.js';
import * as detailTypesService from '../services/detail-types.service.js';

export const tenantSettingsRouter = Router();
tenantSettingsRouter.use(authenticate);
tenantSettingsRouter.use(requireResource('company_settings'));

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

// ─── Custom detail types ─────────────────────────────────────────
// Built-ins come from @kis-books/shared DETAIL_TYPES; tenants can add
// their own per account type. GET returns the merged list the account
// forms consume plus the raw custom rows for the management UI.
// requireResource('company_settings') above already gates reads to
// 'read' and mutations to 'update' (owner / accountant).

tenantSettingsRouter.get('/detail-types', async (req, res) => {
  const [merged, custom] = await Promise.all([
    detailTypesService.listMerged(req.tenantId),
    detailTypesService.listCustom(req.tenantId),
  ]);
  res.json({ detailTypes: merged, custom });
});

tenantSettingsRouter.post('/detail-types', validate(createDetailTypeSchema), async (req, res) => {
  const created = await detailTypesService.create(req.tenantId, req.body, req.userId);
  res.status(201).json(created);
});

tenantSettingsRouter.delete('/detail-types/:id', async (req, res) => {
  await detailTypesService.remove(req.tenantId, req.params['id']!, req.userId);
  res.status(204).end();
});
