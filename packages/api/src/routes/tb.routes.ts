// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { createFirmTaxCodeSchema, updateFirmTaxCodeSchema } from '@kis-books/shared';
import { authenticate } from '../middleware/auth.js';
import { companyContext } from '../middleware/company.js';
import { requireResource } from '../middleware/permission.js';
import { validate } from '../middleware/validate.js';
import { AppError } from '../utils/errors.js';
import * as firmCodesService from '../services/tb/firm-tax-codes.service.js';

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
