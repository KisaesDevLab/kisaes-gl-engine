// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { z } from 'zod';

export const magicLinkSendSchema = z.object({
  email: z.string().email('Invalid email address'),
});

export const magicLinkVerifySchema = z.object({
  token: z.string().min(1, 'Token is required'),
});

export const passkeyRenameSchema = z.object({
  name: z.string().min(1).max(255),
});

export const passkeyRegisterNameSchema = z.object({
  name: z.string().max(255).optional(),
});

export const preferredLoginMethodSchema = z.object({
  method: z.enum(['password', 'magic_link', 'passkey']),
});

export const passwordlessConfigUpdateSchema = z.object({
  passkeysEnabled: z.boolean().optional(),
  magicLinkEnabled: z.boolean().optional(),
  magicLinkExpiryMinutes: z.number().int().min(5).max(60).optional(),
  magicLinkMaxAttempts: z.number().int().min(1).max(10).optional(),
});
