// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import type { Request, Response, NextFunction } from 'express';
import type { PracticeFeatureFlagKey } from '@kis-books/shared';
import { AppError } from '../utils/errors.js';
import * as featureFlagsService from '../services/feature-flags.service.js';
import { resolveReviewMode } from '../services/suggestion-review-mode.service.js';

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

// Suggestion REVIEW gate for /practice/uncategorized. Tenant users who are
// not staff of the firm managing the books (or not the owner of self-managed
// books) may only SUGGEST categories from Banking → Uncategorized; approving,
// rejecting, clearing suspense and posting to suspense are reserved for
// reviewers. Mount after requirePracticeAccess. See
// services/suggestion-review-mode.service.ts for the rule.
export async function requireSuggestionReviewer(req: Request, _res: Response, next: NextFunction) {
  const m = await resolveReviewMode(req.tenantId, req.userId, req.userRole, !!req.isSuperAdmin);
  if (!m.canReview) {
    throw AppError.forbidden(
      m.managedByFirm
        ? `Only ${m.firmName ?? 'your accounting firm'} can approve categories for this company. Suggest a category from Banking → Uncategorized instead.`
        : 'Only an owner can approve categories here. Suggest a category from Banking → Uncategorized instead.',
      'SUGGEST_ONLY_MODE',
    );
  }
  next();
}
