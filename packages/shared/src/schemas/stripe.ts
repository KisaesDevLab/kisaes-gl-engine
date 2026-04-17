// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { z } from 'zod';

export const createPaymentIntentSchema = z.object({
  amount: z.string().min(1, 'Amount is required'),
});

export const stripeConfigSchema = z.object({
  secretKey: z.string().min(1, 'Secret key is required').refine(s => s.startsWith('sk_'), 'Secret key must start with sk_'),
  publishableKey: z.string().min(1, 'Publishable key is required').refine(s => s.startsWith('pk_'), 'Publishable key must start with pk_'),
  webhookSecret: z.string().min(1, 'Webhook secret is required').refine(s => s.startsWith('whsec_'), 'Webhook secret must start with whsec_'),
});

export type CreatePaymentIntentInput = z.infer<typeof createPaymentIntentSchema>;
export type StripeConfigInput = z.infer<typeof stripeConfigSchema>;
