// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * Tenant portability plan (U-05 tenant archives).
 *
 * The plan is generated from the LIVE schema and fails closed: every public
 * BASE TABLE lands in exactly one bucket (rule 0), and every object the
 * archive format cares about (primary keys, unique indexes, references to
 * rows outside the tenant, secret-looking columns, jsonb config, file
 * columns, triggers) must be classified in one of the tables below or
 * `buildPortabilityPlan()` throws an `UNCLASSIFIED_*` error. The matching
 * test (plan.test.ts) runs against the live schema, so a migration that adds
 * a table, column, index or trigger fails CI until someone classifies it.
 *
 * Only the classification tables are hand-maintained; projections, scope
 * SQL and the FK order are derived.
 *
 * Buckets:
 *   tenant    has tenant_id; exported WHERE tenant_id = $1 (nullable
 *             tenant_id tables are tenant for those rows only)
 *   child     no tenant_id; reached through CHILD_TABLES (column -> parent)
 *   identity  tenants, users, user_tenant_access (dedicated sections)
 *   global    install-wide reference or config data (never exported;
 *             references into it map by natural key or pass through)
 *   excluded  deliberately not archived; each entry has a closed category
 */

import { sql } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { DESKTOP_UNMOUNTED } from '../../desktop/features.js';
import { SECRET_KEY_PATTERN } from '../../utils/secret-keys.js';

export type DbLike = Pick<typeof db, 'execute'>;

// ── Closed enums ─────────────────────────────────────────────────────

export type Bucket = 'tenant' | 'child' | 'identity' | 'global' | 'excluded';

export type ExcludedCategory =
  | 'secret'
  | 'session-token'
  | 'job-bookkeeping'
  | 'derived'
  | 'provenance'
  | 'server-feature';

export const EXCLUDED_CATEGORIES: readonly ExcludedCategory[] = [
  'secret', 'session-token', 'job-bookkeeping', 'derived', 'provenance', 'server-feature',
];

/** `tenant` (has tenant_id), `child-of:<parent>`, or `none` (install-level, never deleted with a tenant). */
export type ExcludedScope = 'tenant' | `child-of:${string}` | 'none';

export interface ExcludedTable {
  category: ExcludedCategory;
  scope: ExcludedScope;
  reason: string;
  /** server-feature: the DESKTOP_UNMOUNTED family prefix the table belongs to. */
  family?: string;
  /** server-feature: the table has a NOT NULL firm_id column (firm-keyed). */
  firmKeyed?: true;
  /** server-feature: the table has a NOT NULL FK into this excluded table (rule 4c cascade). */
  cascadeOf?: string;
}

export type PkShape = 'uuid' | 'omit-pk' | 'no-pk';

export type GlobalRefStrategy = 'pass-through' | 'map-by-natural-key' | 'null-on-missing' | 'refuse';

/**
 * Rule 4b soft references (uuid / uuid[] columns without an FK):
 *   tenant-ref:<table>    remapped by substitution; a dangling target is an export warning
 *   mixed-ref:<table>     the target table has nullable tenant_id: tenant rows remap,
 *                         system rows map by NATURAL_KEYS, else null
 *   global-ref:<table>    maps by NATURAL_KEYS of that global table, else null
 *   global-ref:null       always nulled on export (no portable key)
 *   excluded-ref:<table>  rule 4c: nullable column into an excluded table, nulled on export
 *   identity              a users id, mapped by the identity rules
 *   polymorphic           an id whose table depends on a sibling type column; remapped
 *                         when it is in the id map, never checked for dangling
 *   opaque                an id that is not a row reference
 */
export type SoftRefClass =
  | `tenant-ref:${string}`
  | `mixed-ref:${string}`
  | `global-ref:${string}`
  | `excluded-ref:${string}`
  | 'identity'
  | 'polymorphic'
  | 'opaque';

export type UniqueIndexRule = 'regenerate' | 'null' | 'force-false';

export type JsonConfigClass = 'plain' | 'contains-ids' | 'secret';

export type FileResolverKind =
  | 'provider-key'
  | 'provider-path-mirror'
  | 'upload-encrypted'
  | 'upload-relative'
  | 'logo-url'
  | 'null'
  | 'external'
  | 'not-a-file';

export interface FileColumnRule {
  resolver: FileResolverKind;
  /** provider-key: storage domain of the new key (storage/storage-keys.ts). */
  domain?: 'attachments' | 'reports' | 'w9' | 'receipts' | 'documents' | 'question-attachments';
  /** provider-key: a column holding a legacy `/uploads/<key>` path used when the key is NULL. */
  fallbackPathColumn?: string;
  /** provider-path-mirror: the key column this path mirrors as `/uploads/<key>`. */
  mirrorOf?: string;
  /** provider-key: an integer size column checked against the bundled bytes. */
  sizeColumn?: string;
  /** upload-encrypted: a sha256 column of the plaintext image. */
  sha256Column?: string;
}

export type TriggerClass =
  | 'fires-ok'
  | 'insert-safe'
  | `delete-guard:${string}`
  | `delete-side-effect:${string}`;

export interface SecretColumnRule {
  /**
   * keep: travels as stored; redact: NULL (or `replacement`) on export;
   * reencrypt (M5): ciphertext under this install's key is decrypted on
   * export, travels in plaintext inside the passphrase-encrypted archive,
   * is encrypted again under the importing install's key, verified by
   * decrypt-and-compare, and is left out of the content digest.
   */
  action: 'keep' | 'redact' | 'reencrypt';
  reason: string;
  /** redact: SQL literal written instead of NULL (for NOT NULL columns without a default). */
  replacement?: string;
}

export interface VolatileColumn {
  /** The browse-test case or lifecycle action that changes the column without a business edit. */
  producedBy: string;
}

/** `keep`: an informational pointer (provenance) that may outlive the tenant it names. */
export type CrossTenantAction = 'set-null' | 'delete' | 'keep';

// ── Classification tables (hand-maintained, verified by the plan test) ──

export const IDENTITY_TABLES = ['tenants', 'users', 'user_tenant_access'] as const;

/** The only tables with an integer PK the archive may omit and regenerate. */
export const KNOWN_SELF_REFERENCES: readonly string[] = ['tax_est_scenarios.source_scenario_id'];

/** Install-wide reference and config data. Referenced rows map by NATURAL_KEYS or pass through. */
export const GLOBAL_TABLES: Record<string, string> = {
  ai_config: 'install AI configuration (singleton)',
  ai_prompt_templates: 'shipped and custom AI prompt templates',
  check_registry: 'review-check registry keyed by check_key (identical on every install)',
  coa_templates: 'chart-of-accounts templates (boot-seeded; mapped by slug)',
  global_rule_submissions: 'install-level bank-rule submissions queue',
  knowledge_articles: 'help knowledge base',
  mcp_config: 'install MCP configuration',
  plaid_config: 'install Plaid credentials (never exported)',
  report_letters: 'super-admin report letter library (mapped by letter_type + name)',
  report_pack_templates: 'install report pack templates',
  staff_ip_allowlist: 'install staff IP allowlist',
  state_estimate_rules: 'shipped state tax estimate rules',
  state_estimate_rule_overrides: 'install overrides of state estimate rules',
  system_settings: 'install settings',
  tax_code_seed_versions: 'shipped tax code seed versions (mapped by tax_year + source_file_hash)',
  tax_codes: 'shipped tax codes',
  tax_parameters: 'shipped tax parameters',
  tax_parameter_overrides: 'install overrides of tax parameters',
  tax_param_ai_check_runs: 'install-level AI checks of tax parameters',
  tax_param_ai_checks: 'install-level AI checks of tax parameters',
  tax_est_adjustment_types: 'tax estimator adjustment types (system rows and firm rows)',
  tfa_config: 'install two-factor configuration',
};

/** Child tables (no tenant_id): `table -> { column, parent }`; the parent is a tenant or child table. */
export const CHILD_TABLES: Record<string, { column: string; parent: string }> = {
  budget_lines: { column: 'budget_id', parent: 'budgets' },
  budget_periods: { column: 'budget_id', parent: 'budgets' },
  reconciliation_lines: { column: 'reconciliation_id', parent: 'reconciliations' },
  deposit_lines: { column: 'deposit_id', parent: 'transactions' },
  payroll_import_rows: { column: 'session_id', parent: 'payroll_import_sessions' },
  payroll_import_errors: { column: 'session_id', parent: 'payroll_import_sessions' },
  payroll_import_column_mappings: { column: 'session_id', parent: 'payroll_import_sessions' },
  payroll_check_register_rows: { column: 'session_id', parent: 'payroll_import_sessions' },
  accountant_company_exclusions: { column: 'company_id', parent: 'companies' },
  portal_contact_companies: { column: 'company_id', parent: 'companies' },
  portal_settings_per_company: { column: 'company_id', parent: 'companies' },
  // company_id is nullable with no FK: rows with NULL company_id are install-level and out of scope.
  mcp_request_log: { column: 'company_id', parent: 'companies' },
  report_comments: { column: 'instance_id', parent: 'report_instances' },
  report_ai_summaries: { column: 'instance_id', parent: 'report_instances' },
  finding_events: { column: 'finding_id', parent: 'findings' },
  report_pack_items: { column: 'pack_id', parent: 'report_packs' },
  portal_question_messages: { column: 'question_id', parent: 'portal_questions' },
  portal_question_attachments: { column: 'question_id', parent: 'portal_questions' },
  reminder_suppressions: { column: 'contact_id', parent: 'portal_contacts' },
  // Children of excluded tables (delete plan only; never archived).
  share_session_participants: { column: 'session_id', parent: 'share_sessions' },
  share_session_audit: { column: 'session_id', parent: 'share_sessions' },
  portal_passwords: { column: 'contact_id', parent: 'portal_contacts' },
};

/**
 * Rule 1. Tables deliberately left out of tenant archives, with a closed
 * category and a scope. Starts from the system-backup exclusions
 * (backup-table-plan.ts) and adds credentials, server-only features,
 * derived data and install bookkeeping.
 */
export const EXCLUDED_TENANT_ARCHIVE_TABLES: Record<string, ExcludedTable> = {
  // session-token ────────────────────────────────────────────────────
  sessions: { category: 'session-token', scope: 'tenant', reason: 'refresh-token hashes; users re-login after a restore' },
  portal_contact_sessions: { category: 'session-token', scope: 'tenant', reason: 'portal session tokens' },
  portal_magic_links: { category: 'session-token', scope: 'tenant', reason: 'one-time portal login tokens' },
  password_reset_tokens: { category: 'session-token', scope: 'none', reason: 'one-time reset tokens keyed by user' },
  magic_links: { category: 'session-token', scope: 'none', reason: 'one-time passwordless login tokens keyed by user' },
  tfa_codes: { category: 'session-token', scope: 'none', reason: 'one-time OTP codes keyed by user' },
  tfa_trusted_devices: { category: 'session-token', scope: 'none', reason: 'trusted-device fingerprints keyed by user' },
  oauth_authorization_codes: { category: 'session-token', scope: 'none', reason: 'OAuth code-exchange state' },
  // secret ───────────────────────────────────────────────────────────
  api_keys: { category: 'secret', scope: 'tenant', reason: 'API key hashes; install-local credentials are never restored' },
  storage_providers: { category: 'secret', scope: 'tenant', reason: 'cloud storage provider OAuth tokens' },
  passkeys: { category: 'secret', scope: 'none', reason: 'WebAuthn credentials keyed by user' },
  portal_identities: { category: 'secret', scope: 'none', reason: 'install-wide portal login identities with password hashes' },
  portal_passwords: { category: 'secret', scope: 'child-of:portal_contacts', reason: 'portal contact password hashes' },
  plaid_items: { category: 'secret', scope: 'none', reason: 'Plaid item access tokens' },
  oauth_clients: { category: 'secret', scope: 'none', reason: 'OAuth client secrets' },
  oauth_tokens: { category: 'secret', scope: 'none', reason: 'OAuth access and refresh token hashes' },
  // job-bookkeeping ──────────────────────────────────────────────────
  backup_runs: { category: 'job-bookkeeping', scope: 'none', reason: 'appliance backup run log (tenant_id is nulled on delete)' },
  storage_migrations: { category: 'job-bookkeeping', scope: 'tenant', reason: 'storage-provider migration job records' },
  // derived ──────────────────────────────────────────────────────────
  gl_version_stamps: { category: 'derived', scope: 'tenant', reason: 'rebuilt by the 0144 triggers on insert; archived rows would violate uniq_gl_version_stamps' },
  // provenance ───────────────────────────────────────────────────────
  tenant_archive_imports: { category: 'provenance', scope: 'tenant', reason: 'install-local import provenance (0217)' },
  // server-feature: route families the desktop edition does not mount ─
  bank_connect_invites: { category: 'server-feature', scope: 'tenant', family: '/api/bank-connect', reason: 'public bank-connect links' },
  plaid_account_mappings: { category: 'server-feature', scope: 'tenant', family: '/api/v1/plaid', reason: 'Plaid account mappings' },
  plaid_item_activity: { category: 'server-feature', scope: 'tenant', family: '/api/v1/plaid', reason: 'Plaid item activity' },
  plaid_accounts: { category: 'server-feature', scope: 'none', family: '/api/v1/plaid', reason: 'Plaid accounts' },
  plaid_webhook_log: { category: 'server-feature', scope: 'none', family: '/api/v1/plaid', reason: 'Plaid webhook log' },
  share_sessions: { category: 'server-feature', scope: 'tenant', family: '/api/v1/share', reason: 'peer screen share (Redis)' },
  share_session_participants: { category: 'server-feature', scope: 'child-of:share_sessions', family: '/api/v1/share', reason: 'peer screen share participants' },
  share_session_audit: { category: 'server-feature', scope: 'child-of:share_sessions', family: '/api/v1/share', reason: 'peer screen share audit (append-only trigger)' },
  stripe_webhook_log: { category: 'server-feature', scope: 'tenant', family: '/api/v1/stripe', reason: 'Stripe webhook log' },
  firm_invites: { category: 'server-feature', scope: 'tenant', family: '/api/v1/firm-invites', reason: 'accounting-firm invitations' },
  firms: { category: 'server-feature', scope: 'none', family: '/api/v1/firms', reason: 'accounting firms' },
  tailscale_audit_log: { category: 'server-feature', scope: 'none', family: '/api/v1/admin/tailscale', reason: 'Tailscale audit log' },
  // server-feature: firm-keyed (firm_id NOT NULL) ─────────────────────
  tenant_firm_assignments: { category: 'server-feature', scope: 'tenant', firmKeyed: true, reason: 'firm assignment of a tenant' },
  tenant_firm_tag_bindings: { category: 'server-feature', scope: 'tenant', firmKeyed: true, reason: 'firm tag template bindings' },
  pm_client_links: { category: 'server-feature', scope: 'tenant', firmKeyed: true, reason: 'practice-management client links' },
  tax_est_payments: { category: 'server-feature', scope: 'tenant', firmKeyed: true, reason: 'firm tax-estimator payments' },
  tax_est_sch_ai_snapshots: { category: 'server-feature', scope: 'tenant', firmKeyed: true, reason: 'firm tax-estimator AI snapshots' },
  firm_users: { category: 'server-feature', scope: 'none', firmKeyed: true, reason: 'firm staff membership' },
  firm_integrations: { category: 'server-feature', scope: 'none', firmKeyed: true, reason: 'firm integration credentials' },
  firm_peers: { category: 'server-feature', scope: 'none', firmKeyed: true, reason: 'firm peer connections' },
  firm_tag_templates: { category: 'server-feature', scope: 'none', firmKeyed: true, reason: 'firm tag templates' },
  tax_est_firm_settings: { category: 'server-feature', scope: 'none', firmKeyed: true, reason: 'firm tax-estimator settings' },
  tax_est_taxpayers: { category: 'server-feature', scope: 'none', firmKeyed: true, reason: 'firm tax-estimator taxpayers' },
  tax_est_taxpayer_staff: { category: 'server-feature', scope: 'none', firmKeyed: true, reason: 'firm tax-estimator staff assignments' },
  tax_est_snapshots: { category: 'server-feature', scope: 'none', firmKeyed: true, reason: 'firm tax-estimator snapshots' },
  tax_est_dashboard_summaries: { category: 'server-feature', scope: 'none', firmKeyed: true, reason: 'firm tax-estimator dashboard summaries' },
  // server-feature: NOT NULL reference into an excluded table (rule 4c cascade) ─
  tax_est_adjustments: { category: 'server-feature', scope: 'tenant', cascadeOf: 'tax_est_scenarios', reason: 'rows belong to a firm taxpayer scenario' },
  tax_est_links: { category: 'server-feature', scope: 'tenant', cascadeOf: 'tax_est_persons', reason: 'rows belong to a firm taxpayer person' },
  tax_est_persons: { category: 'server-feature', scope: 'none', cascadeOf: 'tax_est_taxpayers', reason: 'firm taxpayer persons' },
  tax_est_years: { category: 'server-feature', scope: 'none', cascadeOf: 'tax_est_taxpayers', reason: 'firm taxpayer years' },
  tax_est_dependents: { category: 'server-feature', scope: 'none', cascadeOf: 'tax_est_taxpayers', reason: 'firm taxpayer dependents' },
  tax_est_outside_entities: { category: 'server-feature', scope: 'none', cascadeOf: 'tax_est_taxpayers', reason: 'firm taxpayer outside entities' },
  tax_est_outside_entity_years: { category: 'server-feature', scope: 'none', cascadeOf: 'tax_est_outside_entities', reason: 'firm taxpayer outside entity years' },
  tax_est_scenarios: { category: 'server-feature', scope: 'none', cascadeOf: 'tax_est_taxpayers', reason: 'firm taxpayer scenarios' },
  tax_est_state_rows: { category: 'server-feature', scope: 'none', cascadeOf: 'tax_est_scenarios', reason: 'firm taxpayer scenario state rows' },
  tax_est_taxpayer_contacts: { category: 'server-feature', scope: 'none', cascadeOf: 'tax_est_taxpayers', reason: 'firm taxpayer portal contacts' },
};

/** Rule 4a. Natural keys of global tables that get fresh ids on every install. */
export const NATURAL_KEYS: Record<string, { columns: string[]; orderBy?: string }> = {
  coa_templates: { columns: ['slug'] },
  tax_code_seed_versions: { columns: ['tax_year', 'source_file_hash'] },
  payroll_provider_templates: { columns: ['provider_key', 'name'] },
  report_letters: { columns: ['letter_type', 'name'] },
  // No unique constraint: the active row wins, then the newest.
  ai_prompt_templates: { columns: ['task_type', 'provider', 'version'], orderBy: 'is_active DESC, created_at DESC' },
  fs_layout_templates: { columns: ['name'] },
  fs_style_presets: { columns: ['builtin_key'] },
};

/** Rule 4a. Every FK from an archived table to a global table, enumerated from pg_constraint. */
export const GLOBAL_FK_RULES: Record<string, GlobalRefStrategy> = {
  'check_params_overrides.check_key': 'pass-through',
  'check_suppressions.check_key': 'pass-through',
  'findings.check_key': 'pass-through',
  'company_tax_profiles.pinned_seed_version_id': 'map-by-natural-key',
  'report_packs.letter_id': 'map-by-natural-key',
};

/** Rule 4b. Every uuid / uuid[] column on an archived or identity table that is not an FK. */
export const SOFT_REFS: Record<string, SoftRefClass> = {
  'account_tax_assignments.company_id': 'tenant-ref:companies',
  'account_tax_assignments.account_id': 'tenant-ref:accounts',
  'account_tax_assignments.assigned_by': 'identity',
  'accountant_company_exclusions.user_id': 'identity',
  'accountant_company_exclusions.company_id': 'tenant-ref:companies',
  'accounts.parent_id': 'tenant-ref:accounts',
  'accounts.company_id': 'tenant-ref:companies',
  'accrual_entries.transaction_id': 'tenant-ref:transactions',
  'accrual_entries.posted_by': 'identity',
  'accrual_schedules.company_id': 'tenant-ref:companies',
  'accrual_schedules.contact_id': 'tenant-ref:contacts',
  'accrual_schedules.source_transaction_id': 'tenant-ref:transactions',
  'accrual_schedules.balance_account_id': 'tenant-ref:accounts',
  'accrual_schedules.recognition_account_id': 'tenant-ref:accounts',
  'accrual_schedules.created_by': 'identity',
  'activity_units.company_id': 'tenant-ref:companies',
  'ai_jobs.input_id': 'polymorphic',
  'annual_1099_filings.exported_by': 'identity',
  'annual_1099_filings.correction_of': 'tenant-ref:annual_1099_filings',
  'annual_1099_filings.firm_id': 'excluded-ref:firms',
  'attachments.attachable_id': 'polymorphic',
  'attachments.company_id': 'tenant-ref:companies',
  'audit_log.user_id': 'identity',
  'audit_log.entity_id': 'polymorphic',
  'audit_log.company_id': 'tenant-ref:companies',
  'bank_connections.account_id': 'tenant-ref:accounts',
  'bank_connections.company_id': 'tenant-ref:companies',
  'bank_feed_items.bank_connection_id': 'tenant-ref:bank_connections',
  'bank_feed_items.matched_transaction_id': 'tenant-ref:transactions',
  'bank_feed_items.suggested_account_id': 'tenant-ref:accounts',
  'bank_feed_items.suggested_contact_id': 'tenant-ref:contacts',
  'bank_feed_items.company_id': 'tenant-ref:companies',
  'bank_feed_items.assigned_account_id': 'tenant-ref:accounts',
  'bank_feed_items.assigned_contact_id': 'tenant-ref:contacts',
  'bank_feed_items.assigned_tag_id': 'tenant-ref:tags',
  'bank_feed_items.assigned_by': 'identity',
  'bank_feed_items.close_reviewed_by': 'identity',
  'bank_rules.bank_account_id': 'tenant-ref:accounts',
  'bank_rules.assign_account_id': 'tenant-ref:accounts',
  'bank_rules.assign_contact_id': 'tenant-ref:contacts',
  'bank_rules.company_id': 'tenant-ref:companies',
  'bank_statements.company_id': 'tenant-ref:companies',
  'bill_captures.uploaded_by_user_id': 'identity',
  'bill_payment_applications.company_id': 'tenant-ref:companies',
  'bill_payment_applications.payment_id': 'tenant-ref:transactions',
  'bill_payment_applications.bill_id': 'tenant-ref:transactions',
  'budget_lines.budget_id': 'tenant-ref:budgets',
  'budget_lines.account_id': 'tenant-ref:accounts',
  'budgets.company_id': 'tenant-ref:companies',
  'budgets.created_by': 'identity',
  'categorization_history.account_id': 'tenant-ref:accounts',
  'categorization_history.contact_id': 'tenant-ref:contacts',
  'chat_conversations.user_id': 'identity',
  'check_params_overrides.company_id': 'tenant-ref:companies',
  'check_runs.company_id': 'tenant-ref:companies',
  'check_signature_users.granted_by': 'identity',
  'check_signatures.created_by': 'identity',
  'check_suppressions.company_id': 'tenant-ref:companies',
  'check_suppressions.created_by': 'identity',
  'client_category_suggestions.transaction_id': 'tenant-ref:transactions',
  'client_category_suggestions.reviewed_by': 'identity',
  'client_category_suggestions.resolved_account_id': 'tenant-ref:accounts',
  'client_category_suggestions.posted_transaction_id': 'tenant-ref:transactions',
  'client_category_suggestions.submitted_by_user_id': 'identity',
  'client_category_suggestions.resolved_contact_id': 'tenant-ref:contacts',
  'close_checklist_signoffs.company_id': 'tenant-ref:companies',
  'close_checklist_signoffs.completed_by': 'identity',
  'closes.company_id': 'tenant-ref:companies',
  'closes.prepared_by': 'identity',
  'closes.reviewed_by': 'identity',
  'companies.lock_date_set_by': 'identity',
  'company_tax_profiles.company_id': 'tenant-ref:companies',
  'conditional_rule_audit.bank_feed_item_id': 'tenant-ref:bank_feed_items',
  'conditional_rule_audit.transaction_id': 'tenant-ref:transactions',
  'conditional_rule_audit.effective_firm_id': 'excluded-ref:firms',
  'conditional_rules.company_id': 'tenant-ref:companies',
  'conditional_rules.created_by': 'identity',
  'conditional_rules.owner_user_id': 'identity',
  'conditional_rules.forked_from_global_id': 'global-ref:null',
  'contacts.default_expense_account_id': 'tenant-ref:accounts',
  'contacts.company_id': 'tenant-ref:companies',
  'daily_sales_entries.company_id': 'tenant-ref:companies',
  'daily_sales_entries.template_id': 'tenant-ref:daily_sales_templates',
  'daily_sales_entries.transaction_id': 'tenant-ref:transactions',
  'daily_sales_entries.tag_id': 'tenant-ref:tags',
  'daily_sales_entries.created_by': 'identity',
  'daily_sales_entry_values.entry_id': 'tenant-ref:daily_sales_entries',
  'daily_sales_entry_values.template_line_id': 'tenant-ref:daily_sales_template_lines',
  'daily_sales_entry_values.tag_id': 'tenant-ref:tags',
  'daily_sales_template_lines.template_id': 'tenant-ref:daily_sales_templates',
  'daily_sales_template_lines.account_id': 'tenant-ref:accounts',
  'daily_sales_template_lines.tag_id': 'tenant-ref:tags',
  'daily_sales_templates.company_id': 'tenant-ref:companies',
  'daily_sales_templates.default_tag_id': 'tenant-ref:tags',
  'deposit_lines.deposit_id': 'tenant-ref:transactions',
  'deposit_lines.source_transaction_id': 'tenant-ref:transactions',
  'document_requests.reviewed_by': 'identity',
  'document_requests.bank_connection_id': 'tenant-ref:bank_connections',
  'duplicate_dismissals.transaction_id_a': 'tenant-ref:transactions',
  'duplicate_dismissals.transaction_id_b': 'tenant-ref:transactions',
  'duplicate_dismissals.dismissed_by': 'identity',
  'duplicate_dismissals.company_id': 'tenant-ref:companies',
  'email_templates.company_id': 'tenant-ref:companies',
  'extracted_records.job_id': 'tenant-ref:extraction_jobs',
  'extraction_jobs.company_id': 'tenant-ref:companies',
  'extraction_pages.job_id': 'tenant-ref:extraction_jobs',
  'extraction_review_queue.job_id': 'tenant-ref:extraction_jobs',
  'extraction_review_queue.reviewer': 'identity',
  'finding_events.user_id': 'identity',
  'findings.company_id': 'tenant-ref:companies',
  'findings.transaction_id': 'tenant-ref:transactions',
  'findings.vendor_id': 'tenant-ref:contacts',
  'findings.assigned_to': 'identity',
  'firm_tax_codes.created_by': 'identity',
  'fs_cash_flow_overrides.account_id': 'tenant-ref:accounts',
  'fs_cash_flow_overrides.grouping_id': 'tenant-ref:tb_groupings',
  'fs_cash_flow_overrides.updated_by': 'identity',
  'fs_company_layouts.source_template_id': 'mixed-ref:fs_layout_templates',
  'fs_company_layouts.source_style_preset_id': 'mixed-ref:fs_style_presets',
  'fs_company_layouts.created_by': 'identity',
  'fs_company_layouts.updated_by': 'identity',
  'fs_firm_profiles.firm_id': 'excluded-ref:firms',
  'fs_firm_profiles.updated_by': 'identity',
  'fs_layout_templates.firm_id': 'excluded-ref:firms',
  'fs_layout_templates.created_by': 'identity',
  'fs_report_letters.firm_id': 'excluded-ref:firms',
  'fs_report_letters.source_report_letter_id': 'global-ref:report_letters',
  'fs_report_letters.created_by': 'identity',
  'fs_report_versions.finalized_by': 'identity',
  'fs_report_versions.reopened_by': 'identity',
  'fs_report_versions.published_instance_id': 'tenant-ref:report_instances',
  'fs_report_versions.published_by': 'identity',
  'fs_reports.tag_id': 'tenant-ref:tags',
  'fs_reports.current_version_id': 'tenant-ref:fs_report_versions',
  'fs_reports.created_by': 'identity',
  'fs_reports.updated_by': 'identity',
  'fs_style_presets.firm_id': 'excluded-ref:firms',
  'fs_style_presets.created_by': 'identity',
  'import_sessions.company_id': 'tenant-ref:companies',
  'import_sessions.created_by': 'identity',
  'invoice_templates.company_id': 'tenant-ref:companies',
  'items.income_account_id': 'tenant-ref:accounts',
  'items.company_id': 'tenant-ref:companies',
  'je_template_lines.template_id': 'tenant-ref:je_templates',
  'je_template_lines.account_id': 'tenant-ref:accounts',
  'je_template_lines.tag_id': 'tenant-ref:tags',
  'je_templates.company_id': 'tenant-ref:companies',
  'je_templates.default_tag_id': 'tenant-ref:tags',
  'journal_lines.transaction_id': 'tenant-ref:transactions',
  'journal_lines.account_id': 'tenant-ref:accounts',
  'journal_lines.item_id': 'tenant-ref:items',
  'journal_lines.company_id': 'tenant-ref:companies',
  'journal_lines.contact_id': 'tenant-ref:contacts',
  'mcp_request_log.user_id': 'identity',
  'mcp_request_log.api_key_id': 'excluded-ref:api_keys',
  'mcp_request_log.oauth_client_id': 'excluded-ref:oauth_clients',
  'mcp_request_log.company_id': 'tenant-ref:companies',
  'payment_applications.payment_id': 'tenant-ref:transactions',
  'payment_applications.invoice_id': 'tenant-ref:transactions',
  'payment_applications.company_id': 'tenant-ref:companies',
  'payroll_account_mapping.company_id': 'tenant-ref:companies',
  'payroll_account_mapping.account_id': 'tenant-ref:accounts',
  'payroll_check_register_rows.session_id': 'tenant-ref:payroll_import_sessions',
  'payroll_check_register_rows.transaction_id': 'tenant-ref:transactions',
  'payroll_description_account_map.company_id': 'tenant-ref:companies',
  'payroll_description_account_map.account_id': 'tenant-ref:accounts',
  'payroll_description_account_map.tag_id': 'tenant-ref:tags',
  'payroll_import_column_mappings.session_id': 'tenant-ref:payroll_import_sessions',
  'payroll_import_errors.session_id': 'tenant-ref:payroll_import_sessions',
  'payroll_import_rows.session_id': 'tenant-ref:payroll_import_sessions',
  'payroll_import_sessions.company_id': 'tenant-ref:companies',
  'payroll_import_sessions.template_id': 'mixed-ref:payroll_provider_templates',
  'payroll_import_sessions.journal_entry_id': 'tenant-ref:transactions',
  'payroll_import_sessions.created_by': 'identity',
  'portal_question_attachments.uploaded_by': 'polymorphic',
  'portal_question_messages.sender_id': 'polymorphic',
  'portal_question_templates.created_by': 'identity',
  'portal_questions.transaction_id': 'tenant-ref:transactions',
  'portal_questions.split_line_id': 'tenant-ref:journal_lines',
  'portal_questions.created_by': 'identity',
  'portal_receipts.uploaded_by': 'polymorphic',
  'portal_receipts.matched_transaction_id': 'tenant-ref:transactions',
  'preview_sessions.user_id': 'identity',
  'reconciliation_lines.reconciliation_id': 'tenant-ref:reconciliations',
  'reconciliation_lines.journal_line_id': 'tenant-ref:journal_lines',
  'reconciliation_signoffs.user_id': 'identity',
  'reconciliation_signoffs.invalidated_by': 'identity',
  'reconciliations.account_id': 'tenant-ref:accounts',
  'reconciliations.completed_by': 'identity',
  'reconciliations.company_id': 'tenant-ref:companies',
  'recurring_schedules.template_transaction_id': 'tenant-ref:transactions',
  'recurring_schedules.company_id': 'tenant-ref:companies',
  'reminder_sends.question_id': 'tenant-ref:portal_questions',
  'report_ai_summaries.prompt_template_id': 'global-ref:ai_prompt_templates',
  'report_ai_summaries.edited_by': 'identity',
  'report_comments.author_id': 'identity',
  'report_instances.created_by': 'identity',
  'report_instances.fs_report_version_id': 'tenant-ref:fs_report_versions',
  'report_pack_runs.requested_by': 'identity',
  'report_packs.default_tag_id': 'tenant-ref:tags',
  'report_packs.created_by': 'identity',
  'report_templates.created_by': 'identity',
  'rule_exception_dismissals.transaction_id': 'tenant-ref:transactions',
  'rule_exception_dismissals.rule_id': 'tenant-ref:bank_rules',
  'rule_exception_dismissals.dismissed_by': 'identity',
  'rule_suggestion_dismissals.account_id': 'tenant-ref:accounts',
  'rule_suggestion_dismissals.dismissed_by': 'identity',
  'saved_report_filters.company_id': 'tenant-ref:companies',
  'statement_gap_dismissals.dismissed_by': 'identity',
  'suggestion_notify_settings.updated_by': 'identity',
  'tag_activity_map.company_id': 'tenant-ref:companies',
  'tag_activity_map.tag_id': 'tenant-ref:tags',
  'tag_groups.company_id': 'tenant-ref:companies',
  'tags.group_id': 'tenant-ref:tag_groups',
  'tags.company_id': 'tenant-ref:companies',
  'tax_est_account_treatment_splits.company_id': 'tenant-ref:companies',
  'tax_est_account_treatments.company_id': 'tenant-ref:companies',
  'tax_est_account_treatments.updated_by': 'identity',
  'tax_est_entity_settings.company_id': 'tenant-ref:companies',
  'tax_est_entity_settings.updated_by': 'identity',
  'tax_est_entity_year_inputs.company_id': 'tenant-ref:companies',
  'tax_est_entity_year_inputs.updated_by': 'identity',
  'tax_est_portal_contact_options.updated_by': 'identity',
  'tax_est_transaction_flags.updated_by': 'identity',
  'tb_aje_sequences.company_id': 'tenant-ref:companies',
  'tb_exports.company_id': 'tenant-ref:companies',
  'tb_exports.created_by': 'identity',
  'tb_grouping_accounts.company_id': 'tenant-ref:companies',
  'tb_grouping_accounts.account_id': 'tenant-ref:accounts',
  'tb_groupings.company_id': 'tenant-ref:companies',
  'tb_groupings.parent_id': 'tenant-ref:tb_groupings',
  'tb_leadsheet_signoffs.company_id': 'tenant-ref:companies',
  'tb_leadsheet_signoffs.user_id': 'identity',
  'tb_notes.company_id': 'tenant-ref:companies',
  'tb_notes.account_id': 'tenant-ref:accounts',
  'tb_notes.author_id': 'identity',
  'tb_notes.resolved_by': 'identity',
  'tb_row_attachments.company_id': 'tenant-ref:companies',
  'tb_row_attachments.account_id': 'tenant-ref:accounts',
  'tb_row_attachments.created_by': 'identity',
  'tb_status.company_id': 'tenant-ref:companies',
  'tb_status.completed_by': 'identity',
  'tb_tax_entries.company_id': 'tenant-ref:companies',
  'tb_tax_entries.created_by': 'identity',
  'tb_tax_entry_lines.account_id': 'tenant-ref:accounts',
  'tb_tickmark_applications.company_id': 'tenant-ref:companies',
  'tb_tickmark_applications.account_id': 'tenant-ref:accounts',
  'tb_tickmark_applications.applied_by': 'identity',
  'transaction_classification_state.company_id': 'tenant-ref:companies',
  'transaction_classification_state.transaction_id': 'tenant-ref:transactions',
  'transaction_classification_state.suggested_account_id': 'tenant-ref:accounts',
  'transaction_classification_state.suggested_vendor_id': 'tenant-ref:contacts',
  'transaction_tags.transaction_id': 'tenant-ref:transactions',
  'transaction_tags.tag_id': 'tenant-ref:tags',
  'transaction_tags.company_id': 'tenant-ref:companies',
  'transactions.contact_id': 'tenant-ref:contacts',
  'transactions.recurring_schedule_id': 'tenant-ref:recurring_schedules',
  'transactions.source_estimate_id': 'tenant-ref:transactions',
  'transactions.applied_to_invoice_id': 'tenant-ref:transactions',
  'transactions.print_batch_id': 'tenant-ref:check_runs',
  'transactions.company_id': 'tenant-ref:companies',
  'transactions.print_signature_id': 'tenant-ref:check_signatures',
  'user_permissions.user_id': 'identity',
  'user_tenant_access.user_id': 'identity',
  'vendor_1099_account_mappings.created_by': 'identity',
  'vendor_1099_profile.w9_document_id': 'tenant-ref:attachments',
  'vendor_1099_profile.excluded_by': 'identity',
  'vendor_credit_applications.company_id': 'tenant-ref:companies',
  'vendor_credit_applications.payment_id': 'tenant-ref:transactions',
  'vendor_credit_applications.credit_id': 'tenant-ref:transactions',
  'vendor_credit_applications.bill_id': 'tenant-ref:transactions',
  'w9_requests.w9_document_id': 'tenant-ref:attachments',
  'w9_requests.created_by': 'identity',
};

/**
 * Rule 3. Unique indexes on archived tables that include no remapped column
 * (tenant_id, the table's own pk, or a column that references a remapped
 * table) must say what happens to the column on import.
 */
export const UNIQUE_INDEX_RULES: Record<string, UniqueIndexRule> = {
  'transactions.public_token': 'null',
  'report_instances.share_token': 'null',
  'tenants.slug': 'regenerate',
  'tenants.is_workspace': 'force-false',
};

/** Rule 5. Every column on an archived or identity table whose name matches SECRET_COLUMN_RE. */
export const SECRET_COLUMN_RE = /(secret|token|password|pass$|passwd|passphrase|api_?key|encrypted|hash|otp|refresh|credential)/i;

export const SECRET_COLUMNS: Record<string, SecretColumnRule> = {
  'ai_jobs.input_tokens': { action: 'keep', reason: 'LLM token count, not a credential' },
  'ai_jobs.output_tokens': { action: 'keep', reason: 'LLM token count, not a credential' },
  'ai_usage_log.input_tokens': { action: 'keep', reason: 'LLM token count, not a credential' },
  'ai_usage_log.output_tokens': { action: 'keep', reason: 'LLM token count, not a credential' },
  'chat_messages.input_tokens': { action: 'keep', reason: 'LLM token count, not a credential' },
  'chat_messages.output_tokens': { action: 'keep', reason: 'LLM token count, not a credential' },
  'bank_connections.access_token_encrypted': { action: 'redact', reason: 'bank feed provider access token (the connection record itself is business data)' },
  'companies.smtp_pass': { action: 'redact', reason: 'SMTP password (owner re-enters it after a restore)' },
  'companies.remote_backup_passphrase_hash': { action: 'redact', reason: 'appliance remote-backup passphrase hash' },
  'companies.stripe_secret_key_encrypted': { action: 'redact', reason: 'Stripe secret key' },
  'companies.stripe_webhook_secret_encrypted': { action: 'redact', reason: 'Stripe webhook secret' },
  'extraction_jobs.file_hash': { action: 'keep', reason: 'content hash of the uploaded document' },
  'fs_report_versions.numbers_hash': { action: 'keep', reason: 'content hash of the report numbers' },
  'import_sessions.file_hash': { action: 'keep', reason: 'content hash of the imported file' },
  'mcp_request_log.api_key_id': { action: 'keep', reason: 'row id of an API key (nulled as an excluded reference), not a credential' },
  'payroll_import_sessions.file_hash': { action: 'keep', reason: 'content hash of the payroll file' },
  'report_instances.share_token': { action: 'redact', reason: 'public share-link token (also nulled by UNIQUE_INDEX_RULES)' },
  'transactions.public_token': { action: 'redact', reason: 'public invoice-link token (also nulled by UNIQUE_INDEX_RULES)' },
  'users.password_hash': { action: 'keep', reason: 'owner decision 3 (H4 default): travels only when the exporting caller is a super admin, never for a super admin user; otherwise the identity projection writes ARCHIVE_PASSWORD_PLACEHOLDER (identity.ts)' },
  'users.tfa_totp_secret_encrypted': { action: 'redact', reason: 'TFA secret; not in the users projection' },
  'users.tfa_totp_verified': { action: 'redact', reason: 'TFA state; not in the users projection' },
  'users.tfa_recovery_codes_encrypted': { action: 'redact', reason: 'TFA recovery codes; not in the users projection' },
  'users.tfa_totp_last_step': { action: 'redact', reason: 'TFA replay guard; not in the users projection' },
  'vendor_1099_profile.tin_encrypted': {
    action: 'reencrypt',
    reason: 'vendor TIN: decrypted on export, carried inside the encrypted archive, encrypted again under the importing install key (M5)',
  },
  'w9_requests.magic_link_token_hash': { action: 'redact', reason: 'public W-9 link token', replacement: "repeat('0', 64)" },
};

/** Rule 5b. jsonb/json columns on archived or identity tables whose name matches JSON_CONFIG_RE. */
export const JSON_CONFIG_RE = /(config|settings|credential|options)/i;

export const JSON_CONFIG_COLUMNS: Record<string, JsonConfigClass> = {
  'bank_feed_items.splits_config': 'contains-ids',
  // Also holds bank routing and account numbers: kept because check printing
  // needs them after a restore; the passphrase covers the archive (security review).
  'companies.check_settings': 'contains-ids',
  'companies.remote_backup_config': 'secret',
  'fs_report_versions.settings_json': 'plain',
  'import_sessions.options': 'plain',
  'report_pack_items.options_json': 'contains-ids',
  'tenants.report_settings': 'contains-ids',
  'tenants.practice_settings': 'plain',
  'tenants.share_settings': 'plain',
};

/**
 * Rule 5c (H3). Row-shaped json payloads: the audit log's before/after
 * images carry whole rows, credentials included (companies.smtp_pass, a
 * Stripe key, a password hash). On export every secret-looking key
 * (utils/secret-keys.ts, snake_case and camelCase) is stripped at every
 * depth by the SQL function mybooks_strip_secret_keys (migration 0218);
 * middleware/audit.ts strips the same keys when it writes, so the content
 * digest agrees on both sides. Any json column matching STRIPPED_JSON_RE
 * must be listed here (fail closed).
 */
export const STRIPPED_JSON_RE = /(^|_)(before|after)_data$/;

export const STRIPPED_JSON_COLUMNS: Record<string, string> = {
  'audit_log.before_data': 'secret-looking keys stripped from the audited row image (utils/secret-keys.ts)',
  'audit_log.after_data': 'secret-looking keys stripped from the audited row image (utils/secret-keys.ts)',
};

/** The SQL expression that strips secret keys from a json column of alias `a` (H3). */
export function stripSecretKeysSql(column: string, type: string): string {
  return `mybooks_strip_secret_keys(a."${column}"::jsonb, '${SECRET_KEY_PATTERN}')::${type} AS "${column}"`;
}

/** Rule 7. Columns matching FILE_COLUMN_RE on archived or identity tables, plus explicit extras. */
export const FILE_COLUMN_RE = /(file_path|storage_key|transient_key|_url|_path)$/;

export const FILE_COLUMNS: Record<string, FileColumnRule> = {
  'attachments.storage_key': { resolver: 'provider-key', domain: 'attachments', fallbackPathColumn: 'file_path', sizeColumn: 'file_size' },
  'attachments.file_path': { resolver: 'provider-path-mirror', mirrorOf: 'storage_key' },
  'attachments.local_cache_path': { resolver: 'null' },
  // Cloud-provider file id of the attachment (does not match the regex; listed explicitly).
  'attachments.provider_file_id': { resolver: 'null' },
  'check_signatures.file_path': { resolver: 'upload-encrypted', sha256Column: 'sha256' },
  'companies.logo_url': { resolver: 'logo-url' },
  'extraction_jobs.storage_key': { resolver: 'provider-key', domain: 'documents' },
  // Rendered page images (does not match the regex; listed explicitly, see backup-file-registry.ts).
  'extraction_pages.image_ref': { resolver: 'provider-key', domain: 'documents' },
  'fs_report_versions.pdf_storage_key': { resolver: 'provider-key', domain: 'reports' },
  'invoice_templates.logo_url': { resolver: 'logo-url' },
  'payroll_import_sessions.file_path': { resolver: 'upload-relative' },
  'payroll_import_sessions.companion_file_path': { resolver: 'upload-relative' },
  'portal_question_attachments.storage_key': { resolver: 'provider-key', domain: 'question-attachments' },
  'portal_receipts.storage_key': { resolver: 'provider-key', domain: 'receipts' },
  'portal_settings_per_practice.branding_logo_url': { resolver: 'logo-url' },
  'report_instances.pdf_url': { resolver: 'provider-key', domain: 'reports' },
  'report_pack_runs.transient_key': { resolver: 'null' },
  'tb_exports.storage_key': { resolver: 'provider-key', domain: 'reports' },
  'vendor_enrichment_cache.source_url': { resolver: 'not-a-file' },
};

/** Rule 8. Every non-internal trigger in the public schema. */
export const TRIGGERS: Record<string, TriggerClass> = {
  'journal_lines.trg_tb_stamp_lines_ins': 'fires-ok',
  'journal_lines.trg_tb_stamp_lines_upd': 'fires-ok',
  'journal_lines.trg_tb_stamp_lines_del': 'delete-side-effect:gl_version_stamps',
  'transactions.trg_tb_stamp_txn_upd': 'fires-ok',
  'share_session_audit.share_session_audit_append_only': 'delete-guard:mybooks.share_audit_retention',
  'tax_est_snapshots.trg_tax_est_snapshots_immutable': 'insert-safe',
};

/**
 * Columns that change without a business edit, left out of the fingerprint
 * projection. Shape rule: timestamp/timestamptz, a cache column, or a
 * free-text label; never numeric, date, boolean, status or uuid.
 */
export const VOLATILE_COLUMNS: Record<string, VolatileColumn> = {
  'tenants.name': { producedBy: 'rename (PATCH /api/v1/tenants/:id); P08 restore name swap' },
  'tenants.slug': { producedBy: 'rename (PATCH /api/v1/tenants/:id)' },
  'tenants.updated_at': { producedBy: 'rename (PATCH /api/v1/tenants/:id)' },
  'attachments.local_cache_path': { producedBy: 'attachment download through a cloud provider (cache fill)' },
  'attachments.cache_expires_at': { producedBy: 'attachment download through a cloud provider (cache fill)' },
  'user_tenant_access.last_accessed_at': { producedBy: 'switch-tenant (identity table; not fingerprinted)' },
};

/** Columns outside the tenant's own rows that point at a tenant, and what the delete plan does with them. */
export const CROSS_TENANT_COLUMNS: Record<string, CrossTenantAction> = {
  'backup_runs.tenant_id': 'set-null',
  'share_session_participants.viewer_tenant_id': 'delete',
  'global_rule_submissions.source_tenant_id': 'set-null',
  'tenant_archive_imports.source_tenant_id': 'keep',
};

/**
 * Closed widening set for archive -> live column type changes (S-h). An
 * entry is `table.column: { from, to }`; the plan test rejects any pair
 * that `isAllowedWidening` refuses. Empty until a migration widens a column.
 */
export const TYPE_CHANGES: Record<string, { from: string; to: string }> = {};

/** The audit entity type only the tenant-portability code writes. */
export const ARCHIVE_AUDIT_ENTITY_TYPE = 'tenant_archive';

/** `ZERO_COMPANY_UUID` and the nil uuid are never id-map keys. */
export const NEVER_REMAPPED_UUIDS: readonly string[] = [
  '00000000-0000-0000-0000-000000000000',
];

// ── Type widening (S-h) ──────────────────────────────────────────────

function parseNumeric(t: string): { p: number; s: number } | null {
  const m = /^numeric\((\d+),(\d+)\)$/.exec(t.replace(/\s+/g, ''));
  return m ? { p: Number(m[1]), s: Number(m[2]) } : null;
}

function parseVarchar(t: string): number | null {
  const m = /^(?:character varying|varchar)\((\d+)\)$/.exec(t);
  return m ? Number(m[1]) : null;
}

/** True when `from -> to` is in the closed widening set. */
export function isAllowedWidening(from: string, to: string): boolean {
  const f = from.trim();
  const t = to.trim();
  if (f === t) return false;
  const nf = parseNumeric(f);
  const nt = parseNumeric(t);
  if (nf && nt) return nt.p >= nf.p && nt.s >= nf.s && nt.p - nt.s >= nf.p - nf.s;
  const vf = parseVarchar(f);
  if (vf !== null) {
    if (t === 'text') return true;
    const vt = parseVarchar(t);
    return vt !== null && vt > vf;
  }
  if (f === 'smallint') return t === 'integer' || t === 'bigint';
  if (f === 'integer') return t === 'bigint';
  return false;
}

// ── Live schema ──────────────────────────────────────────────────────

export interface LiveColumn {
  name: string;
  /** format_type output, e.g. `numeric(19,4)`, `character varying(255)`, `uuid[]`. */
  type: string;
  nullable: boolean;
  hasDefault: boolean;
  generated: boolean;
  attnum: number;
}

export interface LiveFk {
  name: string;
  table: string;
  columns: string[];
  refTable: string;
  refColumns: string[];
  onDelete: string;
  deferrable: boolean;
}

export interface LiveUnique {
  table: string;
  name: string;
  definition: string;
  /** Plain columns of the index; expression parts are listed in `expressionColumns`. */
  columns: string[];
  /** Column names found inside expression parts and the WHERE predicate. */
  expressionColumns: string[];
  partial: boolean;
}

export interface LiveTrigger {
  table: string;
  name: string;
  definition: string;
  timing: 'BEFORE' | 'AFTER' | 'INSTEAD OF';
  events: string[];
  functionBody: string;
}

export interface LiveTable {
  name: string;
  columns: LiveColumn[];
  pkColumns: string[];
}

export interface LiveSchema {
  tables: Map<string, LiveTable>;
  fks: LiveFk[];
  uniques: LiveUnique[];
  triggers: LiveTrigger[];
}

const IDENT_RE = /^[a-z_][a-z0-9_]*$/;

export async function readLiveSchema(dbi: DbLike = db): Promise<LiveSchema> {
  const tables = new Map<string, LiveTable>();
  const colRows = (await dbi.execute(sql`
    SELECT c.relname AS table_name, a.attname AS column_name,
           format_type(a.atttypid, a.atttypmod) AS type,
           NOT a.attnotnull AS nullable,
           a.atthasdef AS has_default,
           (a.attgenerated <> '' OR a.attidentity <> '') AS generated,
           a.attnum
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
    WHERE n.nspname = 'public' AND c.relkind = 'r'
    ORDER BY c.relname, a.attnum
  `)).rows as Array<{ table_name: string; column_name: string; type: string; nullable: boolean; has_default: boolean; generated: boolean; attnum: number }>;
  for (const r of colRows) {
    if (!IDENT_RE.test(r.table_name)) continue;
    let t = tables.get(r.table_name);
    if (!t) {
      t = { name: r.table_name, columns: [], pkColumns: [] };
      tables.set(r.table_name, t);
    }
    t.columns.push({
      name: r.column_name, type: r.type, nullable: r.nullable, hasDefault: r.has_default,
      generated: r.generated, attnum: Number(r.attnum),
    });
  }
  const pkRows = (await dbi.execute(sql`
    SELECT c.relname AS table_name, a.attname AS column_name
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN unnest(i.indkey) WITH ORDINALITY k(attnum, ord) ON true
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
    WHERE n.nspname = 'public' AND i.indisprimary
    ORDER BY c.relname, k.ord
  `)).rows as Array<{ table_name: string; column_name: string }>;
  for (const r of pkRows) tables.get(r.table_name)?.pkColumns.push(r.column_name);

  const fkRows = (await dbi.execute(sql`
    SELECT con.conname AS name, c.relname AS table_name, r.relname AS ref_table,
           con.condeferrable AS deferrable, con.confdeltype AS on_delete,
           (SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(con.conkey) WITH ORDINALITY k(attnum, ord)
              JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum) AS columns,
           (SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(con.confkey) WITH ORDINALITY k(attnum, ord)
              JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum) AS ref_columns
    FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_class r ON r.oid = con.confrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.contype = 'f' AND n.nspname = 'public'
    ORDER BY c.relname, con.conname
  `)).rows as Array<{ name: string; table_name: string; ref_table: string; deferrable: boolean; on_delete: string; columns: string[]; ref_columns: string[] }>;
  const fks: LiveFk[] = fkRows.map((r) => ({
    name: r.name, table: r.table_name, columns: r.columns, refTable: r.ref_table, refColumns: r.ref_columns,
    onDelete: { a: 'NO ACTION', r: 'RESTRICT', c: 'CASCADE', n: 'SET NULL', d: 'SET DEFAULT' }[r.on_delete] ?? r.on_delete,
    deferrable: r.deferrable,
  }));

  const uqRows = (await dbi.execute(sql`
    SELECT c.relname AS table_name, ic.relname AS name, pg_get_indexdef(i.indexrelid) AS definition,
           i.indpred IS NOT NULL AS partial,
           (SELECT array_agg(COALESCE(a.attname::text, '') ORDER BY k.ord) FROM unnest(i.indkey) WITH ORDINALITY k(attnum, ord)
              LEFT JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum AND k.attnum > 0) AS columns
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indrelid
    JOIN pg_class ic ON ic.oid = i.indexrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND i.indisunique AND NOT i.indisprimary
    ORDER BY c.relname, ic.relname
  `)).rows as Array<{ table_name: string; name: string; definition: string; partial: boolean; columns: string[] }>;
  const uniques: LiveUnique[] = uqRows.map((r) => {
    const t = tables.get(r.table_name);
    const names = new Set((t?.columns ?? []).map((c) => c.name));
    const plain = (r.columns ?? []).filter((c) => c !== '');
    const tail = r.definition.slice(r.definition.indexOf('(')) ;
    const expressionColumns = [...new Set((tail.match(/[a-z_][a-z0-9_]*/g) ?? []).filter((w) => names.has(w) && !plain.includes(w)))];
    return { table: r.table_name, name: r.name, definition: r.definition, columns: plain, expressionColumns, partial: r.partial };
  });

  const trgRows = (await dbi.execute(sql`
    SELECT c.relname AS table_name, t.tgname AS name, pg_get_triggerdef(t.oid) AS definition, p.prosrc AS body
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_proc p ON p.oid = t.tgfoid
    WHERE n.nspname = 'public' AND NOT t.tgisinternal
    ORDER BY c.relname, t.tgname
  `)).rows as Array<{ table_name: string; name: string; definition: string; body: string }>;
  const triggers: LiveTrigger[] = trgRows.map((r) => {
    const m = /\b(BEFORE|AFTER|INSTEAD OF)\s+(.+?)\s+ON\s/.exec(r.definition);
    const events = (m?.[2] ?? '').split(/\s+OR\s+/).map((e) => e.replace(/\s+OF\s+.*$/, '').trim().toUpperCase());
    return {
      table: r.table_name, name: r.name, definition: r.definition,
      timing: (m?.[1] ?? 'AFTER') as LiveTrigger['timing'], events, functionBody: r.body,
    };
  });

  return { tables, fks, uniques, triggers };
}

// ── Plan ─────────────────────────────────────────────────────────────

export class PortabilityPlanError extends Error {
  constructor(public code: string, message: string, public details: Record<string, unknown> = {}) {
    super(`${code}: ${message}`);
    this.name = 'PortabilityPlanError';
  }
}

export interface ArchiveColumn {
  name: string;
  /** Declared type in the manifest (format_type). */
  type: string;
  /** SQL select expression for the archive projection, e.g. `a."memo"` or `NULL::text AS "smtp_pass"`. */
  select: string;
  redacted: boolean;
  nulledReference: string | null;
}

export interface TablePlan {
  name: string;
  bucket: 'tenant' | 'child';
  pk: PkShape;
  pkColumn: string | null;
  /** Live columns in attnum order, generated columns excluded. */
  columns: LiveColumn[];
  /** Archive projection A(T). */
  archive: ArchiveColumn[];
  /** Canonical projection C(T) column names. */
  canonical: string[];
  /** Fingerprint projection F(T) column names. */
  fingerprint: string[];
  /** Columns inserted on import (archive columns minus omit-pk). */
  insert: string[];
  /** Columns rewritten on import, excluded from C(T). */
  regenerate: string[];
  nullOnImport: string[];
  /** FK columns that close a nullable FK cycle: inserted as NULL, set after every table is in. */
  deferredColumns: string[];
  /** Columns decrypted on export and encrypted again on import (SECRET_COLUMNS action `reencrypt`, M5); not in C(T). */
  reencryptColumns: string[];
  fileColumns: Array<{ column: string; rule: FileColumnRule }>;
  /** Soft references classified for this table. */
  softRefs: Array<{ column: string; cls: SoftRefClass; isArray: boolean }>;
  globalFks: Array<{ column: string; refTable: string; refColumn: string; strategy: GlobalRefStrategy; nullable: boolean }>;
  nulledReferences: Array<{ column: string; target: string }>;
  triggers: Array<{ name: string; cls: TriggerClass }>;
}

export interface PortabilityPlan {
  /** Archived tables (tenant + child), parents first. */
  tables: TablePlan[];
  byName: Map<string, TablePlan>;
  excluded: Record<string, ExcludedTable>;
  global: string[];
  identity: readonly string[];
  /** Every table with tenant scope (archived, excluded tenant/child scopes), for delete and counts. */
  scoped: string[];
  live: LiveSchema;
  bucketOf: Map<string, Bucket>;
  /** Delete-side-effect targets (rule 8): must be deleted after their source tables. */
  sideEffectEdges: Array<{ source: string; target: string }>;
  /** Nullable FK edges removed to make the insert order acyclic. */
  deferredFks: Array<{ table: string; columns: string[]; refTable: string }>;
  /** `table.column` -> rule, for every redacted column. */
  redactedColumns: Record<string, string>;
}

/** The scope predicate for a table, with `$1` the tenant id and `alias` the table alias. */
export function scopeSql(plan: PortabilityPlan, table: string, alias: string, depth = 0): string {
  const live = plan.live.tables.get(table);
  if (!live) throw new PortabilityPlanError('UNKNOWN_TABLE', table);
  if (live.columns.some((c) => c.name === 'tenant_id')) return `${alias}."tenant_id" = $1`;
  const child = CHILD_TABLES[table];
  if (!child) throw new PortabilityPlanError('NO_SCOPE', `${table} has neither tenant_id nor a CHILD_TABLES entry`);
  const p = `p${depth + 1}`;
  return `${alias}."${child.column}" IN (SELECT ${p}."id" FROM "${child.parent}" ${p} WHERE ${scopeSql(plan, child.parent, p, depth + 1)})`;
}

function key(table: string, column: string): string {
  return `${table}.${column}`;
}

function findFamily(prefix: string): boolean {
  return DESKTOP_UNMOUNTED.some((f) => f.prefix === prefix);
}

function isNumericType(t: string): boolean {
  return /^(numeric|decimal)/.test(t);
}

function topoOrder(tables: string[], edges: Array<{ child: string; parent: string }>): { order: string[]; cyclic: string[] } {
  const inSet = new Set(tables);
  const deps = new Map<string, Set<string>>();
  const kids = new Map<string, Set<string>>();
  for (const t of tables) deps.set(t, new Set());
  for (const e of edges) {
    if (!inSet.has(e.child) || !inSet.has(e.parent) || e.child === e.parent) continue;
    deps.get(e.child)!.add(e.parent);
    if (!kids.has(e.parent)) kids.set(e.parent, new Set());
    kids.get(e.parent)!.add(e.child);
  }
  const order: string[] = [];
  let ready = tables.filter((t) => deps.get(t)!.size === 0).sort();
  const done = new Set<string>();
  while (ready.length > 0) {
    const next = ready.shift()!;
    order.push(next);
    done.add(next);
    const fresh: string[] = [];
    for (const c of kids.get(next) ?? []) {
      const d = deps.get(c)!;
      d.delete(next);
      if (d.size === 0 && !done.has(c)) fresh.push(c);
    }
    if (fresh.length > 0) ready = [...ready, ...fresh].sort();
  }
  return { order, cyclic: tables.filter((t) => !done.has(t)).sort() };
}

/**
 * Build the plan from the live schema. Throws PortabilityPlanError on any
 * unclassified or stale object (fail closed).
 */
export async function buildPortabilityPlan(dbi: DbLike = db): Promise<PortabilityPlan> {
  const live = await readLiveSchema(dbi);
  const all = [...live.tables.keys()].sort();
  // Classification problems are collected so one run reports every
  // unclassified object; the first one gives the error code.
  const problems: Array<{ code: string; message: string }> = [];
  const fail = (code: string, message: string): void => {
    problems.push({ code, message });
  };
  const flush = (): void => {
    if (problems.length === 0) return;
    const first = problems[0]!;
    throw new PortabilityPlanError(first.code, problems.map((p) => `${p.code}: ${p.message}`).join('; '), { problems });
  };
  const liveSet = new Set(all);
  const has = (t: string, c: string) => live.tables.get(t)?.columns.some((x) => x.name === c) ?? false;
  const col = (t: string, c: string) => live.tables.get(t)?.columns.find((x) => x.name === c);

  // Rule 0: exactly one bucket per table.
  const bucketOf = new Map<string, Bucket>();
  const multi: string[] = [];
  const identitySet = new Set<string>(IDENTITY_TABLES);
  for (const t of all) {
    const buckets: Bucket[] = [];
    if (identitySet.has(t)) buckets.push('identity');
    if (t in GLOBAL_TABLES) buckets.push('global');
    if (t in EXCLUDED_TENANT_ARCHIVE_TABLES) buckets.push('excluded');
    if (buckets.length === 0) {
      if (has(t, 'tenant_id')) buckets.push('tenant');
      else if (t in CHILD_TABLES) buckets.push('child');
    }
    if (buckets.length > 1) multi.push(`${t} (${buckets.join(', ')})`);
    if (buckets.length === 1) bucketOf.set(t, buckets[0]!);
  }
  const unclassified = all.filter((t) => !bucketOf.has(t) && !multi.some((m) => m.startsWith(`${t} `)));
  if (unclassified.length > 0 || multi.length > 0) {
    throw new PortabilityPlanError('UNCLASSIFIED_TABLE', `no bucket: [${unclassified.join(', ')}]; several buckets: [${multi.join('; ')}]`, { unclassified, multi });
  }
  // Stale entries.
  const stale = [
    ...Object.keys(GLOBAL_TABLES), ...Object.keys(EXCLUDED_TENANT_ARCHIVE_TABLES), ...Object.keys(CHILD_TABLES),
  ].filter((t) => !liveSet.has(t));
  if (stale.length > 0) throw new PortabilityPlanError('STALE_ENTRY', `tables no longer live: ${stale.join(', ')}`, { stale });
  for (const [t, v] of Object.entries(CHILD_TABLES)) {
    if (!has(t, v.column)) throw new PortabilityPlanError('STALE_ENTRY', `CHILD_TABLES ${t}.${v.column} is not a live column`);
    if (has(t, 'tenant_id')) throw new PortabilityPlanError('INVALID_CHILD', `${t} has tenant_id and a CHILD_TABLES entry`);
    const pb = bucketOf.get(v.parent);
    const parentOk = pb === 'tenant' || pb === 'child' || (pb === 'excluded' && (has(v.parent, 'tenant_id') || v.parent in CHILD_TABLES));
    if (!parentOk || live.tables.get(v.parent)?.pkColumns.join() !== 'id') {
      throw new PortabilityPlanError('INVALID_CHILD', `${t} -> ${v.parent}: the parent must be a tenant-scoped table with a uuid pk "id"`);
    }
  }
  // Child chains must terminate (no cycles).
  for (const t of Object.keys(CHILD_TABLES)) {
    const seen = new Set<string>();
    let cur: string | undefined = t;
    while (cur && cur in CHILD_TABLES) {
      if (seen.has(cur)) throw new PortabilityPlanError('INVALID_CHILD', `CHILD_TABLES cycle at ${cur}`);
      seen.add(cur);
      cur = CHILD_TABLES[cur]!.parent;
    }
  }

  // Rule 1: exclusion categories.
  const byCategory = new Map<ExcludedCategory, string[]>();
  for (const [t, e] of Object.entries(EXCLUDED_TENANT_ARCHIVE_TABLES)) {
    if (!EXCLUDED_CATEGORIES.includes(e.category)) fail('INVALID_EXCLUSION', `${t}: unknown category ${e.category}`);
    byCategory.set(e.category, [...(byCategory.get(e.category) ?? []), t]);
    const lt = live.tables.get(t)!;
    const names = lt.columns.map((c) => c.name);
    const numeric = lt.columns.filter((c) => isNumericType(c.type)).map((c) => c.name);
    // Scope.
    if (e.scope === 'tenant' && !has(t, 'tenant_id')) fail('INVALID_EXCLUSION', `${t}: scope tenant but no tenant_id column`);
    if (e.scope.startsWith('child-of:')) {
      const parent = e.scope.slice('child-of:'.length);
      if (CHILD_TABLES[t]?.parent !== parent) fail('INVALID_EXCLUSION', `${t}: scope ${e.scope} needs a matching CHILD_TABLES entry`);
    }
    if (e.scope === 'none') {
      if (t in CHILD_TABLES) fail('INVALID_EXCLUSION', `${t}: scope none but listed in CHILD_TABLES`);
      if (has(t, 'tenant_id') && !(key(t, 'tenant_id') in CROSS_TENANT_COLUMNS)) {
        fail('INVALID_EXCLUSION', `${t}: scope none with a tenant_id column needs a CROSS_TENANT_COLUMNS entry`);
      }
    }
    // Category evidence.
    switch (e.category) {
      case 'secret':
        if (!names.some((n) => SECRET_COLUMN_RE.test(n))) fail('INVALID_EXCLUSION', `${t}: category secret but no secret-pattern column`);
        break;
      case 'session-token':
        if (!names.some((n) => /(expires|expiry|token|code_hash|fingerprint_hash)/i.test(n))) {
          fail('INVALID_EXCLUSION', `${t}: category session-token needs an expiry or token/code-hash column`);
        }
        break;
      case 'server-feature': {
        const evidence = [e.family !== undefined, e.firmKeyed === true, e.cascadeOf !== undefined].filter(Boolean).length;
        if (evidence !== 1) fail('INVALID_EXCLUSION', `${t}: server-feature needs exactly one of family, firmKeyed, cascadeOf`);
        if (e.family !== undefined && !findFamily(e.family)) fail('INVALID_EXCLUSION', `${t}: family ${e.family} is not a DESKTOP_UNMOUNTED prefix`);
        if (e.firmKeyed) {
          const f = col(t, 'firm_id');
          if (!f || f.nullable) fail('INVALID_EXCLUSION', `${t}: firmKeyed needs a NOT NULL firm_id column`);
        }
        if (e.cascadeOf !== undefined) {
          const target = e.cascadeOf;
          if (!(target in EXCLUDED_TENANT_ARCHIVE_TABLES)) fail('INVALID_EXCLUSION', `${t}: cascadeOf ${target} is not excluded`);
          const fk = live.fks.find((f) => f.table === t && f.refTable === target && f.columns.every((c) => !col(t, c)!.nullable));
          if (!fk) fail('INVALID_EXCLUSION', `${t}: cascadeOf ${target} needs a NOT NULL FK into it`);
        }
        break;
      }
      default:
        break;
    }
    if (e.category !== 'derived' && e.category !== 'server-feature' && numeric.length > 0) {
      fail('INVALID_EXCLUSION', `${t}: excluded as ${e.category} but has numeric columns ${numeric.join(', ')}`);
    }
  }
  if ((byCategory.get('derived') ?? []).join() !== 'gl_version_stamps') fail('INVALID_EXCLUSION', 'derived must be exactly {gl_version_stamps}');
  if ((byCategory.get('provenance') ?? []).join() !== 'tenant_archive_imports') fail('INVALID_EXCLUSION', 'provenance must be exactly {tenant_archive_imports}');

  const archived = all.filter((t) => bucketOf.get(t) === 'tenant' || bucketOf.get(t) === 'child');
  const archivedSet = new Set(archived);
  const remappedTables = new Set([...archived, 'tenants', 'users', 'user_tenant_access']);

  // FK order and R6 (no cycles, known self references, nothing deferrable).
  const deferrable = live.fks.filter((f) => f.deferrable).map((f) => `${f.table}.${f.name}`);
  if (deferrable.length > 0) throw new PortabilityPlanError('DEFERRABLE_CONSTRAINT', deferrable.join(', '), { deferrable });
  const selfRefs = live.fks.filter((f) => f.table === f.refTable).map((f) => `${f.table}.${f.columns.join('+')}`);
  const unknownSelf = selfRefs.filter((s) => !KNOWN_SELF_REFERENCES.includes(s));
  if (unknownSelf.length > 0) throw new PortabilityPlanError('UNKNOWN_SELF_REFERENCE', unknownSelf.join(', '), { unknownSelf });
  const edges = [
    ...live.fks.map((f) => ({ child: f.table, parent: f.refTable })),
    ...Object.entries(CHILD_TABLES).map(([t, v]) => ({ child: t, parent: v.parent })),
  ];
  // FK cycles are tolerated only when an edge of the cycle has nullable
  // columns: that edge is "deferred" (the import inserts NULL, then updates
  // the column after every table is in), and the remaining graph must be
  // acyclic (R6). A cycle of NOT NULL edges fails closed.
  const deferredFks: LiveFk[] = [];
  let orderEdges = edges;
  for (;;) {
    const r = topoOrder(all, orderEdges);
    if (r.cyclic.length === 0) break;
    const cyclicSet = new Set(r.cyclic);
    const candidate = live.fks
      .filter((f) => cyclicSet.has(f.table) && cyclicSet.has(f.refTable) && f.table !== f.refTable
        && !deferredFks.includes(f) && f.columns.every((c) => col(f.table, c)!.nullable))
      .sort((x, y) => `${x.table}.${x.name}`.localeCompare(`${y.table}.${y.name}`))[0];
    if (!candidate) throw new PortabilityPlanError('FK_CYCLE', r.cyclic.join(', '), { cyclic: r.cyclic });
    deferredFks.push(candidate);
    orderEdges = orderEdges.filter((e) => !(e.child === candidate.table && e.parent === candidate.refTable));
  }
  // Soft references (tenant-ref) order referrers after their targets when
  // that keeps the graph acyclic (journal_lines after transactions, so the
  // 0144 stamp triggers see the transaction rows on import); cyclic hints
  // (transactions <-> recurring_schedules) are dropped deterministically.
  let hintEdges = orderEdges;
  const softEdges = Object.entries(SOFT_REFS)
    .filter(([, v]) => v.startsWith('tenant-ref:'))
    .map(([k, v]) => ({ child: k.split('.')[0]!, parent: v.slice('tenant-ref:'.length) }))
    .filter((e) => e.child !== e.parent && archivedSet.has(e.child) && archivedSet.has(e.parent))
    .sort((x, y) => `${x.child}>${x.parent}`.localeCompare(`${y.child}>${y.parent}`));
  for (const e of softEdges) {
    if (hintEdges.some((h) => h.child === e.child && h.parent === e.parent)) continue;
    const trial = [...hintEdges, e];
    if (topoOrder(archived, trial).cyclic.length === 0) hintEdges = trial;
  }
  const order = topoOrder(archived, hintEdges).order;

  // Rule 2: pk shapes (R5).
  const fkRefCount = new Map<string, number>();
  for (const f of live.fks) fkRefCount.set(f.refTable, (fkRefCount.get(f.refTable) ?? 0) + 1);
  const pkShape = (t: string): { pk: PkShape; pkColumn: string | null } => {
    const lt = live.tables.get(t)!;
    if (lt.pkColumns.length === 1) {
      const c = col(t, lt.pkColumns[0]!)!;
      if (c.type === 'uuid') return { pk: 'uuid', pkColumn: c.name };
      if (/^(bigint|integer|smallint)$/.test(c.type)) {
        if ((fkRefCount.get(t) ?? 0) > 0) throw new PortabilityPlanError('UNCLASSIFIED_PK', `${t}.${c.name}: referenced integer primary key (R5)`);
        return { pk: 'omit-pk', pkColumn: c.name };
      }
      throw new PortabilityPlanError('UNCLASSIFIED_PK', `${t}.${c.name}: primary key of type ${c.type}`);
    }
    return { pk: 'no-pk', pkColumn: null };
  };

  // Rule 8: triggers.
  const triggerKeys = new Set(live.triggers.map((g) => key(g.table, g.name)));
  const staleTriggers = Object.keys(TRIGGERS).filter((k) => !triggerKeys.has(k));
  if (staleTriggers.length > 0) throw new PortabilityPlanError('STALE_ENTRY', `triggers: ${staleTriggers.join(', ')}`);
  const sideEffectEdges: Array<{ source: string; target: string }> = [];
  for (const g of live.triggers) {
    const cls = TRIGGERS[key(g.table, g.name)];
    const writes = /\b(insert\s+into|update\s+[a-z_"]+\s+set)\b/i.test(g.functionBody);
    if (!cls) {
      const hint = g.timing === 'AFTER' && g.events.includes('DELETE') && writes
        ? ' (an AFTER DELETE trigger that writes another table: classify as delete-side-effect:<table>)' : '';
      fail('UNCLASSIFIED_TRIGGER', `${key(g.table, g.name)}${hint}`);
      continue;
    }
    if (g.timing === 'AFTER' && g.events.includes('DELETE') && writes && !cls.startsWith('delete-side-effect:')) {
      throw new PortabilityPlanError('UNCLASSIFIED_TRIGGER', `${key(g.table, g.name)}: AFTER DELETE trigger writes to another table; classify as delete-side-effect:<table>`);
    }
    if (cls.startsWith('delete-side-effect:')) {
      const target = cls.slice('delete-side-effect:'.length);
      if (!liveSet.has(target) || !new RegExp(`\\b${target}\\b`).test(g.functionBody)) {
        fail('INVALID_TRIGGER', `${key(g.table, g.name)}: body does not write ${target}`);
      }
      sideEffectEdges.push({ source: g.table, target });
    }
    if (cls === 'insert-safe' && g.events.includes('INSERT')) fail('INVALID_TRIGGER', `${key(g.table, g.name)}: insert-safe but fires on INSERT`);
  }

  // Rule 5b, S-g, CROSS_TENANT, TYPE_CHANGES validations that span tables.
  for (const [k, v] of Object.entries(TYPE_CHANGES)) {
    if (!isAllowedWidening(v.from, v.to)) fail('INVALID_TYPE_CHANGE', `${k}: ${v.from} -> ${v.to} is not in the closed widening set`);
  }
  for (const k of Object.keys(VOLATILE_COLUMNS)) {
    const [t, c] = k.split('.') as [string, string];
    const lc = col(t, c);
    if (!lc) throw new PortabilityPlanError('STALE_ENTRY', `VOLATILE_COLUMNS ${k}`);
    const isTs = /^timestamp/.test(lc.type);
    const isCache = /(_cache_|^local_cache_path$)/.test(c);
    const isLabel = /^(character varying|text)/.test(lc.type) && /^(name|slug|label|display_name|title)$/.test(c);
    if (!(isTs || isCache || isLabel) || /^(numeric|date$|boolean|uuid)/.test(lc.type) || /status|state/.test(c)) {
      fail('INVALID_VOLATILE', `${k} (${lc.type}) violates the volatile-column shape rule`);
    }
    if (!VOLATILE_COLUMNS[k]!.producedBy) fail('INVALID_VOLATILE', `${k}: no producing case`);
  }
  for (const k of Object.keys(CROSS_TENANT_COLUMNS)) {
    const [t, c] = k.split('.') as [string, string];
    if (!col(t, c)) throw new PortabilityPlanError('STALE_ENTRY', `CROSS_TENANT_COLUMNS ${k}`);
    if (CROSS_TENANT_COLUMNS[k] === 'set-null' && !col(t, c)!.nullable) fail('INVALID_CROSS_TENANT', `${k}: set-null on a NOT NULL column`);
  }
  // Every tenant-pointing column outside the tenant's own scope must be listed.
  for (const t of all) {
    const b = bucketOf.get(t)!;
    const lt = live.tables.get(t)!;
    for (const c of lt.columns) {
      const fkToTenants = live.fks.some((f) => f.table === t && f.refTable === 'tenants' && f.columns.includes(c.name));
      const named = c.name === 'tenant_id' || /(^|_)tenant_id$/.test(c.name);
      if (!fkToTenants && !named) continue;
      if (c.name === 'tenant_id' && (b === 'tenant' || b === 'identity' || (b === 'excluded' && EXCLUDED_TENANT_ARCHIVE_TABLES[t]!.scope === 'tenant'))) continue;
      if (c.type.endsWith('[]')) continue; // uuid[] tenant sets live in excluded firm tables
      if (!(key(t, c.name) in CROSS_TENANT_COLUMNS)) {
        throw new PortabilityPlanError('UNCLASSIFIED_CROSS_TENANT', `${key(t, c.name)} points at a tenant from outside its scope; add it to CROSS_TENANT_COLUMNS`);
      }
    }
  }

  // Per-table classification of archived (+ identity for columns rules).
  const classifiedTables = [...archived, ...IDENTITY_TABLES];
  const classifiedSet = new Set(classifiedTables);
  const staleKeys = (name: string, obj: Record<string, unknown>, check: (t: string, c: string) => boolean) => {
    const s = Object.keys(obj).filter((k) => {
      const [t, c] = k.split('.') as [string, string];
      return !col(t, c) || !check(t, c);
    });
    if (s.length > 0) throw new PortabilityPlanError('STALE_ENTRY', `${name}: ${s.join(', ')}`);
  };
  staleKeys('SOFT_REFS', SOFT_REFS, (t) => classifiedSet.has(t));
  staleKeys('SECRET_COLUMNS', SECRET_COLUMNS, (t, c) => classifiedSet.has(t) && SECRET_COLUMN_RE.test(c));
  staleKeys('JSON_CONFIG_COLUMNS', JSON_CONFIG_COLUMNS, (t, c) => classifiedSet.has(t) && JSON_CONFIG_RE.test(c) && /json/.test(col(t, c)!.type));
  staleKeys('STRIPPED_JSON_COLUMNS', STRIPPED_JSON_COLUMNS, (t, c) => archivedSet.has(t) && /json/.test(col(t, c)!.type));
  staleKeys('FILE_COLUMNS', FILE_COLUMNS, (t) => classifiedSet.has(t));
  staleKeys('UNIQUE_INDEX_RULES', UNIQUE_INDEX_RULES, (t) => classifiedSet.has(t));
  staleKeys('GLOBAL_FK_RULES', GLOBAL_FK_RULES, (t) => archivedSet.has(t));
  for (const [t, nk] of Object.entries(NATURAL_KEYS)) {
    if (!liveSet.has(t) || nk.columns.some((c) => !col(t, c))) throw new PortabilityPlanError('STALE_ENTRY', `NATURAL_KEYS ${t}`);
  }
  for (const [k, v] of Object.entries(SOFT_REFS)) {
    const target = v.includes(':') ? v.slice(v.indexOf(':') + 1) : null;
    if (v.startsWith('tenant-ref:') && !archivedSet.has(target!)) fail('INVALID_SOFT_REF', `${k}: ${v} does not name an archived table`);
    if (v.startsWith('mixed-ref:') && !(archivedSet.has(target!) && col(target!, 'tenant_id')?.nullable && target! in NATURAL_KEYS)) {
      fail('INVALID_SOFT_REF', `${k}: ${v} needs an archived table with nullable tenant_id and a NATURAL_KEYS entry`);
    }
    if (v.startsWith('global-ref:') && target !== 'null' && !(target! in GLOBAL_TABLES && target! in NATURAL_KEYS)) {
      fail('INVALID_SOFT_REF', `${k}: ${v} needs a global table with a NATURAL_KEYS entry`);
    }
    if (v.startsWith('excluded-ref:')) {
      const [t, c] = k.split('.') as [string, string];
      if (!(target! in EXCLUDED_TENANT_ARCHIVE_TABLES)) fail('INVALID_SOFT_REF', `${k}: ${target} is not excluded`);
      if (!col(t, c)!.nullable) fail('INVALID_SOFT_REF', `${k}: NOT NULL reference into excluded ${target} (rule 4c: exclude the table)`);
    }
  }

  const tables: TablePlan[] = [];
  const redactedColumns: Record<string, string> = {};
  const planFor = (t: string): TablePlan => {
    const lt = live.tables.get(t)!;
    const bucket = bucketOf.get(t) as 'tenant' | 'child';
    const { pk, pkColumn } = pkShape(t);
    const columns = lt.columns.filter((c) => !c.generated);
    const fkCols = new Map<string, LiveFk>();
    for (const f of live.fks) if (f.table === t) for (const c of f.columns) fkCols.set(c, f);

    const softRefs: TablePlan['softRefs'] = [];
    const globalFks: TablePlan['globalFks'] = [];
    const nulledReferences: TablePlan['nulledReferences'] = [];
    const nullOnImport: string[] = [];
    const regenerate: string[] = [];
    const reencryptColumns: string[] = [];
    const fileColumns: TablePlan['fileColumns'] = [];
    const nulledOnExport = new Map<string, string>(); // column -> reason/target

    for (const c of columns) {
      const k = key(t, c.name);
      const fk = fkCols.get(c.name);
      const isUuid = /^uuid(\[\])?$/.test(c.type);
      if (fk) {
        const rb = bucketOf.get(fk.refTable);
        if (rb === 'global') {
          const strategy = GLOBAL_FK_RULES[k];
          if (!strategy) fail('UNCLASSIFIED_GLOBAL_FK', `${k} -> ${fk.refTable}`);
          else {
            if (strategy === 'map-by-natural-key' && !(fk.refTable in NATURAL_KEYS)) fail('INVALID_GLOBAL_FK', `${k}: ${fk.refTable} has no NATURAL_KEYS entry`);
            globalFks.push({ column: c.name, refTable: fk.refTable, refColumn: fk.refColumns[fk.columns.indexOf(c.name)]!, strategy, nullable: c.nullable });
          }
        } else if (rb === 'excluded') {
          if (!c.nullable) fail('UNCLASSIFIED_EXCLUDED_REF', `${k}: NOT NULL FK into excluded ${fk.refTable} (rule 4c: exclude ${t} too)`);
          nulledOnExport.set(c.name, fk.refTable);
          nulledReferences.push({ column: c.name, target: fk.refTable });
        } else if (rb === 'identity' && fk.refTable === 'users') {
          softRefs.push({ column: c.name, cls: 'identity', isArray: false });
        }
      } else if (isUuid && c.name !== 'tenant_id' && !lt.pkColumns.includes(c.name) && !(lt.pkColumns.length > 1 && lt.pkColumns.includes(c.name))) {
        const cls = SOFT_REFS[k];
        if (!cls) fail('UNCLASSIFIED_SOFT_REF', k);
        else softRefs.push({ column: c.name, cls, isArray: c.type.endsWith('[]') });
        if (cls && (cls.startsWith('excluded-ref:') || cls === 'global-ref:null')) {
          const target = cls.slice(cls.indexOf(':') + 1);
          nulledOnExport.set(c.name, target);
          nulledReferences.push({ column: c.name, target });
        }
      } else if (isUuid && lt.pkColumns.length > 1 && lt.pkColumns.includes(c.name) && !fk) {
        // Composite pk of uuid columns: each part must still be classified.
        const cls = SOFT_REFS[k];
        if (!cls && c.name !== 'tenant_id') fail('UNCLASSIFIED_SOFT_REF', k);
        if (cls) softRefs.push({ column: c.name, cls, isArray: false });
      }
      if (SECRET_COLUMN_RE.test(c.name) && !SECRET_COLUMNS[k]) fail('UNCLASSIFIED_SECRET', k);
      if (/json/.test(c.type) && JSON_CONFIG_RE.test(c.name) && !JSON_CONFIG_COLUMNS[k]) fail('UNCLASSIFIED_JSON_CONFIG', k);
      if (/json/.test(c.type) && STRIPPED_JSON_RE.test(c.name) && !STRIPPED_JSON_COLUMNS[k]) fail('UNCLASSIFIED_JSON_PAYLOAD', k);
      if (STRIPPED_JSON_COLUMNS[k]) {
        if (!/json/.test(c.type)) fail('INVALID_SECRET_RULE', `${k}: stripped column must be json/jsonb`);
        redactedColumns[k] = STRIPPED_JSON_COLUMNS[k]!;
      }
      if (FILE_COLUMN_RE.test(c.name) && !FILE_COLUMNS[k]) fail('UNCLASSIFIED_FILE_COLUMN', k);
      const fr = FILE_COLUMNS[k];
      if (fr) {
        if (fr.resolver === 'null') { if (!c.nullable) fail('INVALID_FILE_COLUMN', `${k}: null resolver on NOT NULL column`); nullOnImport.push(c.name); }
        if (fr.resolver !== 'not-a-file' && fr.resolver !== 'external' && fr.resolver !== 'null') fileColumns.push({ column: c.name, rule: fr });
        if (fr.resolver === 'provider-path-mirror' && !FILE_COLUMNS[key(t, fr.mirrorOf ?? '')]) fail('INVALID_FILE_COLUMN', `${k}: mirrorOf must name a provider-key column`);
      }
      const uq = UNIQUE_INDEX_RULES[k];
      if (uq === 'null') { if (!c.nullable) fail('INVALID_UNIQUE_RULE', `${k}: null on NOT NULL`); nullOnImport.push(c.name); }
      if (uq === 'regenerate' || uq === 'force-false') regenerate.push(c.name);
      const sec = SECRET_COLUMNS[k];
      if (sec?.action === 'redact') {
        if (!c.nullable && !c.hasDefault && !sec.replacement) fail('INVALID_SECRET_RULE', `${k}: redact needs a replacement on a NOT NULL column without default`);
        redactedColumns[k] = sec.reason;
      }
      if (sec?.action === 'reencrypt') {
        if (!c.nullable || !/^(text|character varying)/.test(c.type)) fail('INVALID_SECRET_RULE', `${k}: reencrypt needs a nullable text column`);
        reencryptColumns.push(c.name);
      }
      const jc = JSON_CONFIG_COLUMNS[k];
      if (jc === 'secret') {
        if (!c.nullable && !c.hasDefault) fail('INVALID_SECRET_RULE', `${k}: secret jsonb must be nullable or defaulted`);
        redactedColumns[k] = 'secret configuration';
      }
    }

    // Rule 3: unique indexes.
    const remappedCols = new Set<string>(['tenant_id']);
    if (pkColumn && pk === 'uuid') remappedCols.add(pkColumn);
    for (const [c, f] of fkCols) if (remappedTables.has(f.refTable)) remappedCols.add(c);
    for (const s of softRefs) if (s.cls.startsWith('tenant-ref:') || s.cls === 'identity' || s.cls.startsWith('mixed-ref:') || s.cls === 'polymorphic') remappedCols.add(s.column);
    if (CHILD_TABLES[t]) remappedCols.add(CHILD_TABLES[t]!.column);
    for (const u of live.uniques.filter((u) => u.table === t)) {
      const cols = [...u.columns, ...u.expressionColumns];
      if (cols.some((c) => remappedCols.has(c))) continue;
      const ruled = cols.length === 1 && UNIQUE_INDEX_RULES[key(t, cols[0]!)];
      if (!ruled) fail('UNCLASSIFIED_UNIQUE', `${t}.${u.name} (${u.definition})`);
    }

    // Projections.
    const archive: ArchiveColumn[] = columns.map((c) => {
      const k = key(t, c.name);
      const sec = SECRET_COLUMNS[k];
      const jc = JSON_CONFIG_COLUMNS[k];
      const nulledTarget = nulledOnExport.get(c.name) ?? null;
      let select = `a."${c.name}"`;
      let redacted = false;
      if (sec?.action === 'redact') {
        select = `${sec.replacement ?? 'NULL'}::${c.type} AS "${c.name}"`;
        redacted = true;
      } else if (jc === 'secret') {
        select = `NULL::${c.type} AS "${c.name}"`;
        redacted = true;
      } else if (nulledTarget) {
        select = `NULL::${c.type} AS "${c.name}"`;
      } else if (STRIPPED_JSON_COLUMNS[k]) {
        select = stripSecretKeysSql(c.name, c.type);
      }
      return { name: c.name, type: c.type, select, redacted, nulledReference: nulledTarget };
    });
    const dropFromCanonical = new Set([...regenerate, ...nullOnImport, ...reencryptColumns, ...fileColumns.map((f) => f.column)]);
    if (pk === 'omit-pk' && pkColumn) dropFromCanonical.add(pkColumn);
    const canonical = archive.map((c) => c.name).filter((n) => !dropFromCanonical.has(n));
    const fingerprint = columns.map((c) => c.name).filter((n) => !(key(t, n) in VOLATILE_COLUMNS));
    const insert = archive.map((c) => c.name).filter((n) => !(pk === 'omit-pk' && n === pkColumn));
    const deferredColumns = deferredFks.filter((f) => f.table === t).flatMap((f) => f.columns);
    return {
      name: t, bucket, pk, pkColumn, columns, archive, canonical, fingerprint, insert, regenerate, nullOnImport,
      deferredColumns, reencryptColumns, fileColumns, softRefs, globalFks, nulledReferences,
      triggers: live.triggers.filter((g) => g.table === t).map((g) => ({ name: g.name, cls: TRIGGERS[key(t, g.name)]! })),
    };
  };
  for (const t of order) tables.push(planFor(t));
  flush();

  // Identity tables: classify their columns too (secret, json, file, soft refs) so canaries fail closed.
  for (const t of IDENTITY_TABLES) {
    const lt = live.tables.get(t)!;
    for (const c of lt.columns) {
      const k = key(t, c.name);
      if (SECRET_COLUMN_RE.test(c.name) && !SECRET_COLUMNS[k]) fail('UNCLASSIFIED_SECRET', k);
      if (/json/.test(c.type) && JSON_CONFIG_RE.test(c.name) && !JSON_CONFIG_COLUMNS[k]) fail('UNCLASSIFIED_JSON_CONFIG', k);
      if (FILE_COLUMN_RE.test(c.name) && !FILE_COLUMNS[k]) fail('UNCLASSIFIED_FILE_COLUMN', k);
      const isUuid = /^uuid(\[\])?$/.test(c.type);
      const fk = live.fks.find((f) => f.table === t && f.columns.includes(c.name));
      if (isUuid && !fk && c.name !== 'id' && c.name !== 'tenant_id' && !SOFT_REFS[k]) fail('UNCLASSIFIED_SOFT_REF', k);
      if (t === 'tenants' && SECRET_COLUMNS[k]?.action === 'redact') redactedColumns[k] = SECRET_COLUMNS[k]!.reason;
    }
    for (const u of live.uniques.filter((u) => u.table === t)) {
      if (t !== 'tenants') continue; // users / user_tenant_access follow the identity rules
      const cols = [...u.columns, ...u.expressionColumns];
      if (!(cols.length === 1 && UNIQUE_INDEX_RULES[key(t, cols[0]!)])) fail('UNCLASSIFIED_UNIQUE', `${t}.${u.name}`);
    }
  }

  flush();

  const scoped = all.filter((t) => {
    const b = bucketOf.get(t);
    if (b === 'tenant' || b === 'child') return true;
    if (b === 'excluded') return EXCLUDED_TENANT_ARCHIVE_TABLES[t]!.scope !== 'none';
    return false;
  });

  return {
    tables,
    byName: new Map(tables.map((t) => [t.name, t])),
    excluded: EXCLUDED_TENANT_ARCHIVE_TABLES,
    global: all.filter((t) => bucketOf.get(t) === 'global'),
    identity: IDENTITY_TABLES,
    scoped,
    live,
    bucketOf,
    sideEffectEdges,
    deferredFks: deferredFks.map((f) => ({ table: f.table, columns: f.columns, refTable: f.refTable })),
    redactedColumns,
  };
}

let cachedPlan: Promise<PortabilityPlan> | null = null;

/** The plan for the default connection, built once per process. */
export function getPortabilityPlan(): Promise<PortabilityPlan> {
  if (!cachedPlan) {
    cachedPlan = buildPortabilityPlan(db).catch((err) => {
      cachedPlan = null;
      throw err;
    });
  }
  return cachedPlan;
}

export function _resetPortabilityPlanForTests(): void {
  cachedPlan = null;
}
