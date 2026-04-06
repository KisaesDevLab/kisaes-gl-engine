import { pgTable, uuid, varchar, text, boolean, integer, bigint, timestamp, index, uniqueIndex, jsonb } from 'drizzle-orm/pg-core';

// OAuth Clients (registered by super admin)
export const oauthClients = pgTable('oauth_clients', {
  id: uuid('id').primaryKey().defaultRandom(),
  clientId: varchar('client_id', { length: 100 }).notNull().unique(),
  clientSecretHash: varchar('client_secret_hash', { length: 255 }).notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  redirectUris: text('redirect_uris').notNull(), // comma-separated
  grantTypes: text('grant_types').default('authorization_code'),
  scopes: text('scopes').default('all'),
  isActive: boolean('is_active').default(true),
  createdBy: uuid('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

// OAuth Tokens
export const oauthTokens = pgTable('oauth_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  clientId: uuid('client_id').notNull(),
  userId: uuid('user_id').notNull(),
  accessTokenHash: varchar('access_token_hash', { length: 255 }).notNull(),
  refreshTokenHash: varchar('refresh_token_hash', { length: 255 }),
  scopes: text('scopes').notNull(),
  accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }).notNull(),
  refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
}, (table) => ({
  accessIdx: index('idx_ot_access').on(table.accessTokenHash),
  userIdx: index('idx_ot_user').on(table.userId),
}));

// OAuth Authorization Codes
export const oauthAuthorizationCodes = pgTable('oauth_authorization_codes', {
  id: uuid('id').primaryKey().defaultRandom(),
  clientId: uuid('client_id').notNull(),
  userId: uuid('user_id').notNull(),
  codeHash: varchar('code_hash', { length: 255 }).notNull(),
  redirectUri: text('redirect_uri').notNull(),
  scopes: text('scopes').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  used: boolean('used').default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

// MCP Request Log
export const mcpRequestLog = pgTable('mcp_request_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull(),
  authMethod: varchar('auth_method', { length: 20 }).notNull(), // api_key | oauth
  apiKeyId: uuid('api_key_id'),
  oauthClientId: uuid('oauth_client_id'),
  toolName: varchar('tool_name', { length: 100 }),
  resourceUri: varchar('resource_uri', { length: 500 }),
  companyId: uuid('company_id'),
  parameters: jsonb('parameters'),
  status: varchar('status', { length: 20 }), // success | error | rate_limited
  errorCode: varchar('error_code', { length: 50 }),
  responseSummary: text('response_summary'),
  ipAddress: varchar('ip_address', { length: 45 }),
  userAgent: text('user_agent'),
  durationMs: integer('duration_ms'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  userIdx: index('idx_mrl_user').on(table.userId, table.createdAt),
  keyIdx: index('idx_mrl_key').on(table.apiKeyId, table.createdAt),
  companyIdx: index('idx_mrl_company').on(table.companyId, table.createdAt),
}));

// MCP System Configuration (singleton)
export const mcpConfig = pgTable('mcp_config', {
  id: uuid('id').primaryKey().defaultRandom(),
  isEnabled: boolean('is_enabled').default(false),
  maxKeysPerUser: integer('max_keys_per_user').default(5),
  systemRateLimitPerMinute: integer('system_rate_limit_per_minute').default(500),
  allowedScopes: text('allowed_scopes').default('all,read,write,reports,banking,invoicing'),
  oauthEnabled: boolean('oauth_enabled').default(false),
  requireKeyExpiration: boolean('require_key_expiration').default(false),
  maxKeyLifetimeDays: integer('max_key_lifetime_days'),
  configuredBy: uuid('configured_by'),
  configuredAt: timestamp('configured_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
});
