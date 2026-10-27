// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { Router } from 'express';
import { z } from 'zod';
import {
  clientAccountMappingSchema,
  clientRulesOverviewQuerySchema,
  clientRulesPostSchema,
} from '@kis-books/shared';
import { authenticate, requireSessionAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { AppError } from '../utils/errors.js';
import * as overviewService from '../services/client-rules-overview.service.js';

// Client rules overview — cross-client, so it carries the same contract as
// /auth/accessible-tenants/banking: session auth only (an API key is minted
// against one tenant and must not reach the others), staff only, and the
// tenant set always comes from the caller's user_tenant_access rows; any
// tenantId in a request is re-checked in the service.
export const clientRulesOverviewRouter = Router();
clientRulesOverviewRouter.use(authenticate);
clientRulesOverviewRouter.use(requireSessionAuth);
clientRulesOverviewRouter.use((req, _res, next) => {
  if (req.userType === 'client') {
    throw AppError.forbidden('Client rules overview is for firm staff', 'STAFF_ONLY');
  }
  next();
});

const tenantParamSchema = z.object({ tenantId: z.string().uuid() });

clientRulesOverviewRouter.get('/', async (req, res) => {
  const query = clientRulesOverviewQuerySchema.parse(req.query);
  const result = await overviewService.getOverview(req.userId, query);
  res.json(result);
});

clientRulesOverviewRouter.post('/post', validate(clientRulesPostSchema), async (req, res) => {
  const result = await overviewService.post(req.userId, req.body.tenantIds, req.body.ruleIds);
  res.json(result);
});

clientRulesOverviewRouter.get('/tenants/:tenantId/mapping-options', async (req, res) => {
  const { tenantId } = tenantParamSchema.parse(req.params);
  const result = await overviewService.getMappingOptions(req.userId, tenantId);
  res.json(result);
});

clientRulesOverviewRouter.put('/tenants/:tenantId/mappings', validate(clientAccountMappingSchema), async (req, res) => {
  const { tenantId } = tenantParamSchema.parse(req.params);
  const mapping = await overviewService.upsertMapping(req.userId, tenantId, req.body);
  res.json(mapping);
});
