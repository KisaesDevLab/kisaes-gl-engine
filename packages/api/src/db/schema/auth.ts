import { pgTable, uuid, varchar, boolean, integer, timestamp, uniqueIndex, jsonb, text } from 'drizzle-orm/pg-core';

export const tenants = pgTable('tenants', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 255 }).notNull(),
  slug: varchar('slug', { length: 100 }).unique().notNull(),
  reportSettings: jsonb('report_settings'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
});

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  email: varchar('email', { length: 255 }).notNull(),
  passwordHash: varchar('password_hash', { length: 255 }).notNull(),
  displayName: varchar('display_name', { length: 255 }),
  role: varchar('role', { length: 50 }).notNull().default('owner'),
  isActive: boolean('is_active').default(true),
  isSuperAdmin: boolean('is_super_admin').default(false),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  displayPreferences: jsonb('display_preferences').default('{"fontScale":1,"theme":"system"}'),
  // 2FA fields
  tfaEnabled: boolean('tfa_enabled').default(false),
  tfaMethods: text('tfa_methods').default(''), // comma-separated: email,sms,totp
  tfaPreferredMethod: varchar('tfa_preferred_method', { length: 20 }),
  tfaPhone: varchar('tfa_phone', { length: 30 }),
  tfaPhoneVerified: boolean('tfa_phone_verified').default(false),
  tfaTotpSecretEncrypted: text('tfa_totp_secret_encrypted'),
  tfaTotpVerified: boolean('tfa_totp_verified').default(false),
  tfaRecoveryCodesEncrypted: text('tfa_recovery_codes_encrypted'),
  tfaRecoveryCodesRemaining: integer('tfa_recovery_codes_remaining').default(0),
  tfaFailedAttempts: integer('tfa_failed_attempts').default(0),
  tfaLockedUntil: timestamp('tfa_locked_until', { withTimezone: true }),
  // Login lockout
  loginFailedAttempts: integer('login_failed_attempts').default(0),
  loginLockedUntil: timestamp('login_locked_until', { withTimezone: true }),
  // Passwordless fields
  preferredLoginMethod: varchar('preferred_login_method', { length: 20 }).default('password'), // password | magic_link | passkey
  magicLinkEnabled: boolean('magic_link_enabled').default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  tenantEmailIdx: uniqueIndex('users_tenant_email_idx').on(table.tenantId, table.email),
}));

export const passwordResetTokens = pgTable('password_reset_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id),
  tokenHash: varchar('token_hash', { length: 255 }).notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

export const sessions = pgTable('sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id),
  refreshTokenHash: varchar('refresh_token_hash', { length: 255 }).notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});
