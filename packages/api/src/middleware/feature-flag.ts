// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import type { Request, Response, NextFunction } from 'express';
import type { PracticeFeatureFlagKey } from '@kis-books/shared';
import { AppError } from '../utils/errors.js';
import * as featureFlagsService from '../services/feature-flags.service.js';

/**
 * Tenant feature-flag gate for ordinary (non-Practice) routers. Unlike
 * requirePracticeAccess it does NOT block client-type users or the readonly
 * role: those are the permission matrix's job (requireResource). When the
 * flag is off the surface pretends not to exist (404), matching the
 * Practice convention so probing can't enumerate dormant features.
 */
export function requireFeatureFlag(flag: PracticeFeatureFlagKey) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const enabled = await featureFlagsService.isEnabled(req.tenantId, flag);
    if (!enabled) throw AppError.notFound('Feature not available');
    next();
  };
}
