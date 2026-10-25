// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { Router } from 'express';
import { z } from 'zod';
import { PAYMENT_TERMS, PAYMENT_TERM_CODES } from '@kis-books/shared';
import { authenticate } from '../middleware/auth.js';
import { describe } from '../middleware/describe.js';

/**
 * GET /api/v1/payment-terms (U-86, bill-terms-v1): the fixed payment-terms
 * table bills and vendor defaults use, so a client doesn't hard-code it.
 * Read-only and the same for every company; signing in is enough.
 */
export const paymentTermsRouter = Router();
paymentTermsRouter.use(authenticate);

paymentTermsRouter.get('/', describe({
  summary: 'The payment-terms table',
  description: 'Response {terms: [{code, label, netDays, discountPercent, discountDays}]}. netDays is null for custom (the bill carries termsDays); ' +
    'discountPercent is a 4-place decimal string ("2.0000" = 2 %) or null.',
  response: z.object({
    terms: z.array(z.object({
      code: z.enum(PAYMENT_TERM_CODES),
      label: z.string(),
      netDays: z.number().int().nullable(),
      discountPercent: z.string().nullable(),
      discountDays: z.number().int().nullable(),
    })),
  }),
}), (_req, res) => {
  res.json({ terms: PAYMENT_TERMS });
});
