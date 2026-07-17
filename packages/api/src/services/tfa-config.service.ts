// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { eq, desc, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import { tfaConfig } from '../db/schema/index.js';
import { encrypt, decrypt } from '../utils/encryption.js';

export interface TfaSystemConfig {
  isEnabled: boolean;
  allowedMethods: string[];
  trustDeviceEnabled: boolean;
  trustDeviceDurationDays: number;
  codeExpirySeconds: number;
  codeLength: number;
  maxAttempts: number;
  lockoutDurationMinutes: number;
  smsProvider: string | null;
  smsConfigured: boolean;
  hasSmsTwilioAccountSid: boolean;
  hasSmsTwilioAuthToken: boolean;
  hasSmsTextlinkApiKey: boolean;
  passkeysEnabled: boolean;
  magicLinkEnabled: boolean;
  magicLinkExpiryMinutes: number;
  magicLinkMaxAttempts: number;
}

async function getOrCreateConfig() {
  // tfa_config is a singleton, but the get-or-create below can race
  // (two concurrent first requests both see "no row" and both insert).
  // With duplicates present, the old findFirst() had no ORDER BY, and a
  // Postgres UPDATE relocates the written row in physical order — so
  // every admin save wrote one row and the next read returned the OTHER,
  // making the settings appear to revert. Read deterministically (most
  // recent admin intent first) and self-heal by deleting the rest.
  const rows = await db.select().from(tfaConfig).orderBy(desc(tfaConfig.updatedAt), desc(tfaConfig.createdAt));
  if (rows.length > 1) {
    const stale = rows.slice(1).map((r) => r.id);
    await db.delete(tfaConfig).where(inArray(tfaConfig.id, stale));
    console.warn(`[tfa-config] Removed ${stale.length} duplicate tfa_config row(s) (get-or-create race); kept ${rows[0]!.id}`);
  }
  if (rows.length > 0) return rows[0]!;
  const [created] = await db.insert(tfaConfig).values({}).returning();
  return created!;
}

export async function getConfig(): Promise<TfaSystemConfig> {
  const config = await getOrCreateConfig();
  const methods = (config.allowedMethods || 'email,totp').split(',').filter(Boolean);
  return {
    isEnabled: config.isEnabled || false,
    allowedMethods: methods,
    trustDeviceEnabled: config.trustDeviceEnabled ?? true,
    trustDeviceDurationDays: config.trustDeviceDurationDays ?? 30,
    codeExpirySeconds: config.codeExpirySeconds ?? 300,
    codeLength: config.codeLength ?? 6,
    maxAttempts: config.maxAttempts ?? 5,
    lockoutDurationMinutes: config.lockoutDurationMinutes ?? 15,
    smsProvider: config.smsProvider || null,
    smsConfigured: !!(config.smsProvider && (config.smsTwilioAccountSid || config.smsTextlinkApiKey)),
    // Per-credential "has stored value" flags so the UI can render a
    // Clear button next to each field without round-tripping secrets.
    hasSmsTwilioAccountSid: !!config.smsTwilioAccountSid,
    hasSmsTwilioAuthToken: !!config.smsTwilioAuthToken,
    hasSmsTextlinkApiKey: !!config.smsTextlinkApiKey,
    // Passwordless — the PUT has always persisted these, but they were
    // missing from this payload, so the admin form re-initialized its
    // toggles to false on every load and saves appeared to revert.
    passkeysEnabled: config.passkeysEnabled ?? false,
    magicLinkEnabled: config.magicLinkEnabled ?? false,
    magicLinkExpiryMinutes: config.magicLinkExpiryMinutes ?? 15,
    magicLinkMaxAttempts: config.magicLinkMaxAttempts ?? 3,
  };
}

export async function updateConfig(input: Partial<{
  isEnabled: boolean;
  allowedMethods: string[];
  trustDeviceEnabled: boolean;
  trustDeviceDurationDays: number;
  codeExpirySeconds: number;
  codeLength: number;
  maxAttempts: number;
  lockoutDurationMinutes: number;
  smsProvider: string;
  smsTwilioAccountSid: string;
  smsTwilioAuthToken: string;
  smsTwilioFromNumber: string;
  smsTextlinkApiKey: string;
  smsTextlinkServiceName: string;
  passkeysEnabled: boolean;
  magicLinkEnabled: boolean;
  magicLinkExpiryMinutes: number;
  magicLinkMaxAttempts: number;
}>, userId?: string) {
  const config = await getOrCreateConfig();
  const updates: any = { updatedAt: new Date() };

  if (input.isEnabled !== undefined) updates.isEnabled = input.isEnabled;
  if (input.allowedMethods) updates.allowedMethods = input.allowedMethods.join(',');
  if (input.trustDeviceEnabled !== undefined) updates.trustDeviceEnabled = input.trustDeviceEnabled;
  if (input.trustDeviceDurationDays !== undefined) updates.trustDeviceDurationDays = input.trustDeviceDurationDays;
  if (input.codeExpirySeconds !== undefined) updates.codeExpirySeconds = input.codeExpirySeconds;
  if (input.codeLength !== undefined) updates.codeLength = input.codeLength;
  if (input.maxAttempts !== undefined) updates.maxAttempts = input.maxAttempts;
  if (input.lockoutDurationMinutes !== undefined) updates.lockoutDurationMinutes = input.lockoutDurationMinutes;
  if (input.smsProvider !== undefined) updates.smsProvider = input.smsProvider || null;
  // SMS credentials use the 3-state sentinel: null = explicit clear,
  // '' or undefined = no change, non-empty = encrypt+store. The GET
  // endpoint returns only provider name (no secrets) so blank fields
  // arriving from the form must NOT wipe stored creds.
  if (input.smsTwilioAccountSid === null) updates.smsTwilioAccountSid = null;
  else if (input.smsTwilioAccountSid) updates.smsTwilioAccountSid = encrypt(input.smsTwilioAccountSid);
  if (input.smsTwilioAuthToken === null) updates.smsTwilioAuthToken = null;
  else if (input.smsTwilioAuthToken) updates.smsTwilioAuthToken = encrypt(input.smsTwilioAuthToken);
  if (input.smsTwilioFromNumber !== undefined) updates.smsTwilioFromNumber = input.smsTwilioFromNumber;
  if (input.smsTextlinkApiKey === null) updates.smsTextlinkApiKey = null;
  else if (input.smsTextlinkApiKey) updates.smsTextlinkApiKey = encrypt(input.smsTextlinkApiKey);
  if (input.smsTextlinkServiceName !== undefined) updates.smsTextlinkServiceName = input.smsTextlinkServiceName;
  // Passwordless
  if (input.passkeysEnabled !== undefined) updates.passkeysEnabled = input.passkeysEnabled;
  if (input.magicLinkEnabled !== undefined) updates.magicLinkEnabled = input.magicLinkEnabled;
  if (input.magicLinkExpiryMinutes !== undefined) updates.magicLinkExpiryMinutes = input.magicLinkExpiryMinutes;
  if (input.magicLinkMaxAttempts !== undefined) updates.magicLinkMaxAttempts = input.magicLinkMaxAttempts;
  if (userId) { updates.configuredBy = userId; updates.configuredAt = new Date(); }
  // Invalidate capabilities cache when admin changes config
  try { const { invalidateCapabilitiesCache } = await import('./auth-availability.service.js'); invalidateCapabilitiesCache(); } catch {}

  await db.update(tfaConfig).set(updates).where(eq(tfaConfig.id, config.id));
  return getConfig();
}

export async function getRawConfig() {
  const config = await getOrCreateConfig();
  return {
    smsProvider: config.smsProvider || null,
    smsTwilioAccountSid: config.smsTwilioAccountSid ? decrypt(config.smsTwilioAccountSid) : null,
    smsTwilioAuthToken: config.smsTwilioAuthToken ? decrypt(config.smsTwilioAuthToken) : null,
    smsTwilioFromNumber: config.smsTwilioFromNumber || null,
    smsTextlinkApiKey: config.smsTextlinkApiKey ? decrypt(config.smsTextlinkApiKey) : null,
    smsTextlinkServiceName: config.smsTextlinkServiceName || null,
  };
}

export async function getTfaStats() {
  const { users } = await import('../db/schema/index.js');
  const { sql } = await import('drizzle-orm');
  const result = await db.execute(sql`
    SELECT
      COUNT(*) FILTER (WHERE tfa_enabled = true) AS enrolled,
      COUNT(*) AS total_users,
      COUNT(*) FILTER (WHERE tfa_methods LIKE '%email%') AS email_method,
      COUNT(*) FILTER (WHERE tfa_methods LIKE '%totp%') AS totp_method,
      COUNT(*) FILTER (WHERE tfa_methods LIKE '%sms%') AS sms_method
    FROM users
  `);
  const row = result.rows[0] as any;
  return {
    enrolledUsers: parseInt(row.enrolled) || 0,
    totalUsers: parseInt(row.total_users) || 0,
    byMethod: {
      email: parseInt(row.email_method) || 0,
      totp: parseInt(row.totp_method) || 0,
      sms: parseInt(row.sms_method) || 0,
    },
  };
}

export async function isTfaAvailable(): Promise<boolean> {
  const config = await getConfig();
  return config.isEnabled;
}

export async function isMethodAvailable(method: string): Promise<boolean> {
  const config = await getConfig();
  if (!config.isEnabled) return false;
  if (!config.allowedMethods.includes(method)) return false;
  if (method === 'sms' && !config.smsConfigured) return false;
  return true;
}
