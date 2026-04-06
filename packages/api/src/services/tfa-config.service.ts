import { eq } from 'drizzle-orm';
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
}

async function getOrCreateConfig() {
  let config = await db.query.tfaConfig.findFirst();
  if (!config) {
    const [created] = await db.insert(tfaConfig).values({}).returning();
    config = created!;
  }
  return config;
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
  if (input.smsTwilioAccountSid !== undefined) updates.smsTwilioAccountSid = input.smsTwilioAccountSid ? encrypt(input.smsTwilioAccountSid) : null;
  if (input.smsTwilioAuthToken !== undefined) updates.smsTwilioAuthToken = input.smsTwilioAuthToken ? encrypt(input.smsTwilioAuthToken) : null;
  if (input.smsTwilioFromNumber !== undefined) updates.smsTwilioFromNumber = input.smsTwilioFromNumber;
  if (input.smsTextlinkApiKey !== undefined) updates.smsTextlinkApiKey = input.smsTextlinkApiKey ? encrypt(input.smsTextlinkApiKey) : null;
  if (input.smsTextlinkServiceName !== undefined) updates.smsTextlinkServiceName = input.smsTextlinkServiceName;
  // Passwordless
  if ((input as any).passkeysEnabled !== undefined) updates.passkeysEnabled = (input as any).passkeysEnabled;
  if ((input as any).magicLinkEnabled !== undefined) updates.magicLinkEnabled = (input as any).magicLinkEnabled;
  if ((input as any).magicLinkExpiryMinutes !== undefined) updates.magicLinkExpiryMinutes = (input as any).magicLinkExpiryMinutes;
  if ((input as any).magicLinkMaxAttempts !== undefined) updates.magicLinkMaxAttempts = (input as any).magicLinkMaxAttempts;
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
