// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import type { Request, Response, NextFunction } from 'express';
import type { PracticeFeatureFlagKey } from '@kis-books/shared';
import { AppError } from '../utils/errors.js';
import * as featureFlagsService from '../services/feature-flags.service.js';

// Shared gate for every /api/v1/practice/* router. Three checks in
// one middleware so the routes stay terse and the policy lives in
// one place:
//   1. user_type !== 'client' — clients have a separate /portal API
//      surface (Phase 4) and must never reach Practice endpoints
//      even with a bookkeeper role.
//   2. role !== 'readonly' — readonly accounts see no Practice
//      surface at all.
//   3. tenant flag enabled — operator-controlled rollout.
//
// Mount AFTER `authenticate` so req.userType / req.userRole / req.tenantId
// are populated.
export function requirePracticeAccess(flag: PracticeFeatureFlagKey) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    if (req.userType === 'client') {
      // Pretend the surface doesn't exist rather than 403 — clients
      // shouldn't even know Practice routes exist.
      throw AppError.notFound('Feature not available');
    }
    if (req.userRole === 'readonly') {
      throw AppError.forbidden('Insufficient role');
    }
    const enabled = await featureFlagsService.isEnabled(req.tenantId, flag);
    if (!enabled) {
      throw AppError.notFound('Feature not available');
    }
    next();
  };
}
