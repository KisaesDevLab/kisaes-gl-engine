import { z } from 'zod';

// ─── User mutation payloads ────────────────────────────────────

export const adminResetPasswordSchema = z.object({
  password: z
    .string()
    .min(12, 'Password must be at least 12 characters')
    .max(128, 'Password must be 128 characters or fewer'),
});
export type AdminResetPasswordInput = z.infer<typeof adminResetPasswordSchema>;

export const adminToggleTenantAccessSchema = z.object({
  tenantId: z.string().uuid(),
});
export type AdminToggleTenantAccessInput = z.infer<typeof adminToggleTenantAccessSchema>;

export const adminRoles = ['owner', 'accountant', 'bookkeeper'] as const;
export const adminSetRoleSchema = z.object({
  role: z.enum(adminRoles),
});
export type AdminSetRoleInput = z.infer<typeof adminSetRoleSchema>;

export const adminCompanyAccessSchema = z.object({
  companyId: z.string().uuid(),
});
export type AdminCompanyAccessInput = z.infer<typeof adminCompanyAccessSchema>;

// ─── System settings payloads ──────────────────────────────────

export const adminSmtpSettingsSchema = z.object({
  smtpHost: z.string().min(1).max(255),
  smtpPort: z.number().int().min(1).max(65535),
  smtpUser: z.string().max(255).optional().default(''),
  smtpPass: z.string().max(512).optional().default(''),
  smtpFrom: z.string().email().max(255),
});
export type AdminSmtpSettingsInput = z.infer<typeof adminSmtpSettingsSchema>;

export const adminSmtpTestSchema = adminSmtpSettingsSchema.extend({
  testEmail: z.string().email().max(255),
});
export type AdminSmtpTestInput = z.infer<typeof adminSmtpTestSchema>;

export const adminApplicationSettingsSchema = z.object({
  applicationUrl: z.string().max(255).optional().default(''),
  maxFileSizeMb: z.string().max(10).optional().default('10'),
  backupSchedule: z.enum(['none', 'daily', 'weekly', 'monthly']).optional().default('none'),
  appName: z.string().max(80).optional(),
});
export type AdminApplicationSettingsInput = z.infer<typeof adminApplicationSettingsSchema>;

// ─── TFA config payloads ───────────────────────────────────────

export const adminTfaConfigSchema = z.object({
  tfaGloballyEnabled: z.boolean().optional(),
  tfaRequiredForAllUsers: z.boolean().optional(),
  tfaRequiredForAdmins: z.boolean().optional(),
  tfaSmsEnabled: z.boolean().optional(),
  tfaEmailEnabled: z.boolean().optional(),
  tfaTotpEnabled: z.boolean().optional(),
  tfaPasskeyEnabled: z.boolean().optional(),
  passkeysEnabled: z.boolean().optional(),
  magicLinkEnabled: z.boolean().optional(),
  smsProvider: z.string().max(50).nullish(),
  smsTwilioAccountSid: z.string().max(255).nullish(),
  smsTwilioAuthToken: z.string().max(512).nullish(),
  smsTwilioFromNumber: z.string().max(32).nullish(),
  smsVonageApiKey: z.string().max(255).nullish(),
  smsVonageApiSecret: z.string().max(512).nullish(),
  smsVonageFromNumber: z.string().max(32).nullish(),
  smsAwsRegion: z.string().max(50).nullish(),
  smsAwsAccessKeyId: z.string().max(255).nullish(),
  smsAwsSecretAccessKey: z.string().max(512).nullish(),
  smsSenderId: z.string().max(32).nullish(),
  tfaCodeLength: z.number().int().min(4).max(10).optional(),
  tfaCodeExpirySeconds: z.number().int().min(30).max(3600).optional(),
  tfaMaxAttempts: z.number().int().min(1).max(10).optional(),
  tfaLockoutMinutes: z.number().int().min(1).max(1440).optional(),
  tfaTrustDeviceDays: z.number().int().min(0).max(365).optional(),
}).strict();
export type AdminTfaConfigInput = z.infer<typeof adminTfaConfigSchema>;

export const adminTfaSmsTestSchema = z.object({
  phoneNumber: z
    .string()
    .regex(/^\+?[0-9\- ()]{6,20}$/, 'Invalid phone number'),
});
export type AdminTfaSmsTestInput = z.infer<typeof adminTfaSmsTestSchema>;

// ─── Create client tenant (CPA workflow) ──────────────────────

export const adminCreateClientSchema = z.object({
  companyName: z.string().min(1).max(255),
  industry: z.string().max(100).optional(),
  entityType: z.string().max(50).optional(),
  businessType: z.string().max(100).optional(),
});
export type AdminCreateClientInput = z.infer<typeof adminCreateClientSchema>;

// ─── MCP config ────────────────────────────────────────────────

export const adminMcpConfigSchema = z.object({
  isEnabled: z.boolean().optional(),
  maxKeysPerUser: z.number().int().min(1).max(100).optional(),
  systemRateLimitPerMinute: z.number().int().min(1).max(100000).optional(),
  oauthEnabled: z.boolean().optional(),
  requireKeyExpiration: z.boolean().optional(),
  maxKeyLifetimeDays: z.number().int().min(1).max(3650).optional(),
  allowedScopes: z.union([z.string().max(2000), z.array(z.string().max(100))]).optional(),
});
export type AdminMcpConfigInput = z.infer<typeof adminMcpConfigSchema>;

// ─── Plaid config ──────────────────────────────────────────────

export const adminPlaidConfigSchema = z.object({
  isEnabled: z.boolean().optional(),
  plaidEnv: z.enum(['sandbox', 'development', 'production']).optional(),
  plaidClientId: z.string().max(255).nullish(),
  plaidSecret: z.string().max(512).nullish(),
  plaidWebhookUrl: z.string().max(500).nullish(),
  plaidProducts: z.array(z.string().max(50)).optional(),
  plaidCountryCodes: z.array(z.string().length(2)).optional(),
}).strict();
export type AdminPlaidConfigInput = z.infer<typeof adminPlaidConfigSchema>;

// ─── Bank rule submission moderation ──────────────────────────

export const adminBankRuleSubmissionStatusSchema = z.enum([
  'pending',
  'approved',
  'rejected',
]);
