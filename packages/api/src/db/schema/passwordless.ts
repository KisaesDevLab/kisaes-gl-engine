import { pgTable, uuid, varchar, text, boolean, integer, bigint, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';

// Passkeys (WebAuthn / FIDO2 credentials)
export const passkeys = pgTable('passkeys', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull(),
  credentialId: text('credential_id').notNull(),
  publicKey: text('public_key').notNull(),
  counter: bigint('counter', { mode: 'number' }).default(0),
  deviceName: varchar('device_name', { length: 255 }),
  aaguid: varchar('aaguid', { length: 36 }),
  transports: text('transports'), // comma-separated: usb,ble,nfc,internal
  backedUp: boolean('backed_up').default(false),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  userIdx: index('idx_pk_user').on(table.userId),
  credentialIdx: uniqueIndex('idx_pk_credential').on(table.credentialId),
}));

// Magic links (passwordless email login tokens)
export const magicLinks = pgTable('magic_links', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull(),
  tokenHash: varchar('token_hash', { length: 255 }).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  used: boolean('used').default(false),
  usedAt: timestamp('used_at', { withTimezone: true }),
  ipAddress: varchar('ip_address', { length: 45 }),
  userAgent: text('user_agent'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  // Unique: magic-link tokens are single-use and verified by hash lookup.
  // Two rows with the same tokenHash would let a collision authenticate
  // as the wrong user.
  tokenIdx: uniqueIndex('idx_ml_token').on(table.tokenHash),
  userIdx: index('idx_ml_user').on(table.userId),
}));
