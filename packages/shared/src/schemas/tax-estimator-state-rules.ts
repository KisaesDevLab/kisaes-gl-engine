// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Tax Estimator state-rule request schemas (Phase 2).
import { z } from 'zod';
import { STATE_CODES } from '../tax-estimator/stateRuleKeys.js';
import { taxYearParamSchema } from './tax-estimator.js';

const MIN_REASON_LEN = 3;
const MAX_REASON_LEN = 2000;
const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 50;

export const stateCodeSchema = z.string().trim().toUpperCase().pipe(z.enum(STATE_CODES));
export const stateRuleKeySchema = z.string().min(1).max(80).regex(/^[a-z0-9_]+(\.[a-z0-9_]+)*$/);
const stateRuleRefSchema = z.string().regex(/^[A-Z]{2}:[a-z0-9_]+(\.[a-z0-9_]+)*$/);

export const stateRuleYearParamsSchema = z.object({ year: taxYearParamSchema });
export const stateRuleStateParamsSchema = z.object({ year: taxYearParamSchema, state: stateCodeSchema });
export const stateRuleKeyParamsSchema = z.object({ year: taxYearParamSchema, state: stateCodeSchema, key: stateRuleKeySchema });

export const setStateRuleOverrideSchema = z.object({
  value: z.unknown().refine((v) => v !== undefined, { message: 'value is required' }),
  reason: z.string().trim().min(MIN_REASON_LEN).max(MAX_REASON_LEN),
});

export const adoptShippedStateRulesSchema = z.object({
  keys: z.array(stateRuleRefSchema).max(MAX_LIMIT).optional(),
});

export const stateRuleChangesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
});
