// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Tax Estimator request schemas (features/tax-estimator/MODULE.md).
import { z } from 'zod';

const MIN_TAX_YEAR = 2000;
const MAX_TAX_YEAR = 2100;
const MIN_REASON_LEN = 3;
const MAX_REASON_LEN = 2000;
const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 50;

export const taxYearParamSchema = z.coerce.number().int().min(MIN_TAX_YEAR).max(MAX_TAX_YEAR);

/** Concrete parameter key, e.g. `brackets.mfj`. Registry membership is checked by the service. */
export const taxParameterKeySchema = z.string().min(1).max(120).regex(/^[a-z0-9_]+(\.[a-z0-9_]+)*$/);

export const taxParameterYearParamsSchema = z.object({ year: taxYearParamSchema });
export const taxParameterKeyParamsSchema = z.object({ year: taxYearParamSchema, key: taxParameterKeySchema });

export const setTaxParameterOverrideSchema = z.object({
  value: z.unknown().refine((v) => v !== undefined, { message: 'value is required' }),
  reason: z.string().trim().min(MIN_REASON_LEN).max(MAX_REASON_LEN),
});

export const adoptShippedParametersSchema = z.object({
  keys: z.array(taxParameterKeySchema).max(MAX_LIMIT).optional(),
});

export const taxParameterChangesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
});
