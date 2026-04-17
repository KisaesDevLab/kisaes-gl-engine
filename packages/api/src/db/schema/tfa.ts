// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { pgTable, uuid, varchar, text, boolean, integer, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';

// System-wide 2FA configuration (singleton)
export const tfaConfig = pgTable('tfa_config', {
  id: uuid('id').primaryKey().defaultRandom(),
  isEnabled: boolean('is_enabled').default(false),
  allowedMethods: text('allowed_methods').default('email,totp'), // comma-separated: email,sms,totp
  trustDeviceEnabled: boolean('trust_device_enabled').default(true),
  trustDeviceDurationDays: integer('trust_device_duration_days').default(30),
  codeExpirySeconds: integer('code_expiry_seconds').default(300),
  codeLength: integer('code_length').default(6),
  maxAttempts: integer('max_attempts').default(5),
  lockoutDurationMinutes: integer('lockout_duration_minutes').default(15),
  // SMS Provider
  smsProvider: varchar('sms_provider', { length: 20 }), // 'twilio' | 'textlinksms' | null
  smsTwilioAccountSid: text('sms_twilio_account_sid_encrypted'),
  smsTwilioAuthToken: text('sms_twilio_auth_token_encrypted'),
  smsTwilioFromNumber: varchar('sms_twilio_from_number', { length: 20 }),
  smsTextlinkApiKey: text('sms_textlink_api_key_encrypted'),
  smsTextlinkServiceName: varchar('sms_textlink_service_name', { length: 100 }),
  // Passwordless
  passkeysEnabled: boolean('passkeys_enabled').default(false),
  magicLinkEnabled: boolean('magic_link_enabled').default(false),
  magicLinkExpiryMinutes: integer('magic_link_expiry_minutes').default(15),
  magicLinkMaxAttempts: integer('magic_link_max_attempts').default(3),
  configuredBy: uuid('configured_by'),
  configuredAt: timestamp('configured_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
});

// Ephemeral verification codes (email/SMS)
export const tfaCodes = pgTable('tfa_codes', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull(),
  codeHash: varchar('code_hash', { length: 255 }).notNull(),
  method: varchar('method', { length: 20 }).notNull(), // 'email' | 'sms'
  destination: varchar('destination', { length: 255 }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  used: boolean('used').default(false),
  usedAt: timestamp('used_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  userIdx: index('idx_tfa_codes_user').on(table.userId, table.used, table.expiresAt),
}));

// Trusted devices
export const tfaTrustedDevices = pgTable('tfa_trusted_devices', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull(),
  deviceFingerprintHash: varchar('device_fingerprint_hash', { length: 255 }).notNull(),
  deviceName: varchar('device_name', { length: 255 }),
  ipAddress: varchar('ip_address', { length: 45 }),
  trustedAt: timestamp('trusted_at', { withTimezone: true }).defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  isActive: boolean('is_active').default(true),
}, (table) => ({
  userDeviceIdx: uniqueIndex('idx_tfa_td_user_device').on(table.userId, table.deviceFingerprintHash),
  userActiveIdx: index('idx_tfa_td_user_active').on(table.userId, table.isActive),
}));
