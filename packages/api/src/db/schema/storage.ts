import { pgTable, uuid, varchar, text, boolean, integer, timestamp, index, jsonb } from 'drizzle-orm/pg-core';

// Storage provider configuration per tenant
export const storageProviders = pgTable('storage_providers', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  provider: varchar('provider', { length: 30 }).notNull(), // local | dropbox | google_drive | onedrive | s3
  isActive: boolean('is_active').default(true),
  // OAuth tokens (encrypted)
  accessTokenEncrypted: text('access_token_encrypted'),
  refreshTokenEncrypted: text('refresh_token_encrypted'),
  tokenExpiresAt: timestamp('token_expires_at', { withTimezone: true }),
  // Provider-specific config
  config: jsonb('config').notNull().default('{}'),
  // Health
  lastHealthCheckAt: timestamp('last_health_check_at', { withTimezone: true }),
  healthStatus: varchar('health_status', { length: 20 }).default('unknown'), // healthy | degraded | error | unknown
  healthError: text('health_error'),
  // Metadata
  displayName: varchar('display_name', { length: 100 }),
  connectedBy: uuid('connected_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  tenantActiveIdx: index('idx_sp_tenant_active').on(table.tenantId),
}));

// Storage migration tracking
export const storageMigrations = pgTable('storage_migrations', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  fromProvider: varchar('from_provider', { length: 30 }).notNull(),
  toProvider: varchar('to_provider', { length: 30 }).notNull(),
  status: varchar('status', { length: 20 }).default('pending'), // pending | running | completed | failed | cancelled
  totalFiles: integer('total_files').notNull().default(0),
  migratedFiles: integer('migrated_files').notNull().default(0),
  failedFiles: integer('failed_files').notNull().default(0),
  errorLog: jsonb('error_log').default('[]'),
  startedAt: timestamp('started_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});
