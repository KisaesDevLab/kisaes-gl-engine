// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { z } from 'zod';

// Firm-level Vibe Practice Management peer settings. The key material is
// PUBLIC (PM keeps the private half); exactly one of publicKeyPem /
// jwksUrl may be set. Fields omitted keep their stored value; an explicit
// null clears.
export const vibePmSettingsSchema = z.object({
  isEnabled: z.boolean().optional(),
  issuer: z.string().trim().min(3).max(255).regex(/^\S+$/, 'Issuer must not contain whitespace').optional(),
  publicKeyPem: z.string().max(10_000).nullable().optional(),
  jwksUrl: z.string().max(512).nullable().optional(),
});
export type VibePmSettingsInput = z.infer<typeof vibePmSettingsSchema>;

export const peerTestTokenSchema = z.object({
  token: z.string().min(20).max(8192),
});
export type PeerTestTokenInput = z.infer<typeof peerTestTokenSchema>;

export const PM_CLIENT_ID_PATTERN = /^[A-Za-z0-9._:@~-]{1,120}$/;

export const createPmClientLinkSchema = z.object({
  pmClientId: z.string().trim().regex(PM_CLIENT_ID_PATTERN, 'PM client id may contain letters, digits and . _ : @ ~ -'),
  tenantId: z.string().uuid(),
  companyId: z.string().uuid(),
  contactId: z.string().uuid(),
});
export type CreatePmClientLinkInput = z.infer<typeof createPmClientLinkSchema>;
