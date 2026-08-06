// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import {
  createFirmTaxCodeSchema, updateFirmTaxCodeSchema,
  upsertTaxProfileSchema, createActivityUnitSchema, updateActivityUnitSchema, mapTagSchema,
} from '@kis-books/shared';
import { authenticate } from '../middleware/auth.js';
import { companyContext } from '../middleware/company.js';
import { requireResource } from '../middleware/permission.js';
import { validate } from '../middleware/validate.js';
import { AppError } from '../utils/errors.js';
import * as firmCodesService from '../services/tb/firm-tax-codes.service.js';
import * as taxProfileService from '../services/tb/tax-profile.service.js';
import * as seedService from '../services/tb/tax-code-seed.service.js';
import * as unitsService from '../services/tb/activity-units.service.js';
import * as balanceEngine from '../services/tb/balance-engine.service.js';

// Trial Balance module router (docs/tb/BUILD_PLAN.md). Firm-side only:
// client-type users get a 404 (surface hidden, same pattern as
// portal-reports.routes.ts), portal contacts never reach /api/v1 at all.
// Company scope = the plan's "entity" (CLAUDE.md rule TB2).
export const tbRouter = Router();
tbRouter.use(authenticate);
tbRouter.use((req, _res, next) => {
  if (req.userType === 'client') {
    next(AppError.notFound('Feature not available'));
    return;
  }
  next();
});
tbRouter.use(companyContext);
tbRouter.use(requireResource('trial_balance'));

// Firm-admin gate (plan 13.1): closing date, seed pinning, and custom
// codes are owner-level acts. Bookkeeper/accountant staff do TB work but
// don't reshape the firm's code library.
function requireFirmAdmin(req: Request, _res: Response, next: NextFunction) {
  if (req.isSuperAdmin || req.userRole === 'owner') {
    next();
    return;
  }
  next(AppError.forbidden('Firm administrator access required', 'TB_FIRM_ADMIN_REQUIRED'));
}

// ── Firm custom tax codes (Phase 2.4, rule TB8) ────────────────────

tbRouter.get('/firm-codes', async (req, res) => {
  const includeInactive = req.query['includeInactive'] === 'true';
  const result = await firmCodesService.listFirmCodes(req.tenantId, includeInactive);
  res.json(result);
});

tbRouter.post('/firm-codes', requireFirmAdmin, validate(createFirmTaxCodeSchema), async (req, res) => {
  const code = await firmCodesService.createFirmCode(req.tenantId, req.body, req.userId);
  res.status(201).json({ code });
});

tbRouter.put('/firm-codes/:id', requireFirmAdmin, validate(updateFirmTaxCodeSchema), async (req, res) => {
  const code = await firmCodesService.updateFirmCode(req.tenantId, String(req.params['id']), req.body, req.userId);
  res.json({ code });
});

tbRouter.delete('/firm-codes/:id', requireFirmAdmin, async (req, res) => {
  const code = await firmCodesService.deactivateFirmCode(req.tenantId, String(req.params['id']), req.userId);
  res.json({ code });
});

// Staff-readable seed-version list (the profile screen's pinning
// selector). Import/browse stay super-admin on /admin/tb.
tbRouter.get('/seed-versions', async (_req, res) => {
  const versions = await seedService.listVersions();
  res.json({ versions });
});

// ── Balance engine (Phase 4, ADR-TB-01) ────────────────────────────

const workpaperQuerySchema = z.object({
  periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  basis: z.enum(['accrual', 'cash']).default('accrual'),
  taxYear: z.coerce.number().int().min(2000).max(2100).optional(),
});

tbRouter.get('/workpaper', async (req, res) => {
  const q = workpaperQuerySchema.parse(req.query);
  const workpaper = await balanceEngine.computeWorkpaper(req.tenantId, req.companyId!, {
    periodEnd: q.periodEnd,
    basis: q.basis,
    taxYear: q.taxYear,
  });
  res.json({ workpaper });
});

tbRouter.get('/assignments', async (req, res) => {
  const assignments = await balanceEngine.listAssignments(req.tenantId, req.companyId!);
  res.json({ assignments });
});

// Cheap change probe (ADR-TB-06 fallback poll + staleness banners).
tbRouter.get('/version', async (req, res) => {
  const glVersionStamp = await balanceEngine.getGlVersionStamp(req.tenantId, req.companyId!);
  res.json({ glVersionStamp });
});

// ── Company tax profile (Phase 3.1) ────────────────────────────────

tbRouter.get('/profile', async (req, res) => {
  const result = await taxProfileService.getProfile(req.tenantId, req.companyId!);
  res.json(result);
});

// Return form + seed pinning reshape every assignment's validity —
// firm-admin territory (13.1).
tbRouter.put('/profile', requireFirmAdmin, validate(upsertTaxProfileSchema), async (req, res) => {
  const profile = await taxProfileService.upsertProfile(req.tenantId, req.companyId!, req.body, req.userId);
  res.json({ profile });
});

// ── Activity units (Phase 3.2) ─────────────────────────────────────

tbRouter.get('/activity-units', async (req, res) => {
  const units = await unitsService.listUnits(req.tenantId, req.companyId!, req.query['includeArchived'] === 'true');
  res.json({ units });
});

tbRouter.post('/activity-units', validate(createActivityUnitSchema), async (req, res) => {
  const unit = await unitsService.createUnit(req.tenantId, req.companyId!, req.body, req.userId);
  res.status(201).json({ unit });
});

tbRouter.put('/activity-units/:id', validate(updateActivityUnitSchema), async (req, res) => {
  const unit = await unitsService.renameUnit(req.tenantId, req.companyId!, String(req.params['id']), req.body.displayName, req.userId);
  res.json({ unit });
});

tbRouter.post('/activity-units/:id/set-default', async (req, res) => {
  const unit = await unitsService.setDefaultUnit(req.tenantId, req.companyId!, String(req.params['id']), req.userId);
  res.json({ unit });
});

tbRouter.delete('/activity-units/:id', async (req, res) => {
  const result = await unitsService.archiveUnit(req.tenantId, req.companyId!, String(req.params['id']), req.userId);
  res.json(result);
});

// ── Tag → activity unit mapping (Phase 3.3) ────────────────────────

tbRouter.get('/tag-mappings', async (req, res) => {
  const result = await unitsService.listTagMappings(req.tenantId, req.companyId!);
  res.json(result);
});

tbRouter.put('/tag-mappings/:tagId', validate(mapTagSchema), async (req, res) => {
  const mapping = await unitsService.mapTag(req.tenantId, req.companyId!, String(req.params['tagId']), req.body.activityUnitId, req.userId);
  res.json({ mapping });
});

tbRouter.delete('/tag-mappings/:tagId', async (req, res) => {
  await unitsService.unmapTag(req.tenantId, req.companyId!, String(req.params['tagId']), req.userId);
  res.status(204).end();
});
