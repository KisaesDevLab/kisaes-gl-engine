// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { Router } from 'express';
import { featureFlagToggleSchema } from '@kis-books/shared';
import { authenticate, requireSuperAdmin } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { auditLog } from '../middleware/audit.js';
import * as featureFlagsService from '../services/feature-flags.service.js';

export const featureFlagsRouter = Router();

// Tenant-scoped read — authenticated users only. Uses req.tenantId
// which the authenticate middleware has already sourced from the
// JWT; never trust a client-supplied tenant id.
featureFlagsRouter.get('/', authenticate, async (req, res) => {
  const flags = await featureFlagsService.listFlagsForTenant(req.tenantId);
  res.json({ flags });
});

// Super-admin flag management for a specific tenant. Mounted under
// the admin router prefix in app.ts. Read is scoped to the :tenantId
// path param rather than req.tenantId so super-admin can audit
// another tenant's state without switch-tenant side effects.
export const adminFeatureFlagsRouter = Router();

adminFeatureFlagsRouter.get(
  '/:tenantId',
  authenticate,
  requireSuperAdmin,
  async (req, res) => {
    const { tenantId } = req.params as { tenantId: string };
    const flags = await featureFlagsService.listFlagsForTenant(tenantId);
    res.json({ flags });
  },
);

adminFeatureFlagsRouter.post(
  '/:tenantId/:flagKey',
  authenticate,
  requireSuperAdmin,
  validate(featureFlagToggleSchema),
  async (req, res) => {
    const { tenantId, flagKey } = req.params as { tenantId: string; flagKey: string };
    const change = await featureFlagsService.setFlag(tenantId, flagKey, req.body);
    // entity_id is a UUID column — flagKey is a string, so pass
    // null and encode the flag identity in the JSON payload. The
    // composite key lives in the payload's flagKey field alongside
    // the before/after state the diff viewer needs.
    await auditLog(
      tenantId,
      'update',
      'feature_flag',
      null,
      { flagKey, ...change.before },
      { flagKey, ...change.after },
      req.userId,
    );
    res.json({ flagKey, ...change.after });
  },
);
