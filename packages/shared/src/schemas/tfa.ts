// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { z } from 'zod';

export const tfaVerifySchema = z.object({
  code: z.string().min(1, 'Code is required').max(20),
  method: z.enum(['email', 'sms', 'totp']),
  trustDevice: z.boolean().optional(),
  deviceFingerprint: z.string().optional(),
});

export const tfaSendCodeSchema = z.object({
  method: z.enum(['email', 'sms']),
});

export const tfaVerifyRecoverySchema = z.object({
  code: z.string().min(1, 'Recovery code is required').max(20),
});

export const tfaEnableSchema = z.object({});

export const tfaDisableSchema = z.object({
  password: z.string().min(1, 'Password is required'),
});

export const tfaAddSmsSchema = z.object({
  phoneNumber: z.string().min(10, 'Phone number must be at least 10 digits').max(20),
});

export const tfaVerifySmsSetupSchema = z.object({
  code: z.string().min(1).max(10),
});

export const tfaVerifyTotpSetupSchema = z.object({
  code: z.string().length(6, 'Code must be 6 digits'),
});

export const tfaSetPreferredMethodSchema = z.object({
  method: z.enum(['email', 'sms', 'totp']),
});

export const tfaRegenerateCodesSchema = z.object({
  password: z.string().min(1, 'Password is required'),
});

export const tfaConfigUpdateSchema = z.object({
  isEnabled: z.boolean().optional(),
  allowedMethods: z.array(z.enum(['email', 'sms', 'totp'])).optional(),
  trustDeviceEnabled: z.boolean().optional(),
  trustDeviceDurationDays: z.number().int().min(1).max(365).optional(),
  codeExpirySeconds: z.number().int().min(60).max(600).optional(),
  codeLength: z.number().int().min(6).max(8).optional(),
  maxAttempts: z.number().int().min(3).max(10).optional(),
  lockoutDurationMinutes: z.number().int().min(1).max(60).optional(),
  smsProvider: z.enum(['twilio', 'textlinksms']).nullable().optional(),
  smsTwilioAccountSid: z.string().optional(),
  smsTwilioAuthToken: z.string().optional(),
  smsTwilioFromNumber: z.string().optional(),
  smsTextlinkApiKey: z.string().optional(),
  smsTextlinkServiceName: z.string().optional(),
});

export const tfaSmsTestSchema = z.object({
  phoneNumber: z.string().min(10).max(20),
});
