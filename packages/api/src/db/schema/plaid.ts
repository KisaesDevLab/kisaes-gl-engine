import { pgTable, uuid, varchar, text, boolean, integer, decimal, timestamp, date, index, uniqueIndex, jsonb } from 'drizzle-orm/pg-core';

// System-wide Plaid configuration (singleton)
export const plaidConfig = pgTable('plaid_config', {
  id: uuid('id').primaryKey().defaultRandom(),
  environment: varchar('environment', { length: 20 }).notNull().default('sandbox'),
  clientIdEncrypted: text('client_id_encrypted'),
  secretSandboxEncrypted: text('secret_sandbox_encrypted'),
  secretProductionEncrypted: text('secret_production_encrypted'),
  webhookUrl: varchar('webhook_url', { length: 500 }),
  defaultProducts: text('default_products').default('transactions'),
  defaultCountryCodes: text('default_country_codes').default('US'),
  defaultLanguage: varchar('default_language', { length: 5 }).default('en'),
  maxHistoricalDays: integer('max_historical_days').default(90),
  isActive: boolean('is_active').default(true),
  configuredBy: uuid('configured_by'),
  configuredAt: timestamp('configured_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
});

// Plaid Items — SYSTEM-SCOPED (no tenant_id, shared across companies)
export const plaidItems = pgTable('plaid_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  // NO tenant_id — system-scoped
  plaidItemId: varchar('plaid_item_id', { length: 255 }).notNull().unique(),
  plaidInstitutionId: varchar('plaid_institution_id', { length: 100 }),
  institutionName: varchar('institution_name', { length: 255 }),
  accessTokenEncrypted: text('access_token_encrypted').notNull(),
  // Sync state
  syncCursor: text('sync_cursor'),
  lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
  lastSyncStatus: varchar('last_sync_status', { length: 30 }),
  lastSyncError: text('last_sync_error'),
  initialUpdateComplete: boolean('initial_update_complete').default(false),
  historicalUpdateComplete: boolean('historical_update_complete').default(false),
  // Item health
  itemStatus: varchar('item_status', { length: 30 }).default('active'),
  errorCode: varchar('error_code', { length: 100 }),
  errorMessage: text('error_message'),
  consentExpirationAt: timestamp('consent_expiration_at', { withTimezone: true }),
  // Attribution (informational, not ownership)
  createdBy: uuid('created_by'),
  createdByName: varchar('created_by_name', { length: 255 }),
  createdByEmail: varchar('created_by_email', { length: 255 }),
  linkSessionId: varchar('link_session_id', { length: 255 }),
  // Lifecycle
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  removedAt: timestamp('removed_at', { withTimezone: true }),
  removedBy: uuid('removed_by'),
  removedByName: varchar('removed_by_name', { length: 255 }),
}, (table) => ({
  statusIdx: index('idx_pi_status').on(table.itemStatus),
  institutionIdx: index('idx_pi_institution').on(table.plaidInstitutionId),
  createdByIdx: index('idx_pi_created_by').on(table.createdBy),
}));

// Plaid Accounts — SYSTEM-SCOPED (inherits scope from parent Item)
export const plaidAccounts = pgTable('plaid_accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
  // NO tenant_id — system-scoped
  plaidItemId: uuid('plaid_item_id').notNull(),
  plaidAccountId: varchar('plaid_account_id', { length: 255 }).notNull().unique(),
  persistentAccountId: varchar('persistent_account_id', { length: 255 }),
  // Account info from Plaid
  name: varchar('name', { length: 255 }),
  officialName: varchar('official_name', { length: 255 }),
  accountType: varchar('account_type', { length: 50 }),
  accountSubtype: varchar('account_subtype', { length: 50 }),
  mask: varchar('mask', { length: 10 }),
  // Balance
  currentBalance: decimal('current_balance', { precision: 19, scale: 4 }),
  availableBalance: decimal('available_balance', { precision: 19, scale: 4 }),
  balanceCurrency: varchar('balance_currency', { length: 3 }).default('USD'),
  balanceUpdatedAt: timestamp('balance_updated_at', { withTimezone: true }),
  // Status
  isActive: boolean('is_active').default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  itemIdx: index('idx_pa_item').on(table.plaidItemId),
  plaidAccountIdx: index('idx_pa_plaid_account').on(table.plaidAccountId),
  maskSubtypeIdx: index('idx_pa_mask_subtype').on(table.mask, table.accountSubtype),
}));

// Plaid Account Mappings — TENANT-SCOPED BRIDGE (links system accounts to company COA)
export const plaidAccountMappings = pgTable('plaid_account_mappings', {
  id: uuid('id').primaryKey().defaultRandom(),
  plaidAccountId: uuid('plaid_account_id').notNull(),
  tenantId: uuid('tenant_id').notNull(),
  mappedAccountId: uuid('mapped_account_id').notNull(),
  // Sync control
  syncStartDate: date('sync_start_date'), // NULL = import all available history
  isSyncEnabled: boolean('is_sync_enabled').default(true),
  // Attribution
  mappedBy: uuid('mapped_by').notNull(),
  mappedByName: varchar('mapped_by_name', { length: 255 }),
  // Lifecycle
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  tenantIdx: index('idx_pam_tenant').on(table.tenantId),
  plaidIdx: index('idx_pam_plaid').on(table.plaidAccountId),
  // One bank account → one company
  plaidAccountUniq: uniqueIndex('idx_pam_plaid_account_uniq').on(table.plaidAccountId),
  // One COA account → one Plaid feed
  tenantCoaUniq: uniqueIndex('idx_pam_tenant_coa_uniq').on(table.tenantId, table.mappedAccountId),
}));

// Plaid Item Activity Log
export const plaidItemActivity = pgTable('plaid_item_activity', {
  id: uuid('id').primaryKey().defaultRandom(),
  plaidItemId: uuid('plaid_item_id').notNull(),
  tenantId: uuid('tenant_id'), // NULL for system-level actions
  action: varchar('action', { length: 50 }).notNull(),
  performedBy: uuid('performed_by'),
  performedByName: varchar('performed_by_name', { length: 255 }),
  details: jsonb('details'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  itemIdx: index('idx_pia_item').on(table.plaidItemId),
  tenantIdx: index('idx_pia_tenant').on(table.tenantId),
}));

// Plaid Webhook Log (unchanged)
export const plaidWebhookLog = pgTable('plaid_webhook_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  receivedAt: timestamp('received_at', { withTimezone: true }).defaultNow(),
  plaidItemId: varchar('plaid_item_id', { length: 255 }),
  webhookType: varchar('webhook_type', { length: 100 }),
  webhookCode: varchar('webhook_code', { length: 100 }),
  payload: jsonb('payload').notNull(),
  processed: boolean('processed').default(false),
  processedAt: timestamp('processed_at', { withTimezone: true }),
  error: text('error'),
}, (table) => ({
  itemIdx: index('idx_pwl_item').on(table.plaidItemId),
  unprocessedIdx: index('idx_pwl_unprocessed').on(table.processed),
}));
