// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { z } from 'zod';

// ─── User mutation payloads ────────────────────────────────────

export const adminResetPasswordSchema = z.object({
  password: z
    .string()
    .min(12, 'Password must be at least 12 characters')
    .max(128, 'Password must be 128 characters or fewer'),
});
export type AdminResetPasswordInput = z.infer<typeof adminResetPasswordSchema>;

// Admin-side user creation. The route was manually checking fields; moving
// to Zod means the error handler produces the standard VALIDATION_ERROR
// shape and the password policy lives alongside the rest of the admin
// schemas rather than inline in the route.
export const adminCreateUserRoles = ['owner', 'accountant', 'bookkeeper', 'readonly'] as const;
export const adminCreateUserSchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(12, 'Password must be at least 12 characters').max(128),
  displayName: z.string().min(1).max(255).optional(),
  tenantId: z.string().uuid(),
  role: z.enum(adminCreateUserRoles).default('owner'),
});
export type AdminCreateUserInput = z.infer<typeof adminCreateUserSchema>;

export const adminToggleTenantAccessSchema = z.object({
  tenantId: z.string().uuid(),
});
export type AdminToggleTenantAccessInput = z.infer<typeof adminToggleTenantAccessSchema>;

// Grant (or reactivate) an existing user's access to a tenant with a role.
// Used by the admin tenant-detail "add firm user" flow and the admin user
// "tenant access" manager. Distinct from adminToggleTenantAccessSchema, which
// only flips is_active on a row that already exists.
export const adminGrantTenantAccessSchema = z.object({
  tenantId: z.string().uuid(),
  role: z.enum(adminCreateUserRoles).default('accountant'),
});
export type AdminGrantTenantAccessInput = z.infer<typeof adminGrantTenantAccessSchema>;

// Designate an equity account as the tenant's system Retained Earnings — used
// to repair a tenant whose system RE account was deleted (the balance sheet
// then falls back to the calculated Retained Earnings rows).
export const adminDesignateRetainedEarningsSchema = z.object({
  accountId: z.string().uuid(),
});
export type AdminDesignateRetainedEarningsInput = z.infer<typeof adminDesignateRetainedEarningsSchema>;

// Point a system-account role (accounts.system_tag) at an existing account,
// or clear the mapping (accountId: null). Used by the admin "System Accounts"
// repair tool for tenants whose system accounts were deleted or mis-tagged.
export const adminAssignSystemAccountSchema = z.object({
  accountId: z.string().uuid().nullable(),
});
export type AdminAssignSystemAccountInput = z.infer<typeof adminAssignSystemAccountSchema>;

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
  // Credential field uses the 3-state sentinel: `null` clears the stored
  // password, '' or omitted means "no change", non-empty is set. The GET
  // endpoint scrubs the password so the form is blank on every reload —
  // empty string can NEVER be treated as "wipe" or every unrelated save
  // would destroy outbound mail auth.
  smtpPass: z.string().max(512).nullish(),
  smtpFrom: z.string().email().max(255),
  // Display name for the From header ("Vibe MyBooks <noreply@...>").
  // Optional — blank means send with the bare address.
  smtpFromName: z.string().max(255).optional().default(''),
});
export type AdminSmtpSettingsInput = z.infer<typeof adminSmtpSettingsSchema>;

// The TEST endpoint validates the connection params the way the tester actually
// uses them: short field names (host/port/username/password/from) matching both
// the admin form's request body AND testSmtpConnection()'s SmtpConfig — NOT the
// smtp-prefixed *save* schema above. (Reusing the save schema caused
// "smtpHost: Required" because the form sends `host`.) testEmail is optional —
// without it the tester only verifies the connection.
export const adminSmtpTestSchema = z.object({
  host: z.string().min(1).max(255),
  port: z.coerce.number().int().min(1).max(65535),
  username: z.string().max(255).optional().default(''),
  password: z.string().max(512).nullish(),
  from: z.string().email().max(255),
  fromName: z.string().max(255).optional(),
  testEmail: z.string().email().max(255).optional(),
});
export type AdminSmtpTestInput = z.infer<typeof adminSmtpTestSchema>;

export const adminApplicationSettingsSchema = z.object({
  applicationUrl: z.string().max(255).optional().default(''),
  maxFileSizeMb: z.string().max(10).optional().default('10'),
  // No .default() here: an omitted field must mean "leave unchanged",
  // not "reset to none" — a client that failed to load current settings
  // omits it rather than silently disabling scheduled backups.
  backupSchedule: z.enum(['none', 'daily', 'weekly', 'monthly']).optional(),
  appName: z.string().max(80).optional(),
});
export type AdminApplicationSettingsInput = z.infer<typeof adminApplicationSettingsSchema>;

// ─── TFA config payloads ───────────────────────────────────────

// Field names below mirror the DB column names in `tfa_config` and the
// shape the TfaConfigPage form actually sends. An earlier version of
// this schema used a `tfa*` prefix on every config field (tfaCodeLength,
// tfaCodeExpirySeconds, etc.) that didn't exist anywhere else in the
// codebase — combined with `.strict()`, every admin TFA save returned
// HTTP 400 with no UI feedback. Same pattern as the SMS save bug from
// the textlinksms migration.
export const adminTfaConfigSchema = z.object({
  isEnabled: z.boolean().optional(),
  allowedMethods: z.array(z.string().max(40)).optional(),
  trustDeviceEnabled: z.boolean().optional(),
  trustDeviceDurationDays: z.number().int().min(0).max(365).optional(),
  codeExpirySeconds: z.number().int().min(30).max(3600).optional(),
  codeLength: z.number().int().min(4).max(10).optional(),
  maxAttempts: z.number().int().min(1).max(10).optional(),
  lockoutDurationMinutes: z.number().int().min(1).max(1440).optional(),
  passkeysEnabled: z.boolean().optional(),
  magicLinkEnabled: z.boolean().optional(),
  magicLinkExpiryMinutes: z.number().int().min(1).max(1440).optional(),
  magicLinkMaxAttempts: z.number().int().min(1).max(20).optional(),
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
  smsTextlinkApiKey: z.string().max(512).nullish(),
  smsTextlinkServiceName: z.string().max(120).nullish(),
  smsSenderId: z.string().max(32).nullish(),
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

// Field names mirror the DB columns in `plaid_config` and the shape
// the PlaidConfigPage form actually sends. A previous version of this
// schema used `plaid*`-prefixed names (plaidEnv, plaidClientId, etc.)
// that didn't match the frontend or the service layer — every admin
// Plaid save returned HTTP 400 silently. Same SMS-bug pattern.
//
// Credential fields use a 3-state sentinel: `null` clears the stored
// value, an empty string or missing field leaves it untouched, and a
// non-empty string is encrypted-and-stored. `nullish()` accepts both
// null and undefined; the service distinguishes between them.
export const adminPlaidConfigSchema = z.object({
  environment: z.enum(['sandbox', 'development', 'production']).optional(),
  clientId: z.string().max(255).nullish(),
  secretSandbox: z.string().max(512).nullish(),
  secretProduction: z.string().max(512).nullish(),
  webhookUrl: z.string().max(500).nullish(),
  defaultProducts: z.array(z.string().max(50)).optional(),
  defaultCountryCodes: z.array(z.string().length(2)).optional(),
  defaultLanguage: z.string().max(10).optional(),
  maxHistoricalDays: z.number().int().min(1).max(730).optional(),
  // Automatic sync interval in hours: 0 disables, null = use server default.
  autoSyncHours: z.number().int().min(0).max(168).nullable().optional(),
  isActive: z.boolean().optional(),
}).strict();
export type AdminPlaidConfigInput = z.infer<typeof adminPlaidConfigSchema>;

// ─── Bank rule submission moderation ──────────────────────────

export const adminBankRuleSubmissionStatusSchema = z.enum([
  'pending',
  'approved',
  'rejected',
]);
