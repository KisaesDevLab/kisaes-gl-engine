// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import { companyContext } from '../middleware/company.js';
import { requireResource } from '../middleware/permission.js';
import { AppError } from '../utils/errors.js';

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

// Module status stub — replaced by real endpoints phase by phase.
tbRouter.get('/status', (_req, res) => {
  res.json({ module: 'tb', phase: 0 });
});
